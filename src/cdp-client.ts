/**
 * CDP client via Puppeteer — connects to Chrome using the same method as chrome-devtools-mcp.
 * Supports autoConnect (DevToolsActivePort) and direct browserUrl.
 */

import puppeteer, { type Browser, type CDPSession } from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let browser: Browser | null = null;
let cdpSession: CDPSession | null = null;
let connectionPort = 9222;
let useAutoConnect = false;
let browserUrl: string | null = null;

export function setPort(port: number) {
  connectionPort = port;
}

export function setAutoConnect(auto: boolean) {
  useAutoConnect = auto;
}

export function setBrowserUrl(url: string) {
  browserUrl = url;
}

/**
 * Read DevToolsActivePort from Chrome's default user data directory.
 */
function readDevToolsActivePort(): { port: number; wsPath: string } | null {
  const platform = process.platform;
  let chromeDir: string;

  if (platform === "darwin") {
    chromeDir = join(homedir(), "Library", "Application Support", "Google", "Chrome");
  } else if (platform === "win32") {
    chromeDir = join(homedir(), "AppData", "Local", "Google", "Chrome", "User Data");
  } else {
    chromeDir = join(homedir(), ".config", "google-chrome");
  }

  try {
    const content = readFileSync(join(chromeDir, "DevToolsActivePort"), "utf-8").trim();
    const lines = content.split("\n");
    if (lines.length >= 2) {
      return { port: parseInt(lines[0], 10), wsPath: lines[1] };
    }
  } catch {}

  return null;
}

async function connectBrowser(): Promise<Browser> {
  if (browserUrl) {
    return puppeteer.connect({ browserURL: browserUrl });
  }

  if (useAutoConnect) {
    const info = readDevToolsActivePort();
    if (info) {
      const wsEndpoint = `ws://127.0.0.1:${info.port}${info.wsPath}`;
      return puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    }
    // Fallback to port-based discovery
  }

  return puppeteer.connect({ browserURL: `http://127.0.0.1:${connectionPort}` });
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;
  browser = await connectBrowser();
  return browser;
}

/**
 * Get a CDP session for a real content page (not chrome:// or devtools://).
 * Refreshes if previous page was closed.
 */
export async function getCDPSession(): Promise<CDPSession> {
  if (cdpSession) return cdpSession;

  const b = await getBrowser();
  const pages = await b.pages();

  // Prefer a non-chrome:// page
  const page = pages.find(p => {
    const url = p.url();
    return !url.startsWith("chrome://") && !url.startsWith("devtools://") && !url.startsWith("chrome-extension://");
  }) ?? pages[0];

  if (!page) throw new Error("No pages open in browser");

  cdpSession = await page.createCDPSession();
  return cdpSession;
}

/**
 * Reset CDP session so next call picks a fresh page.
 */
export async function resetSession() {
  if (cdpSession) {
    try { await cdpSession.detach(); } catch {}
    cdpSession = null;
  }
}

/**
 * Send a raw CDP command via the session.
 */
export async function send(method: string, params?: Record<string, unknown>): Promise<any> {
  const session = await getCDPSession();
  return session.send(method as any, params as any);
}

/**
 * Listen for CDP events on the session.
 */
export async function on(event: string, handler: (...args: any[]) => void) {
  const session = await getCDPSession();
  session.on(event as any, handler);
}

export async function disconnect() {
  if (cdpSession) {
    try { await cdpSession.detach(); } catch {}
    cdpSession = null;
  }
  if (browser) {
    try { browser.disconnect(); } catch {}
    browser = null;
  }
}
