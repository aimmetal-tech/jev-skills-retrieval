import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import type { Budget } from "./budget.ts";
import { type Counts, emptyCounts, type Trial } from "./types.ts";

export const CHECKPOINT_VERSION = 2;
export type ProviderKind = "pi" | "jev";
export interface RecoveryPolicy {
  continueUnknownUsage: boolean;
  maxRetries: number;
  retryDelaysMs: number[];
  jevAttemptTimeoutMs: number;
  piAttemptTimeoutMs: number;
  jevIntervalMs: number;
}
export const RECOVERY_POLICY: Readonly<RecoveryPolicy> = {
  continueUnknownUsage: false,
  maxRetries: 3,
  retryDelaysMs: [5000, 15000, 30000],
  jevAttemptTimeoutMs: 10000,
  piAttemptTimeoutMs: 120000,
  jevIntervalMs: 1000,
};
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** Data is flushed before atomic replacement. No credential-bearing headers are persisted. */
export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

export interface HttpAttempt {
  state: "pending" | "settled";
  startedAt: string;
  elapsedMs: number;
  status: number | null;
  usage: Counts;
  reason?: "interrupted" | "transport" | "http" | "unknown_usage";
  requestId?: string;
  retryAfterMs?: number;
}
interface Receipt {
  schemaVersion: 2;
  scope: string;
  kind: ProviderKind;
  sequence: number;
  requestHash: string;
  attempts: HttpAttempt[];
  response?: {
    status: number;
    contentType: string;
    base64: string;
    sha256: string;
  };
}
interface Manifest {
  schemaVersion: 2;
  scope: string;
  sessionId: string;
  activeElapsedMs: number;
  resumes: number;
}

/** Raw provider usage, including cache once and reasoning only as an output subset. */
export function responseUsage(kind: ProviderKind, body: Buffer): Counts {
  const result = emptyCounts();
  result.complete = false;
  let usage: Record<string, unknown> | undefined;
  const inspect = (value: unknown) => {
    if (!object(value)) return;
    const candidate = object(value.response) ? value.response : value;
    if (object(candidate.usage)) usage = candidate.usage;
  };
  const text = body.toString("utf8");
  try {
    inspect(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        inspect(JSON.parse(line.slice(5).trim()));
      } catch {
        /* SSE framing. */
      }
    }
  }
  if (!usage) return result;
  const input = count(usage.input_tokens ?? usage.prompt_tokens);
  const output = count(usage.output_tokens ?? usage.completion_tokens);
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details;
  const cache =
    kind === "pi" && object(details) ? (count(details.cached_tokens) ?? 0) : 0;
  const outputDetails =
    usage.output_tokens_details ?? usage.completion_tokens_details;
  result.input = input === null ? 0 : input - Math.min(input, cache);
  result.cacheRead = input === null ? 0 : Math.min(input, cache);
  result.output = output ?? 0;
  result.reasoning = object(outputDetails)
    ? count(outputDetails.reasoning_tokens)
    : null;
  result.total = result.input + result.cacheRead + result.output;
  result.complete = input !== null && output !== null;
  return result;
}

export interface CheckpointStats {
  requests: { pi: number; jev: number };
  pi: Counts;
  jev: Counts;
  unknownRequests: number;
  replayed: { pi: number; jev: number };
}

/** Reconstructs fresh Pi state by replaying only matching, previously paid real responses. */
export class TrialCheckpoint {
  readonly manifest: Manifest;
  private receipts = new Map<string, Receipt>();
  private cursor = { pi: 0, jev: 0 };
  private replayed = { pi: 0, jev: 0 };
  private segmentStarted = performance.now();
  private priorElapsed: number;
  private lastJevEnd = 0;
  onChange: (() => void) | undefined;
  /** Test-only crash hook runs after a durable response commit, before SDK delivery. */
  afterCommit:
    | ((kind: ProviderKind, sequence: number) => Promise<void>)
    | undefined;

