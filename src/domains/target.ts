/**
 * CDP Target Domain — manage browser targets (tabs, service workers, iframes).
 * Useful for switching CDP session to extension contexts.
 */

import { z } from "zod";
import { send, getBrowser, resetSession } from "../cdp-client.js";

// ── Schema ───────────────────────────────────

export const targetSchema = z.object({
  action: z.enum([
    "list",      // List all targets
    "select",    // Switch CDP session to a target
    "close",     // Close a target
  ]),
  targetId: z.string().optional().describe("Target ID (required for select/close)"),
  filter: z.string().optional().describe("Filter targets by URL or title (regex)"),
  type: z.string().optional().describe("Filter by type: page, service_worker, iframe, background_page, other"),
});

// ── Handler ──────────────────────────────────

export async function handleTarget(args: z.infer<typeof targetSchema>): Promise<string> {
  switch (args.action) {
    case "list": {
      const result = await send("Target.getTargets");
      let targets: any[] = result.targetInfos || [];

      if (args.type) {
        targets = targets.filter((t: any) => t.type === args.type);
      }
      if (args.filter) {
        const re = new RegExp(args.filter, "i");
        targets = targets.filter((t: any) => re.test(t.url) || re.test(t.title));
      }

      if (targets.length === 0) return "No targets found.";

      const lines = targets.map((t: any) =>
        `[${t.type}] ${t.targetId.substring(0, 12)}... | ${t.title?.substring(0, 40) || "(no title)"} | ${t.url?.substring(0, 80)}`,
      );
      return `Targets (${targets.length}):\n${lines.join("\n")}`;
    }

    case "select": {
      if (!args.targetId) return "ERROR: targetId required";
      await resetSession();
      // The next getCDPSession call will create a new session
      // We need to attach to the specific target
      const b = await getBrowser();
      const pages = await b.pages();
      const page = pages.find(p => {
        // Match by target ID or URL
        return p.url().includes(args.targetId!) || p.target().url().includes(args.targetId!);
      });
      if (page) {
        return `Selected target: ${page.url().substring(0, 80)}`;
      }
      return `Target ${args.targetId} not found or not attachable.`;
    }

    case "close": {
      if (!args.targetId) return "ERROR: targetId required";
      try {
        await send("Target.closeTarget", { targetId: args.targetId });
        return `Target ${args.targetId} closed.`;
      } catch (e: any) {
        return `Failed to close target: ${e.message}`;
      }
    }

    default:
      return `Unknown action: ${args.action}`;
  }
}
