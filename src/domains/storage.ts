/**
 * CDP Storage Domain — Cookie and DOMStorage (localStorage/sessionStorage) management.
 * Supports cross-domain cookie access and real-time storage monitoring.
 */

import { z } from "zod";
import { send, getBrowser } from "../cdp-client.js";

// ── Schema ───────────────────────────────────

export const storageSchema = z.object({
  action: z.enum([
    // Cookie actions
    "getCookies",
    "setCookie",
    "deleteCookie",
    "clearCookies",
    // localStorage/sessionStorage actions
    "getStorageItems",
    "setStorageItem",
    "removeStorageItem",
    "clearStorage",
  ]),

  // Cookie params
  domain: z.string().optional().describe("Cookie domain filter (e.g. '.goofish.com')"),
  name: z.string().optional().describe("Cookie/storage item name"),
  value: z.string().optional().describe("Cookie/storage item value"),
  path: z.string().optional().describe("Cookie path (default: '/')"),
  secure: z.boolean().optional().describe("Secure flag for cookie"),
  httpOnly: z.boolean().optional().describe("HttpOnly flag for cookie"),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("SameSite policy"),
  expires: z.number().optional().describe("Cookie expiry as Unix timestamp (seconds)"),
  url: z.string().optional().describe("URL context for cookie operations"),

  // DOMStorage params
  storageType: z.enum(["localStorage", "sessionStorage"]).optional().describe("Storage type (default: localStorage)"),
  securityOrigin: z.string().optional().describe("Security origin for storage (e.g. https://www.goofish.com)"),

  // Common
  filter: z.string().optional().describe("Filter by name pattern (regex)"),
});

// ── Handler ──────────────────────────────────

