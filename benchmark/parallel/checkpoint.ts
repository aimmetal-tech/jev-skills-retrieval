import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import {
  atomicJson,
  type CheckpointStats,
  responseUsage,
} from "../checkpoint.ts";
import type { TrialDurability } from "../pi.ts";
import { emptyCounts, type Trial } from "../types.ts";
import {
  type AttemptRecord,
  digest,
  type JobRecord,
  POLICY,
  type Provider,
  type RpcReply,
  type RpcRequest,
  retryable,
  type TimingState,
} from "./protocol.ts";
import { type Activity, TrialClock } from "./timing.ts";

interface Receipt {
  version: 3;
  scope: string;
  provider: Provider;
  sequence: number;
  requestKey: string;
  requestHash: string;
  attempts: AttemptRecord[];
  retryNotBefore?: number;
  response?: {
    status: number;
    contentType: string;
    base64: string;
    sha256: string;
  };
}
export class ParallelCheckpoint implements TrialDurability {
  readonly protocolVersion = 3 as const;
  readonly manifest: { sessionId: string; resumes: number };
  readonly clock: TrialClock;
  private receipts = new Map<string, Receipt>();
  private cursor = { pi: 0, jev: 0 };
  private replayed = { pi: 0, jev: 0 };
  private cycles: Record<string, number> = {};
  private stopped: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSaved = 0;
  onChange: (() => void) | undefined;
  afterCommit:
    | ((kind: Provider, sequence: number) => Promise<void>)
    | undefined;
  constructor(
    readonly directory: string,
    readonly scope: string,
    readonly job: JobRecord,
    private call: (
      request: RpcRequest,
      signal?: AbortSignal,
    ) => Promise<RpcReply>,
    private random = () => Math.random(),
    private policy = { ...POLICY },
  ) {
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, "manifest.json");
    let saved:
      | {
          version: number;
          scope: string;
          sessionId: string;
          timing: TimingState;
        }
      | undefined;
    if (existsSync(path)) {
      saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved?.version !== 3 || saved.scope !== scope)
        throw new Error("parallel_checkpoint_scope_mismatch");
      if (
        !saved.timing ||
        ![
          saved.timing.workMs,
          saved.timing.queueMs,
          saved.timing.backoffMs,
          saved.timing.cooldownMs,
          saved.timing.onlineMs,
          saved.timing.routeWorkMs,
        ].every((n) => Number.isFinite(n) && n >= 0)
      )
        throw new Error("parallel_timing_corrupt");
    }
    this.clock = new TrialClock(saved?.timing);
    this.manifest = {
      sessionId: saved?.sessionId ?? randomUUID(),
      resumes: this.clock.state.resumes,
    };
    for (const name of readdirSync(directory).filter((n) =>
      /^(pi|jev)-\d{6}\.json$/.test(n),
    )) {
      const r: Receipt = JSON.parse(
        readFileSync(resolve(directory, name), "utf8"),
      );
      if (
        r.version !== 3 ||
        r.scope !== scope ||
        name !== this.name(r.provider, r.sequence)
      )
        throw new Error("parallel_receipt_mismatch");
      if (
        r.response &&
        digest(Buffer.from(r.response.base64, "base64")) !== r.response.sha256
      )
        throw new Error("parallel_response_corrupt");
      this.receipts.set(name, r);
    }
    this.persist();
  }
  async initialize() {
    const state = await this.call({ op: "job-state", job: this.job.key });
    this.cycles = state.cycles as Record<string, number>;
    for (const incoming of state.attempts as AttemptRecord[]) {
      const r = [...this.receipts.values()].find(
        (x) => x.requestKey === incoming.requestKey,
      );
      if (!r) throw new Error("reservation_without_local_intent");
      const own = r.attempts.find((a) => a.id === incoming.id);
      if (
        own?.state === "settled" &&
        incoming.state === "settled" &&
        (incoming.status !== own.status ||
          JSON.stringify(incoming.usage) !== JSON.stringify(own.usage))
      ) {
        await this.call({
          op: "reconcile",
          job: this.job.key,
          id: own.id,
          status: own.status,
          usage: own.usage,
        });
      } else if (!own) r.attempts.push({ ...incoming });
      else if (own.state === "pending") Object.assign(own, incoming);
      if (r.attempts.some((a) => a.state === "pending"))
        throw new Error("unresolved_active_reservation");
      if (!r.retryNotBefore && !r.response && r.attempts.length) {
        const current = r.attempts.filter(
          (a) => a.cycle === (this.cycles[r.requestKey] ?? 0),
        );
        if (current.length)
          r.retryNotBefore =
            Date.now() +
            (this.policy.backoffMs[Math.min(current.length - 1, 4)] ?? 80000);
      }
      this.saveReceipt(r);
    }
    this.timer = setInterval(() => {
      try {
        this.checkLimits();
        if (performance.now() - this.lastSaved > 1000) this.persist();
      } catch {
        this.stopped ??= "infrastructure:checkpoint_write";
      }
    }, 100);
  }
  private name(p: Provider, n: number) {
    return `${p}-${String(n).padStart(6, "0")}.json`;
  }
  get elapsedMs() {
    return this.clock.snapshot().onlineMs;
  }
  routing(active: boolean) {
    this.clock.routing(active);
    this.persist();
  }
  private checkLimits() {
    const t = this.clock.snapshot();
    if (t.workMs >= this.policy.taskWorkMs + this.job.extraWorkMs)
      this.stopped ??= "time:task_work";
    if (t.routeWorkMs >= this.policy.routeWorkMs + this.job.extraRouteMs)
      this.stopped ??= "time:route_work";
    if (t.onlineMs >= this.policy.onlineMs + this.job.extraOnlineMs)
      this.stopped ??= "time:online";
    return this.stopped;
  }
  shouldPause = () => this.checkLimits();
  pause(reason: string) {
    this.stopped ??= reason;
  }
  private persist() {
    try {
      atomicJson(resolve(this.directory, "manifest.json"), {
        version: 3,
        scope: this.scope,
        sessionId: this.manifest.sessionId,
        timing: this.clock.snapshot(),
        paused: this.stopped ?? null,
      });
      this.lastSaved = performance.now();
    } catch {
      this.stopped = "infrastructure:checkpoint_write";
      throw new Error("parallel_checkpoint_write_failed");
    }
  }
  private saveReceipt(r: Receipt) {
    try {
      atomicJson(resolve(this.directory, this.name(r.provider, r.sequence)), r);
      this.persist();
      this.onChange?.();
    } catch {
      this.stopped = "infrastructure:checkpoint_write";
      throw new Error("parallel_checkpoint_write_failed");
    }
  }
  stats(): CheckpointStats {
    const s: CheckpointStats = {
      requests: { pi: 0, jev: 0 },
      pi: emptyCounts(),
      jev: emptyCounts(),
      unknownRequests: 0,
      replayed: { ...this.replayed },
    };
    for (const r of this.receipts.values())
      for (const a of r.attempts) {
        s.requests[r.provider]++;
        const c = s[r.provider];
        for (const key of [
          "input",
          "output",
          "cacheRead",
          "cacheWrite",
          "total",
        ] as const)
          c[key] += a.usage[key];
        if (a.usage.reasoning !== null)
          c.reasoning = (c.reasoning ?? 0) + a.usage.reasoning;
        c.complete &&= a.state === "settled" && a.usage.complete;
        if (a.state !== "settled" || !a.usage.complete) s.unknownRequests++;
      }
    return s;
  }
  final(): Trial | undefined {
    const path = resolve(this.directory, "final.json");
    if (!existsSync(path)) return;
    const r = JSON.parse(readFileSync(path, "utf8"));
    if (r.scope !== this.scope)
      throw new Error("parallel_final_scope_mismatch");
    return r.row;
  }
  finish(row: Trial) {
    this.close();
    row.parallelTiming = this.clock.snapshot();
    row.elapsedMs = row.parallelTiming.onlineMs;
    this.persist();
    if (!this.stopped && row.status === "completed")
      atomicJson(resolve(this.directory, "final.json"), {
        scope: this.scope,
        row,
      });
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private async wait(ms: number, activity: Activity, signal?: AbortSignal) {
    this.clock.set(activity);
    this.persist();
    try {
      await delay(Math.max(1, ms), undefined, signal ? { signal } : {});
    } finally {
      this.clock.set("work");
      this.persist();
    }
  }
  fetch(provider: Provider, transport: typeof fetch): typeof fetch {
    return async (input, init) => {
      const sequence = ++this.cursor[provider],
        name = this.name(provider, sequence);
      if (this.checkLimits()) throw new Error("parallel_trial_paused");
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      );
      new Headers(init?.headers).forEach((v, k) => {
        headers.set(k, v);
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
      let body: unknown = decoded.toString("utf8");
      try {
        body = JSON.parse(body as string);
        if (body && typeof body === "object")
          delete (body as Record<string, unknown>).prompt_cache_key;
      } catch {}
      const hash = digest(
        JSON.stringify({
          url,
          method:
            init?.method ?? (input instanceof Request ? input.method : "POST"),
          body,
        }),
      );
      let r = this.receipts.get(name);
      if (r && r.requestHash !== hash) {
        this.pause("infrastructure:request_mismatch");
        throw new Error("parallel_request_mismatch");
      }
      if (r?.response) {
        this.replayed[provider]++;
        this.persist();
        this.onChange?.();
        return new Response(Buffer.from(r.response.base64, "base64"), {
          status: r.response.status,
          headers: { "content-type": r.response.contentType },
        });
      }
      if (!r) {
        r = {
          version: 3,
          scope: this.scope,
          provider,
          sequence,
          requestKey: `${this.job.key}/${provider}/${sequence}-${hash.slice(0, 16)}`,
          requestHash: hash,
          attempts: [],
        };
        this.receipts.set(name, r);
        this.saveReceipt(r);
      }
      for (;;) {
        if (this.checkLimits() || init?.signal?.aborted)
          throw new Error("parallel_trial_paused");
        const cycle = this.cycles[r.requestKey] ?? 0;
        const attempts = r.attempts.filter((a) => a.cycle === cycle);
        if (attempts.length >= 6) {
          await this.call({
            op: "pause",
            provider,
            reason: "retry_exhausted",
            requestKey: r.requestKey,
          });
          this.pause(`service:${provider}`);
          throw new Error("parallel_retry_exhausted");
        }
        if (r.retryNotBefore && r.retryNotBefore > Date.now())
          await this.wait(
            r.retryNotBefore - Date.now(),
            "backoff",
            init?.signal ?? undefined,
          );
        const id = randomUUID();
        let grant: RpcReply;
        for (;;) {
          if (this.checkLimits() || init?.signal?.aborted)
            throw new Error("parallel_trial_paused");
          try {
            grant = await this.call(
              {
                op: "admit",
                job: this.job.key,
                provider,
                requestKey: r.requestKey,
                id,
              },
              init?.signal ?? undefined,
            );
          } catch {
            this.pause("infrastructure:coordinator_unavailable");
            throw new Error("parallel_coordinator_unavailable");
          }
          if (grant.paused) {
            this.pause(`service:${provider}`);
            throw new Error("parallel_provider_paused");
          }
          if (grant.granted) break;
          await this.wait(
            Number(grant.waitMs) || 100,
            grant.waiting === "cooldown" ? "cooldown" : "queue",
            init?.signal ?? undefined,
          );
        }
        const attempt = grant.attempt as AttemptRecord;
        r.attempts.push(attempt);
        this.saveReceipt(r);
        const controller = new AbortController(),
          onAbort = () => controller.abort();
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        if (init?.signal?.aborted) controller.abort();
        const timeout = setTimeout(
          () => controller.abort(),
          provider === "jev"
            ? this.policy.jevTimeoutMs
            : this.policy.piTimeoutMs,
        );
        let response: Response | undefined,
          raw: Buffer | undefined,
          cooldownMs = 0;
        let abortReject: (() => void) | undefined;
        try {
          const aborted = new Promise<never>((_, reject) => {
            abortReject = () => reject(new Error("parallel_transport_aborted"));
            controller.signal.addEventListener("abort", abortReject, {
              once: true,
            });
            if (controller.signal.aborted) abortReject();
          });
          const received = await Promise.race([
            aborted,
            (async () => {
              const reply = await transport(url, {
                ...init,
                headers,
                body: bytes,
                redirect: "error",
                signal: controller.signal,
              });
              return { reply, bytes: Buffer.from(await reply.arrayBuffer()) };
            })(),
          ]);
          response = received.reply;
          raw = received.bytes;
          attempt.status = response.status;
          const secret = headers
            .get("authorization")
            ?.replace(/^Bearer\s+/i, "");
          if (
            secret &&
            secret.length > 8 &&
            raw.includes(Buffer.from(secret))
          ) {
            this.pause("infrastructure:unsafe_provider_response");
            throw new Error("unsafe_provider_response");
          }
          attempt.usage = responseUsage(provider, raw);
          const ms = response.headers.get("retry-after-ms"),
            seconds = response.headers.get("retry-after");
          cooldownMs =
            ms !== null
              ? Number(ms)
              : seconds === null
                ? 0
                : /^\d+(\.\d+)?$/.test(seconds)
                  ? Number(seconds) * 1000
                  : Date.parse(seconds) - Date.now();
          if (!Number.isFinite(cooldownMs) || cooldownMs < 0) cooldownMs = 0;
          if (response.ok && attempt.usage.complete)
            r.response = {
              status: response.status,
              contentType:
                response.headers.get("content-type") ?? "application/json",
              base64: raw.toString("base64"),
              sha256: digest(raw),
            };
        } catch {
          attempt.reason = "transport_or_interrupted";
        } finally {
          clearTimeout(timeout);
          init?.signal?.removeEventListener("abort", onAbort);
          if (abortReject)
            controller.signal.removeEventListener("abort", abortReject);
          attempt.state = "settled";
        }
        if (!attempt.usage.complete)
          attempt.usage = { ...attempt.usage, complete: false };
        const canRetry = retryable(attempt.status) && !this.stopped;
        let cooldownUntil = 0;
        if (canRetry) {
          const backoff =
            this.policy.backoffMs[Math.min(attempts.length, 4)] ?? 80000;
          const base = Math.max(backoff, cooldownMs);
          r.retryNotBefore =
            Date.now() + backoff + this.random() * this.policy.jitter * backoff;
          if (cooldownMs || [429, 529, 503].includes(attempt.status ?? 0))
            cooldownUntil = Date.now() + base;
        }
        this.saveReceipt(r); // Fully durable body/usage before settlement acknowledgement and SDK delivery.
        try {
          await this.call({
            op: "settle",
            id: attempt.id,
            status: attempt.status,
            usage: attempt.usage,
            cooldownUntil,
            ...(attempt.reason ? { reason: attempt.reason } : {}),
          });
        } catch {
          this.pause("infrastructure:coordinator_settlement");
          throw new Error("parallel_settlement_unconfirmed");
        }
        if (r.response) {
          await this.afterCommit?.(provider, sequence);
          return new Response(Buffer.from(r.response.base64, "base64"), {
            status: r.response.status,
            headers: { "content-type": r.response.contentType },
          });
        }
        if (!canRetry) {
          await this.call({
            op: "pause",
            provider,
            reason:
              this.stopped ??
              (response?.ok
                ? "successful_response_missing_usage"
                : "permanent_http_error"),
          });
          this.pause(`service:${provider}`);
          throw new Error("parallel_permanent_failure");
        }
      }
    };
  }
}
