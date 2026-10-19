import { createConnection, createServer, type Server } from "node:net";
import { resolve } from "node:path";
import type { RpcReply, RpcRequest } from "./protocol.ts";
import { digest } from "./protocol.ts";

export const socketPath = (root: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\jev-benchmark-${digest(resolve(root).toLowerCase()).slice(0, 32)}`
    : resolve(root, "coordinator.sock");
export function rpc(
  path: string,
  request: RpcRequest,
  signal?: AbortSignal,
): Promise<RpcReply> {
  return new Promise((done, reject) => {
    const socket = createConnection(path);
    let raw = "";
    let settled = false;
    const finish = (error?: Error, value?: RpcReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else done(value as RpcReply);
    };
    const abort = () => finish(new Error("coordinator_request_cancelled"));
    const timer = setTimeout(
      () => finish(new Error("coordinator_unavailable")),
      10000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 16000000) {
        finish(new Error("coordinator_reply_too_large"));
        return;
      }
      if (raw.includes("\n"))
        try {
          const reply = JSON.parse(raw.slice(0, raw.indexOf("\n"))) as RpcReply;
          reply.ok
            ? finish(undefined, reply)
            : finish(
                new Error(
                  typeof reply.error === "string"
                    ? reply.error
                    : "coordinator_rejected",
                ),
              );
        } catch {
          finish(new Error("invalid_coordinator_reply"));
        }
    });
    socket.on("error", () => finish(new Error("coordinator_unavailable")));
    socket.on("end", () => {
      if (!settled) finish(new Error("coordinator_reply_missing"));
    });
  });
}
export async function serve(
  path: string,
  handler: (request: RpcRequest) => RpcReply | Promise<RpcReply>,
): Promise<Server> {
  const server = createServer((socket) => {
    let raw = "",
      handled = false;
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (handled) return;
      raw += chunk.toString();
      if (raw.length > 16000000) {
        socket.destroy();
        return;
      }
      if (!raw.includes("\n")) return;
      handled = true;
      void (async () => {
        let reply: RpcReply;
        try {
          reply = await handler(
            JSON.parse(raw.slice(0, raw.indexOf("\n"))) as RpcRequest,
          );
        } catch (e) {
          const message =
            e instanceof Error && /^[a-z0-9_]+$/.test(e.message)
              ? e.message
              : "coordinator_operation_failed";
          reply = { ok: false, error: message };
        }
        socket.end(`${JSON.stringify(reply)}\n`);
      })();
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(path, done);
  });
  return server;
}