export async function handleStorage(args: z.infer<typeof storageSchema>): Promise<string> {
  switch (args.action) {
    // ── getCookies ──
    case "getCookies": {
      const params: any = {};
      if (args.url) {
        params.urls = [args.url];
      }
      const result = await send("Network.getCookies", params);
      let cookies: any[] = result.cookies || [];

      // Filter by domain
      if (args.domain) {
        cookies = cookies.filter((c: any) =>
          c.domain === args.domain || c.domain === `.${args.domain}` || c.domain.endsWith(args.domain),
        );
      }

      // Filter by name pattern
      if (args.filter) {
        const re = new RegExp(args.filter, "i");
        cookies = cookies.filter((c: any) => re.test(c.name));
      }

      if (cookies.length === 0) {
        return `No cookies found.${args.domain ? ` Domain: ${args.domain}` : ""}`;
      }

      const lines = cookies.map((c: any) => {
        const flags = [
          c.secure ? "Secure" : "",
          c.httpOnly ? "HttpOnly" : "",
          c.sameSite !== "None" ? c.sameSite : "",
        ].filter(Boolean).join(",");
        const exp = c.expires > 0
          ? new Date(c.expires * 1000).toISOString().split("T")[0]
          : "Session";
        return `${c.name}=${c.value?.substring(0, 60)}${c.value?.length > 60 ? "..." : ""} | ${c.domain} | ${exp} | ${flags}`;
      });

      return `Cookies (${cookies.length}):\n${lines.join("\n")}`;
    }

    // ── setCookie ──
    case "setCookie": {
      if (!args.name || !args.value) return "ERROR: name and value required";
      if (!args.domain && !args.url) return "ERROR: domain or url required";

      const params: any = {
        name: args.name,
        value: args.value,
        domain: args.domain,
        path: args.path || "/",
      };
      if (args.url) params.url = args.url;
      if (args.secure !== undefined) params.secure = args.secure;
      if (args.httpOnly !== undefined) params.httpOnly = args.httpOnly;
      if (args.sameSite) params.sameSite = args.sameSite;
      if (args.expires) params.expires = args.expires;

      const result = await send("Network.setCookie", params);
      return result.success
        ? `Cookie set: ${args.name}=${args.value?.substring(0, 30)} on ${args.domain || args.url}`
        : "Failed to set cookie.";
    }

    // ── deleteCookie ──
    case "deleteCookie": {
      if (!args.name) return "ERROR: name required";
      const params: any = { name: args.name };
      if (args.domain) params.domain = args.domain;
      if (args.url) params.url = args.url;
      if (args.path) params.path = args.path;

      await send("Network.deleteCookies", params);
      return `Cookie deleted: ${args.name}${args.domain ? ` from ${args.domain}` : ""}`;
    }

    // ── clearCookies ──
    case "clearCookies": {
      await send("Network.clearBrowserCookies");
      return "All browser cookies cleared.";
    }

    // ── getStorageItems ──
    case "getStorageItems": {
      if (!args.securityOrigin) {
        // Get from current page
        const b = await getBrowser();
        const pages = await b.pages();
        const page = pages.find(p => !p.url().startsWith("chrome://")) ?? pages[0];
        if (page) {
          args.securityOrigin = new URL(page.url()).origin;
        } else {
          return "ERROR: securityOrigin required (no active page)";
        }
      }

      const isLocal = (args.storageType || "localStorage") === "localStorage";
      const storageId = {
        securityOrigin: args.securityOrigin,
        isLocalStorage: isLocal,
      };

      await send("DOMStorage.enable");
      const result = await send("DOMStorage.getDOMStorageItems", { storageId });
      let items: [string, string][] = result.entries || [];

      if (args.filter) {
        const re = new RegExp(args.filter, "i");
        items = items.filter(([key]) => re.test(key));
      }

      if (items.length === 0) {
        return `No ${args.storageType || "localStorage"} items. Origin: ${args.securityOrigin}`;
      }

      const lines = items.map(([key, val]) =>
        `${key} = ${val.substring(0, 100)}${val.length > 100 ? "..." : ""} (${val.length}b)`,
      );
      return `${args.storageType || "localStorage"} (${items.length} items, ${args.securityOrigin}):\n${lines.join("\n")}`;
    }

    // ── setStorageItem ──
    case "setStorageItem": {
      if (!args.name || args.value === undefined) return "ERROR: name and value required";
      if (!args.securityOrigin) return "ERROR: securityOrigin required";

      const isLocal = (args.storageType || "localStorage") === "localStorage";
      const storageId = {
        securityOrigin: args.securityOrigin,
        isLocalStorage: isLocal,
      };

      await send("DOMStorage.enable");
      await send("DOMStorage.setDOMStorageItem", {
        storageId,
        key: args.name,
        value: args.value,
      });
      return `Set ${args.storageType || "localStorage"}: ${args.name} = ${args.value.substring(0, 50)}`;
    }

    // ── removeStorageItem ──
    case "removeStorageItem": {
      if (!args.name) return "ERROR: name required";
      if (!args.securityOrigin) return "ERROR: securityOrigin required";

      const isLocal = (args.storageType || "localStorage") === "localStorage";
      const storageId = {
        securityOrigin: args.securityOrigin,
        isLocalStorage: isLocal,
      };

      await send("DOMStorage.enable");
      await send("DOMStorage.removeDOMStorageItem", {
        storageId,
        key: args.name,
      });
      return `Removed ${args.storageType || "localStorage"}: ${args.name}`;
    }

    // ── clearStorage ──
    case "clearStorage": {
      if (!args.securityOrigin) return "ERROR: securityOrigin required";

      const isLocal = (args.storageType || "localStorage") === "localStorage";
      const storageId = {
        securityOrigin: args.securityOrigin,
        isLocalStorage: isLocal,
      };

      await send("DOMStorage.enable");
      await send("DOMStorage.clear", { storageId });
      return `Cleared ${args.storageType || "localStorage"} for ${args.securityOrigin}`;
    }

    default:
      return `Unknown action: ${args.action}`;
  }
}
