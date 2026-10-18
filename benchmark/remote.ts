import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const shellQuote = (value: string) =>
  `'${value.replaceAll("'", "'\\''")}'`;

/** Paths emitted by Windows Pi are translated into the sandbox's POSIX namespace. */
export function sandboxPath(virtualRoot: string, absolute: string) {
  const normalized = resolve(absolute);
  const inside = relative(virtualRoot, normalized);
  if (inside === "") return "/";
  if (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))
    return `/${inside.split(sep).join("/")}`;
  // Native Windows resolution turns /app/file into C:\app\file.
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(normalized))
    return normalized.slice(2).replaceAll("\\", "/");
  return normalized;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  return_code: number;
}
export type RemoteExec = (
  command: string,
  cwd?: string,
  timeout?: number,
) => Promise<ExecResult>;

export function remoteTools(
  virtualRoot: string,
  cwd: string,
  execute: RemoteExec,
) {
  const path = (value: string) => sandboxPath(virtualRoot, value);
  const checked = async (command: string) => {
    const result = await execute(command);
    if (result.return_code !== 0) throw new Error("sandbox_io_failed");
    return result.stdout;
  };
  const readFile = async (file: string) =>
    Buffer.from(await checked(`base64 ${shellQuote(path(file))}`), "base64");
  const writeFile = async (file: string, content: string) => {
    await checked(
      `printf %s ${shellQuote(Buffer.from(content).toString("base64"))} | base64 -d > ${shellQuote(path(file))}`,
    );
  };
  const access = async (file: string) => {
    await checked(`test -r ${shellQuote(path(file))}`);
  };
  return [
    createReadToolDefinition(cwd, {
      operations: {
        readFile,
        access,
        detectImageMimeType: async (file) => {
          const header = await readFile(file);
          if (
            header
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            return "image/png";
          if (header[0] === 255 && header[1] === 216) return "image/jpeg";
          if (header.subarray(0, 4).toString() === "GIF8") return "image/gif";
          if (
            header.subarray(0, 4).toString() === "RIFF" &&
            header.subarray(8, 12).toString() === "WEBP"
          )
            return "image/webp";
          return null;
        },
      },
    }),
    createEditToolDefinition(cwd, {
      operations: { readFile, writeFile, access },
    }),
    createWriteToolDefinition(cwd, {
      operations: {
        writeFile,
        mkdir: async (dir) => {
          await checked(`mkdir -p ${shellQuote(path(dir))}`);
        },
      },
    }),
    createBashToolDefinition(cwd, {
      exposeSessionEnvironment: false,
      operations: {
        exec: async (command, hostCwd, opt) => {
          if (opt.signal?.aborted) throw new Error("sandbox_cancelled");
          const result = await execute(command, path(hostCwd), opt.timeout);
          opt.onData(Buffer.from(result.stdout + result.stderr));
          return { exitCode: result.return_code };
        },
      },
    }),
    // The SDK customTools entry point erases the concrete schema generic.
  ] as unknown as ToolDefinition[];
}

/** A private host-to-sandbox protocol; stdout contains JSON messages only. */
export class JsonBridge {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: ExecResult) => void; reject: (error: Error) => void }
  >();
  readonly lines = createInterface({ input: process.stdin });
  first: Promise<Record<string, unknown>>;
  constructor() {
    this.first = new Promise((resolveFirst) => {
      let initialized = false;
      this.lines.on("line", (line) => {
        const value = JSON.parse(line);
        if (!initialized) {
          initialized = true;
          resolveFirst(value);
          return;
        }
        const pending = this.pending.get(value.id);
        if (!pending) return;
        this.pending.delete(value.id);
        if (value.error) pending.reject(new Error("sandbox_exec_error"));
        else pending.resolve(value.result);
      });
      this.lines.on("close", () => {
        for (const pending of this.pending.values())
          pending.reject(new Error("sandbox_bridge_closed"));
      });
    });
  }
  exec: RemoteExec = (command, cwd, timeout) => {
    const id = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      process.stdout.write(
        `${JSON.stringify({ type: "exec", id, command, cwd, timeout })}\n`,
      );
    });
  };
}
