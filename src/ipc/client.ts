import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { RpcCallError, type RpcResponse, readMessages, writeMessage } from "./protocol.js";

export type NotificationHandler = (method: string, params: unknown) => void;

/** An authenticated connection to the daemon. */
export class IpcClient {
  private nextId = 0;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private notificationHandlers: NotificationHandler[] = [];
  private closeHandlers: (() => void)[] = [];

  private constructor(private readonly socket: Socket) {
    readMessages(
      socket,
      (message) => {
        if ("method" in message) {
          for (const handler of this.notificationHandlers) handler(message.method, message.params);
          return;
        }
        const response = message as RpcResponse;
        const waiter = typeof response.id === "number" ? this.pending.get(response.id) : undefined;
        if (!waiter) return;
        this.pending.delete(response.id as number);
        if (response.error)
          waiter.reject(new RpcCallError(response.error.code, response.error.message));
        else waiter.resolve(response.result);
      },
      () => {},
    );
    socket.on("close", () => {
      for (const waiter of this.pending.values())
        waiter.reject(new Error("Lost the connection to Preston"));
      this.pending.clear();
      for (const handler of this.closeHandlers) handler();
    });
    socket.on("error", () => {});
  }

  /** Connects and authenticates with the token file's secret. */
  static async connect(endpoint: string, tokenFile: string): Promise<IpcClient> {
    const token = readFileSync(tokenFile, "utf8").trim();
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(endpoint);
      s.once("connect", () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });
    const client = new IpcClient(socket);
    await client.request("auth", { token });
    return client;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      if (this.socket.destroyed) {
        reject(new Error("Lost the connection to Preston"));
        return;
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      writeMessage(this.socket, { jsonrpc: "2.0", id, method, params });
    });
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  get closed(): boolean {
    return this.socket.destroyed;
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}
