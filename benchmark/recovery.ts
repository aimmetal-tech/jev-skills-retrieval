import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { atomicJson } from "./checkpoint.ts";
import type { Trial } from "./types.ts";

/** A loopback lease serializes stale-file recovery as well as active writers. */
export async function acquireRunLock(output: string) {
  if (process.platform === "win32") return acquireWindowsMutex(output);
  mkdirSync(output, { recursive: true });
  const canonical = realpathSync.native(output);
  const identity = canonical;
  const port =
    35000 +
    (createHash("sha256").update(identity).digest().readUInt16BE(0) % 10000);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((done, reject) => {
    server.once("error", () =>
      reject(new Error("benchmark_run_already_owned_or_port_busy")),
    );
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => done());
  });
  const path = resolve(output, "running.lock");
  const nonce = randomUUID();
  try {
    if (existsSync(path)) {
      const previous = JSON.parse(readFileSync(path, "utf8"));
      if (
        previous.schemaVersion !== 2 ||
        previous.port !== port ||
        !Number.isSafeInteger(previous.pid)
      )
        throw new Error("benchmark_lock_requires_manual_audit");
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("benchmark_previous_owner_still_alive");
      const archive = resolve(output, "lock-history");
      mkdirSync(archive, { recursive: true });
      renameSync(path, resolve(archive, `${Date.now()}-${randomUUID()}.json`));
    }
    atomicJson(path, {
      schemaVersion: 2,
      pid: process.pid,
      port,
      nonce,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    port,
    async close() {
      if (existsSync(path)) {
        const owner = JSON.parse(readFileSync(path, "utf8"));
        if (owner.nonce === nonce) unlinkSync(path);
      }
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** Windows uses an OS mutex, avoiding excluded/temporarily reserved TCP ports. */
async function acquireWindowsMutex(output: string) {
  mkdirSync(output, { recursive: true });
  const identity = realpathSync.native(output).toLowerCase();
  const mutex = `Global\\JevBenchmark_${createHash("sha256").update(identity).digest("hex")}`;
  const script = `
$m = [Threading.Mutex]::new($false, $env:JEV_BENCH_MUTEX)
$owned = $false
try {
  try { $owned = $m.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { [Console]::WriteLine('BUSY'); exit 2 }
  [Console]::WriteLine('LOCKED')
  [Console]::ReadLine() | Out-Null
} finally { if ($owned) { $m.ReleaseMutex() }; $m.Dispose() }
`;
  const child = spawn(
    resolve(
      process.env.SystemRoot ?? "C:/Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        JEV_BENCH_MUTEX: mutex,
      },
    },
  );
  let owned = false;
  let closing = false;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      closing = true;
      child.kill();
      reject(new Error("benchmark_mutex_unavailable"));
    }, 10000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("benchmark_mutex_unavailable"));
    });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("LOCKED") && !owned) {
        owned = true;
        clearTimeout(timer);
        done();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      if (!owned)
        reject(new Error("benchmark_run_already_owned_or_mutex_unavailable"));
      else if (!closing) {
        process.stderr.write("benchmark_lock_lost\n");
        process.exit(2);
      }
    });
  });
  const path = resolve(output, "running.lock");
  const nonce = randomUUID();
  try {
    if (existsSync(path)) {
      const prior = JSON.parse(readFileSync(path, "utf8"));
      if (prior.schemaVersion !== 2)
        throw new Error("benchmark_lock_requires_manual_audit");
      mkdirSync(resolve(output, "lock-history"), { recursive: true });
      renameSync(
        path,
        resolve(output, "lock-history", `${Date.now()}-${randomUUID()}.json`),
      );
    }
    atomicJson(path, {
      schemaVersion: 2,
      pid: process.pid,
      nonce,
      mutex,
      helperPid: child.pid,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    closing = true;
    child.stdin.end();
    throw error;
  }
  return {
    async close() {
      closing = true;
      if (
        existsSync(path) &&
        JSON.parse(readFileSync(path, "utf8")).nonce === nonce
      )
        unlinkSync(path);
      if (child.exitCode !== null) return;
      await new Promise<void>((done) => {
        child.once("exit", () => done());
        child.stdin.end();
      });
    },
  };
}

/** Repair only an unterminated final append; complete corrupt records are never discarded. */
export function readCommittedTrials(path: string): Trial[] {
  const raw = readFileSync(path, "utf8");
  const boundary = raw.lastIndexOf("\n") + 1;
  const complete = raw.slice(0, boundary);
  const tail = raw.slice(boundary);
  const rows = complete
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Trial);
  if (tail.trim()) {
    let parsed: Trial | undefined;
    try {
      parsed = JSON.parse(tail) as Trial;
    } catch {
      writeFileSync(`${path}.torn-${Date.now()}.txt`, tail, {
        flag: "wx",
        mode: 0o600,
      });
      truncateSync(path, Buffer.byteLength(complete));
    }
    if (parsed) {
      rows.push(parsed);
      appendFileSync(path, "\n");
    }
    const fd = openSync(path, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.suite}/${row.caseId}/${row.group}`;
    if (seen.has(key) || !["native", "router"].includes(row.group))
      throw new Error("benchmark_result_journal_invalid");
    seen.add(key);
  }
  return rows;
}

export function commitTrial(path: string, row: Trial) {
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(row)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
