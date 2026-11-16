import type { Socket } from "node:net";

/**
 * Daemon IPC: newline-delimited JSON-RPC 2.0 over a Unix domain socket or Windows named pipe.
 * The first request on every connection must be `auth` with the secret from `<home>/ipc-token`.
 */

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: RpcError;
}

export type RpcMessage = RpcRequest | RpcResponse;

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
  failed: -32000,
} as const;

/** Keeps a single message from growing without bound. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Calls `onMessage` for each complete JSON line; malformed lines go to `onError`. */
export function readMessages(
  socket: Socket,
  onMessage: (message: RpcMessage) => void,
  onError: (error: Error) => void,
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      onError(new Error("IPC message too large"));
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          onMessage(JSON.parse(line) as RpcMessage);
        } catch (err) {
          onError(err as Error);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
}

export function writeMessage(socket: Socket, message: RpcMessage): void {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}

export class RpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
