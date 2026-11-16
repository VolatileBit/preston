import { readFileSync } from "node:fs";
import type { CodexChild } from "./process.js";

/**
 * Newline-delimited JSON-RPC over the App Server's stdio. The App Server omits the
 * `"jsonrpc": "2.0"` member, and so does Preston.
 */
export type RequestId = number | string;

export interface IncomingRequest {
  id: RequestId;
  method: string;
  params: unknown;
}

export interface IncomingNotification {
  method: string;
  params: unknown;
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method} failed: ${message}`);
  }
}

export class ConnectionClosedError extends Error {}

export interface ConnectionHandlers {
  onNotification(notification: IncomingNotification): void;
  onRequest(request: IncomingRequest): void;
  /** Raw traffic, for the transcript. */
  onTraffic?(direction: "in" | "out", line: string): void;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function readClientVersion(): string {
  try {
    // Same relative location from src/workers/codex and dist/workers/codex.
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLIENT_VERSION = readClientVersion();

export class AppServerConnection {
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private buffer = "";
  private closed = false;

  constructor(
    private readonly child: CodexChild,
    private readonly handlers: ConnectionHandlers,
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stdin.on("error", () => this.close());
  }

  /** Performs the documented handshake: `initialize`, then the `initialized` notification. */
  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: { name: "preston", title: "Preston", version: CLIENT_VERSION },
      capabilities: null,
    });
    this.notify("initialized");
    return result;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed)
      return Promise.reject(new ConnectionClosedError(`${method}: connection closed`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        method,
        resolve: (value) => {
          settle();
          resolve(value as T);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => this.pending.get(id)?.reject(new Error(`${method} timed out`)),
          timeoutMs,
        );
      }
      this.write({ id, method, params: params ?? null });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  /** Rejects outstanding requests; called when the process goes away. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) {
      pending.reject(new ConnectionClosedError(`${pending.method}: codex app-server exited`));
    }
  }

  private write(message: object): void {
    // After shutdown starts (stdin ended), late answers such as a pending approval are dropped.
    if (this.closed || this.child.stdin.writableEnded) return;
    const line = JSON.stringify(message);
    this.handlers.onTraffic?.("out", line);
    this.child.stdin.write(`${line}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.trim()) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    this.handlers.onTraffic?.("in", line);
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return; // Not protocol output; the transcript keeps it.
    }
    const id = message.id as RequestId | undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method !== undefined && id !== undefined) {
      this.handlers.onRequest({ id, method, params: message.params });
    } else if (method !== undefined) {
      this.handlers.onNotification({ method, params: message.params });
    } else if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      const error = message.error as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(new RpcError(pending.method, error.code ?? 0, error.message ?? "error"));
      } else {
        pending.resolve(message.result);
      }
    }
  }
}
