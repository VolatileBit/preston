import { timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { errorMessage, type Logger } from "../log.js";
import { ensurePrivateDir } from "./private-dir.js";
import {
  RPC_ERRORS,
  RpcCallError,
  type RpcRequest,
  readMessages,
  writeMessage,
} from "./protocol.js";

export interface IpcConnection {
  readonly id: number;
  notify(method: string, params?: unknown): void;
  onClose(listener: () => void): void;
}

export type IpcMethod = (params: unknown, connection: IpcConnection) => unknown;

export interface IpcServer {
  close(): Promise<void>;
}

/** Serves authenticated JSON-RPC methods on the daemon's local endpoint. */
export async function startIpcServer(options: {
  endpoint: string;
  token: string;
  methods: Record<string, IpcMethod>;
  log: Logger;
}): Promise<IpcServer> {
  const { endpoint, methods, log } = options;
  const expected = Buffer.from(options.token);
  const sockets = new Set<Socket>();
  let nextId = 0;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const closeListeners: (() => void)[] = [];
    const connection: IpcConnection = {
      id: ++nextId,
      notify: (method, params) => writeMessage(socket, { jsonrpc: "2.0", method, params }),
      onClose: (listener) => closeListeners.push(listener),
    };
    let authenticated = false;
    socket.on("close", () => {
      sockets.delete(socket);
      for (const listener of closeListeners) listener();
    });
    socket.on("error", (err) => log.debug("ipc socket error", { error: err }));

    readMessages(
      socket,
      (message) => {
        if (!("method" in message)) return;
        const request = message as RpcRequest;
        const respond = (result: unknown, error?: { code: number; message: string }) => {
          if (request.id === undefined) return;
          writeMessage(
            socket,
            error
              ? { jsonrpc: "2.0", id: request.id, error }
              : { jsonrpc: "2.0", id: request.id, result: result ?? null },
          );
        };
        if (!authenticated) {
          const given = Buffer.from(
            String((request.params as { token?: unknown } | undefined)?.token ?? ""),
          );
          if (
            request.method === "auth" &&
            given.length === expected.length &&
            timingSafeEqual(given, expected)
          ) {
            authenticated = true;
            respond({ ok: true });
          } else {
            respond(undefined, { code: RPC_ERRORS.unauthorized, message: "Not authorised" });
            socket.end();
          }
          return;
        }
        const method = methods[request.method];
        if (!method) {
          respond(undefined, {
            code: RPC_ERRORS.methodNotFound,
            message: `Unknown method ${request.method}`,
          });
          return;
        }
        Promise.resolve()
          .then(() => method(request.params, connection))
          .then(
            (result) => respond(result),
            (err) => {
              const code = err instanceof RpcCallError ? err.code : RPC_ERRORS.failed;
              if (!(err instanceof RpcCallError))
                log.error("ipc method failed", { method: request.method, error: err });
              respond(undefined, { code, message: errorMessage(err) });
            },
          );
      },
      (err) => {
        log.warn("malformed ipc message", { error: err });
        writeMessage(socket, {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_ERRORS.parse, message: "Parse error" },
        });
      },
    );
  });

  if (process.platform !== "win32") {
    ensurePrivateDir(dirname(endpoint));
    rmSync(endpoint, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The socket is created closed to everyone else, not narrowed afterwards.
    const umask = process.platform === "win32" ? undefined : process.umask(0o077);
    try {
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      if (umask !== undefined) process.umask(umask);
    }
  });
  if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  server.on("error", (err) => log.error("ipc server error", { error: err }));
  log.info("ipc listening");

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
