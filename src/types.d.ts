declare module "chrome-remote-interface" {
  interface CDPClient {
    Browser: { getVersion(): Promise<any> };
    close(): Promise<void>;
    send(method: string, params?: any): Promise<any>;
    on(event: string, handler: (...args: any[]) => void): void;
  }

  function CDP(options?: { port?: number; host?: string }): Promise<CDPClient>;

  namespace CDP {
    type Client = CDPClient;
  }

  export = CDP;
}
