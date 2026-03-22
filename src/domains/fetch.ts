/**
 * CDP Fetch Domain — request/response interception at browser engine level.
 * Invisible to page JavaScript.
 */

import { z } from "zod";
import { send, on, resetSession } from "../cdp-client.js";

// ── State ────────────────────────────────────

interface CapturedRequest {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  statusCode?: number;
  responseBody?: string;
  bodySize?: number;
  timestamp: number;
}

interface InterceptRule {
  id: string;
  urlPattern: string;
  resourceType?: string;
  captureBody: boolean;
}

let enabled = false;
let listenerAttached = false;
const rules: Map<string, InterceptRule> = new Map();
const captured: Map<string, CapturedRequest> = new Map();
const MAX_CAPTURED = 1000;
let ruleCounter = 0;

// ── Internal ─────────────────────────────────

function matchesAnyRule(url: string, resourceType: string): InterceptRule | null {
  for (const rule of rules.values()) {
    try {
      const re = new RegExp(rule.urlPattern.replace(/\*/g, ".*"), "i");
      if (!re.test(url)) continue;
      if (rule.resourceType && rule.resourceType !== resourceType) continue;
      return rule;
    } catch {}
  }
  return null;
}

async function attachListener() {
  if (listenerAttached) return;

  await on("Fetch.requestPaused", async (event: any) => {
    const { requestId, request, responseStatusCode, resourceType } = event;
    const url: string = request.url;
    const method: string = request.method;

    const rule = matchesAnyRule(url, resourceType);

    const entry: CapturedRequest = {
      requestId,
      url,
      method,
      resourceType,
      statusCode: responseStatusCode,
      timestamp: Date.now(),
    };

    // Capture response body if rule requires
    if (rule?.captureBody && responseStatusCode) {
      try {
        const body = await send("Fetch.getResponseBody", { requestId });
        const text = body.base64Encoded
          ? Buffer.from(body.body, "base64").toString("utf-8")
          : body.body;
        entry.responseBody = text;
        entry.bodySize = text.length;
      } catch {}
    }

    // Store
    if (rule) {
      if (captured.size >= MAX_CAPTURED) {
        const oldest = captured.keys().next().value;
        if (oldest) captured.delete(oldest);
      }
      captured.set(requestId, entry);
    }

    // Continue the request (don't block)
    try {
      if (responseStatusCode) {
        await send("Fetch.continueResponse", { requestId });
      } else {
        await send("Fetch.continueRequest", { requestId });
      }
    } catch {}
  });

  listenerAttached = true;
}

// ── Schema ───────────────────────────────────

export const fetchSchema = z.object({
  action: z.enum([
    "enable",
    "disable",
    "addRule",
    "removeRule",
    "listRules",
    "list",
    "getBody",
    "clear",
  ]),
  // enable
  urlPattern: z.string().optional().describe("URL pattern (glob * or regex). For enable/addRule."),
  resourceType: z.string().optional().describe("Resource type: Document, Script, XHR, Fetch, Stylesheet, Image, etc."),
  // addRule
  captureBody: z.boolean().optional().describe("Capture response body (default: true)"),
  // removeRule
  ruleId: z.string().optional().describe("Rule ID to remove"),
  // list
  filter: z.string().optional().describe("Filter captured requests by URL regex"),
  limit: z.number().optional().describe("Max results (default: 50)"),
  // getBody
  requestId: z.string().optional().describe("Request ID for getBody (omit for latest)"),
});

// ── Handler ──────────────────────────────────

export async function handleFetch(args: z.infer<typeof fetchSchema>): Promise<string> {
  switch (args.action) {
    case "enable": {
      // Reset session to bind to current active page
      await resetSession();
      listenerAttached = false;
      await attachListener();
      const patterns = [
        {
          urlPattern: args.urlPattern || "*",
          ...(args.resourceType ? { resourceType: args.resourceType } : {}),
          requestStage: "Response",
        },
      ];
      await send("Fetch.enable", { patterns });
      enabled = true;
      return `Fetch interception enabled.\nPattern: ${args.urlPattern || "*"}\nUse addRule to capture specific responses.`;
    }

    case "disable": {
      try { await send("Fetch.disable"); } catch {}
      enabled = false;
      rules.clear();
      return "Fetch interception disabled. Rules cleared.";
    }

    case "addRule": {
      if (!args.urlPattern) return "ERROR: urlPattern required for addRule";
      const id = `rule-${++ruleCounter}`;
      rules.set(id, {
        id,
        urlPattern: args.urlPattern,
        resourceType: args.resourceType,
        captureBody: args.captureBody !== false,
      });

      // Auto-enable if not already
      if (!enabled) {
        await resetSession();
        listenerAttached = false;
        await attachListener();
        await send("Fetch.enable", {
          patterns: [{ urlPattern: "*", requestStage: "Response" }],
        });
        enabled = true;
      }

      return `Rule added: ${id}\nPattern: ${args.urlPattern}\nCapture body: ${args.captureBody !== false}`;
    }

    case "removeRule": {
      if (!args.ruleId) return "ERROR: ruleId required";
      return rules.delete(args.ruleId)
        ? `Rule ${args.ruleId} removed.`
        : `Rule ${args.ruleId} not found.`;
    }

    case "listRules": {
      if (rules.size === 0) return "No rules. Use addRule to add one.";
      const lines = Array.from(rules.values()).map(
        (r) => `${r.id}: ${r.urlPattern}${r.resourceType ? ` [${r.resourceType}]` : ""} body=${r.captureBody}`,
      );
      return `Rules (${rules.size}):\n${lines.join("\n")}\nIntercepting: ${enabled}`;
    }

    case "list": {
      const limit = args.limit || 50;
      let entries = Array.from(captured.values());
      if (args.filter) {
        const re = new RegExp(args.filter, "i");
        entries = entries.filter((e) => re.test(e.url));
      }
      entries = entries.slice(-limit);
      if (entries.length === 0) {
        return `No captured requests.${enabled ? "" : " Interception not active."}`;
      }
      const lines = entries.map((e) => {
        const body = e.bodySize ? ` ${e.bodySize}b` : "";
        return `${e.requestId} [${e.method}] ${e.statusCode || "?"} ${e.url.substring(0, 150)}${body}`;
      });
      return `Captured (${entries.length}/${captured.size}):\n${lines.join("\n")}`;
    }

    case "getBody": {
      let entry: CapturedRequest | undefined;
      if (args.requestId) {
        entry = captured.get(args.requestId);
      } else {
        // Latest with body
        entry = Array.from(captured.values())
          .filter((e) => e.responseBody)
          .pop();
      }
      if (!entry) return "No matching request found.";
      return `${entry.method} ${entry.url}\nStatus: ${entry.statusCode}\n\n${entry.responseBody?.substring(0, 50000) || "[No body]"}`;
    }

    case "clear": {
      const count = captured.size;
      captured.clear();
      return `Cleared ${count} captured requests.`;
    }

    default:
      return `Unknown action: ${args.action}`;
  }
}
