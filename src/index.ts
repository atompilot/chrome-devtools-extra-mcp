#!/usr/bin/env node
/**
 * chrome-devtools-extra-mcp
 * Extra CDP domains for chrome-devtools-mcp: Fetch, Storage, Debugger, and more.
 * Connects to Chrome's remote debugging port and exposes MCP tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { setPort, setAutoConnect, setBrowserUrl, disconnect } from "./cdp-client.js";
import { fetchSchema, handleFetch } from "./domains/fetch.js";
import { zodToJsonSchema } from "zod-to-json-schema";

// ── Parse args ───────────────────────────────

const cliArgs = process.argv.slice(2);
let port = 9222;
let autoConnect = false;
for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i];
  if (arg === "--port" && cliArgs[i + 1]) {
    port = parseInt(cliArgs[i + 1], 10);
  } else if (arg?.startsWith("--port=")) {
    port = parseInt(arg.split("=")[1], 10);
  } else if (arg === "--autoConnect") {
    autoConnect = true;
  } else if (arg === "--browserUrl" && cliArgs[i + 1]) {
    setBrowserUrl(cliArgs[i + 1]);
  } else if (arg?.startsWith("--browserUrl=")) {
    setBrowserUrl(arg.split("=")[1]);
  }
}
setPort(port);
setAutoConnect(autoConnect);

// ── Tool registry ────────────────────────────

const tools = {
  fetchIntercept: {
    description:
      "Intercept network requests/responses at CDP Fetch domain (invisible to page JS). " +
      "Actions: enable (start), disable (stop), addRule (capture/modify by URL pattern), " +
      "removeRule, listRules, list (show captured), getBody (response body), clear.",
    inputSchema: zodToJsonSchema(fetchSchema, {
      $refStrategy: "none",
      target: "jsonSchema7",
    }),
    handler: handleFetch,
  },
  // Future domains will be added here:
  // storage: { ... }
  // debugger: { ... }
  // css: { ... }
};

// ── MCP Server ───────────────────────────────

const server = new Server(
  { name: "chrome-devtools-extra-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema as any,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;
  const tool = tools[name as keyof typeof tools];

  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(toolArgs as any);
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ── Start ────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`chrome-devtools-extra-mcp started (CDP port: ${port})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await disconnect();
  process.exit(0);
});
