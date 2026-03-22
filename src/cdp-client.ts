/**
 * CDP WebSocket client — connects to Chrome's remote debugging port
 * and provides a typed interface for sending CDP commands.
 */

import CDP from "chrome-remote-interface";

let client: CDP.Client | null = null;
let connectionPort = 9222;

export function setPort(port: number) {
  connectionPort = port;
}

export async function getClient(): Promise<CDP.Client> {
  if (client) {
    try {
      // Health check
      await client.Browser.getVersion();
      return client;
    } catch {
      client = null;
    }
  }

  client = await CDP({ port: connectionPort });
  return client;
}

export async function disconnect() {
  if (client) {
    try {
      await client.close();
    } catch {}
    client = null;
  }
}

/**
 * Send a raw CDP command. Used by domain modules.
 */
export async function send(method: string, params?: Record<string, unknown>): Promise<any> {
  const c = await getClient();
  return (c as any).send(method, params);
}

/**
 * Listen for CDP events.
 */
export function on(event: string, handler: (...args: any[]) => void) {
  getClient().then((c) => {
    (c as any).on(event, handler);
  });
}