  constructor(
    readonly directory: string,
    readonly scope: string,
    readonly budget: Budget,
    readonly policy: RecoveryPolicy = { ...RECOVERY_POLICY },
  ) {
    mkdirSync(directory, { recursive: true });
    const manifestPath = resolve(directory, "manifest.json");
    if (existsSync(manifestPath)) {
      this.manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        this.manifest.schemaVersion !== CHECKPOINT_VERSION ||
        this.manifest.scope !== scope ||
        !Number.isFinite(this.manifest.activeElapsedMs) ||
        this.manifest.activeElapsedMs < 0 ||
        typeof this.manifest.sessionId !== "string"
      )
        throw new Error("checkpoint_manifest_mismatch");
      this.manifest.resumes++;
    } else
      this.manifest = {
        schemaVersion: 2,
        scope,
        sessionId: randomUUID(),
        activeElapsedMs: 0,
        resumes: 0,
      };
    this.priorElapsed = this.manifest.activeElapsedMs;
    for (const name of readdirSync(directory)
      .filter((n) => /^(pi|jev)-\d{6}\.json$/.test(n))
      .sort()) {
      const receipt: Receipt = JSON.parse(
        readFileSync(resolve(directory, name), "utf8"),
      );
      if (
        receipt.schemaVersion !== 2 ||
        receipt.scope !== scope ||
        !["pi", "jev"].includes(receipt.kind) ||
        name !== this.name(receipt.kind, receipt.sequence) ||
        !Array.isArray(receipt.attempts)
      )
        throw new Error("checkpoint_receipt_mismatch");
      for (const attempt of receipt.attempts) {
        if (attempt.state === "pending") {
          attempt.state = "settled";
          attempt.reason = "interrupted";
          attempt.usage = { ...emptyCounts(), complete: false };
        }
        if (
          !attempt.usage ||
          !Number.isSafeInteger(attempt.usage.total) ||
          attempt.usage.total < 0
        )
          throw new Error("checkpoint_usage_invalid");
        budget.requests++;
        budget.account(attempt.usage.total);
        if (!attempt.usage.complete) budget.account(null);
      }
      this.validateCache(receipt);
      this.receipts.set(name, receipt);
      atomicJson(resolve(directory, name), receipt);
    }
    this.saveManifest();
  }

  private name(kind: ProviderKind, sequence: number) {
    return `${kind}-${String(sequence).padStart(6, "0")}.json`;
  }
  private saveManifest() {
    this.manifest.activeElapsedMs =
      this.priorElapsed + performance.now() - this.segmentStarted;
    try {
      atomicJson(resolve(this.directory, "manifest.json"), this.manifest);
    } catch {
      this.budget.stopped = "checkpoint_failure";
      throw new Error("checkpoint_write_failed");
    }
  }
  get elapsedMs() {
    return this.priorElapsed + performance.now() - this.segmentStarted;
  }
  private save(receipt: Receipt) {
    try {
      atomicJson(
        resolve(this.directory, this.name(receipt.kind, receipt.sequence)),
        receipt,
      );
    } catch {
      this.budget.stopped = "checkpoint_failure";
      throw new Error("checkpoint_write_failed");
    }
    this.saveManifest();
    this.onChange?.();
  }
  private validateCache(receipt: Receipt) {
    if (
      receipt.response &&
      hash(Buffer.from(receipt.response.base64, "base64")) !==
        receipt.response.sha256
    ) {
      this.budget.stopped = "checkpoint_mismatch";
      throw new Error("checkpoint_response_corrupt");
    }
  }
  stats(): CheckpointStats {
    const result: CheckpointStats = {
      requests: { pi: 0, jev: 0 },
      pi: emptyCounts(),
      jev: emptyCounts(),
      unknownRequests: 0,
      replayed: { ...this.replayed },
    };
    for (const receipt of this.receipts.values())
      for (const attempt of receipt.attempts) {
        result.requests[receipt.kind]++;
        const total = result[receipt.kind];
        for (const key of [
          "input",
          "output",
          "cacheRead",
          "cacheWrite",
          "total",
        ] as const)
          total[key] += attempt.usage[key];
        if (attempt.usage.reasoning !== null)
          total.reasoning = (total.reasoning ?? 0) + attempt.usage.reasoning;
        total.complete &&=
          attempt.state === "settled" && attempt.usage.complete;
        if (attempt.state !== "settled" || !attempt.usage.complete)
          result.unknownRequests++;
      }
    return result;
  }
  finish(row: Trial) {
    this.saveManifest();
    atomicJson(resolve(this.directory, "final.json"), {
      scope: this.scope,
      row,
    });
  }
  final(): Trial | undefined {
    const path = resolve(this.directory, "final.json");
    if (!existsSync(path)) return;
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.scope !== this.scope)
      throw new Error("checkpoint_final_mismatch");
    return value.row;
  }

  fetch(kind: ProviderKind, transport: typeof fetch): typeof fetch {
    return async (input, init) => {
      const sequence = ++this.cursor[kind];
      const name = this.name(kind, sequence);
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      );
      new Headers(init?.headers).forEach((value, key) => {
        headers.set(key, value);
      });
      const bytes = Buffer.from(
        await new Response(
          init?.body ??
            (input instanceof Request
              ? await input.clone().arrayBuffer()
              : null),
        ).arrayBuffer(),
      );
      let decoded = bytes;
      if (headers.get("content-encoding") === "zstd")
        decoded = zstdDecompressSync(bytes);
      if (["gzip", "x-gzip"].includes(headers.get("content-encoding") ?? ""))
        decoded = gunzipSync(bytes);
      let canonical: unknown = decoded.toString("utf8");
      try {
        const parsed = JSON.parse(canonical as string);
        if (object(parsed)) delete parsed.prompt_cache_key; // Cache affinity only, not model input.
        canonical = parsed;
      } catch {
        /* Exact text fingerprint for non-JSON requests. */
      }
      const requestHash = hash(
        JSON.stringify({
          url,
          method:
            init?.method ?? (input instanceof Request ? input.method : "POST"),
          body: canonical,
        }),
      );
      let receipt = this.receipts.get(name);
      if (receipt && receipt.requestHash !== requestHash) {
        this.budget.stopped = "checkpoint_mismatch";
        throw new Error("checkpoint_request_mismatch");
      }
      if (receipt?.response) {
        this.validateCache(receipt);
        this.replayed[kind]++;
        this.saveManifest();
        this.onChange?.();
        return new Response(Buffer.from(receipt.response.base64, "base64"), {
          status: receipt.response.status,
          headers: { "content-type": receipt.response.contentType },
        });
      }
      receipt ??= {
        schemaVersion: 2,
        scope: this.scope,
        kind,
        sequence,
        requestHash,
        attempts: [],
      };
      this.receipts.set(name, receipt);
      let finalResponse: Response | undefined;
      while (receipt.attempts.length <= this.policy.maxRetries) {
        if (init?.signal?.aborted)
          throw new Error("checkpoint_request_cancelled");
        const retry = receipt.attempts.length;
        if (retry) {
          const backoff = Math.max(
            receipt.attempts.at(-1)?.retryAfterMs ?? 0,
            this.policy.retryDelaysMs[
              Math.min(retry - 1, this.policy.retryDelaysMs.length - 1)
            ] ?? 0,
          );
          if (backoff > 60000) break; // Never retry earlier than a long server cooldown.
          await delay(backoff, undefined, {
            ...(init?.signal ? { signal: init.signal } : {}),
          });
        }
        if (kind === "jev" && this.lastJevEnd) {
          const wait =
            this.policy.jevIntervalMs - (performance.now() - this.lastJevEnd);
          if (wait > 0)
            await delay(wait, undefined, {
              ...(init?.signal ? { signal: init.signal } : {}),
            });
        }
        this.budget.check();
        this.budget.requests++;
        const attempt: HttpAttempt = {
          state: "pending",
          startedAt: new Date().toISOString(),
          elapsedMs: 0,
          status: null,
          usage: { ...emptyCounts(), complete: false },
        };
        receipt.attempts.push(attempt);
        this.save(receipt); // A crash after this point is conservatively an unknown request.
        const began = performance.now();
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(
          () => controller.abort(),
          kind === "jev"
            ? this.policy.jevAttemptTimeoutMs
            : this.policy.piAttemptTimeoutMs,
        );
        let responseBody: Buffer | undefined;
        let rejectAbort: (() => void) | undefined;
        try {
          const abort = new Promise<never>((_done, reject) => {
            rejectAbort = () =>
              reject(new Error("checkpoint_transport_aborted"));
            controller.signal.addEventListener("abort", rejectAbort, {
              once: true,
            });
            if (controller.signal.aborted) rejectAbort();
          });
          const received = await Promise.race([
            abort,
            (async () => {
              const response = await transport(url, {
                ...init,
                headers,
                body: bytes,
                signal: controller.signal,
                redirect: "error",
              });
              return {
                response,
                body: Buffer.from(await response.arrayBuffer()),
              };
            })(),
          ]);
          const response = received.response;
          attempt.status = response.status;
          const retryAfter = response.headers.get("retry-after");
          const retryMs = response.headers.get("retry-after-ms");
          const cooldown =
            retryMs !== null
              ? Number(retryMs)
              : retryAfter === null
                ? 0
                : /^\d+(\.\d+)?$/.test(retryAfter)
                  ? Number(retryAfter) * 1000
                  : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(cooldown) && cooldown > 0)
            attempt.retryAfterMs = cooldown;
          const requestId =
            response.headers.get("x-typesafe-request-id") ??
            response.headers.get("x-request-id");
          if (requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId))
            attempt.requestId = requestId;
          responseBody = received.body;
          const credential = headers.get("authorization");
          const secret = credential?.replace(/^Bearer\s+/i, "");
          if (
            secret &&
            secret.length > 8 &&
            responseBody.includes(Buffer.from(secret))
          ) {
            this.budget.stopped = "unsafe_provider_response";
            throw new Error("unsafe_provider_response");
          }
          attempt.usage = responseUsage(kind, responseBody);
          attempt.reason = response.ok ? "unknown_usage" : "http";
          finalResponse = new Response(Uint8Array.from(responseBody), {
            status: response.status,
            headers: {
              "content-type":
                response.headers.get("content-type") ?? "application/json",
            },
          });
          if (response.ok && attempt.usage.complete) {
            delete attempt.reason;
            receipt.response = {
              status: response.status,
              contentType:
                response.headers.get("content-type") ?? "application/json",
              base64: responseBody.toString("base64"),
              sha256: hash(responseBody),
            };
          }
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429
          )
            this.budget.stopped = "permanent_http_error";
        } catch {
          attempt.reason = "transport";
        } finally {
          clearTimeout(timer);
          if (rejectAbort)
            controller.signal.removeEventListener("abort", rejectAbort);
          init?.signal?.removeEventListener("abort", onAbort);
          attempt.elapsedMs = performance.now() - began;
          attempt.state = "settled";
          this.budget.account(attempt.usage.total);
          if (!attempt.usage.complete) this.budget.account(null);
          this.lastJevEnd = performance.now();
          this.save(receipt);
        }
        if (receipt.response) {
          await this.afterCommit?.(kind, sequence);
          return finalResponse as Response;
        }
        const retryable =
          attempt.status === 429 ||
          attempt.status === 529 ||
          attempt.status === null;
        if (
          !retryable ||
          receipt.attempts.length > this.policy.maxRetries ||
          this.budget.stopped ||
          init?.signal?.aborted
        )
          break;
      }
      if (finalResponse) return finalResponse;
      throw new Error("checkpoint_attempts_exhausted");
    };
  }
}
