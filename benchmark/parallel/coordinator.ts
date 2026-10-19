import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { atomicJson } from "../checkpoint.ts";
import { type Counts, emptyCounts, type Group, type Trial } from "../types.ts";
import type {
  AttemptRecord,
  Event,
  JobRecord,
  Pause,
  PhaseSpec,
  Provider,
  RpcReply,
  RpcRequest,
  WorkerRecord,
} from "./protocol.ts";

const groups: Group[] = ["native", "router"];
const providers: Provider[] = ["pi", "jev"];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("owner_status_unknown");
  }
};
const validCounts = (v: unknown): v is Counts => {
  if (!v || typeof v !== "object") return false;
  const x = v as Counts;
  return (
    [x.input, x.output, x.cacheRead, x.cacheWrite, x.total].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) &&
    x.total === x.input + x.output + x.cacheRead + x.cacheWrite &&
    typeof x.complete === "boolean"
  );
};
export class Coordinator {
  readonly attempts = new Map<string, AttemptRecord>();
  readonly jobs = new Map<string, JobRecord>();
  readonly workers = new Map<Group, WorkerRecord>();
  readonly pauses: Partial<Record<Provider, Pause>> = {};
  readonly cooldown = { pi: 0, jev: 0 };
  readonly cycles = new Map<string, number>();
  readonly offlineGroups = new Set<Group>();
  private counts = new Map<string, number>();
  private active = new Map<string, number>();
  private activeJobs = new Map<string, number>();
  private fd: number;
  knownTokens = 0;
  unknownRequests = 0;
  settledRequests = 0;
  limitedRequests = 0;
  peakPi = 0;
  peakJev = 0;
  fatal: string | undefined;
  recovered = false;
  circuitBreaks = 0;
  manualInterventions = 0;
  constructor(
    readonly directory: string,
    readonly spec: PhaseSpec,
    private now = () => Date.now(),
  ) {
    mkdirSync(directory, { recursive: true });
    for (const group of groups)
      for (const caseId of spec.queryIds) {
        const key = `${group}/${caseId}`;
        this.jobs.set(key, {
          key,
          group,
          caseId,
          state: "queued",
          extraWorkMs: 0,
          extraRouteMs: 0,
          extraOnlineMs: 0,
        });
      }
    const path = resolve(directory, "coordinator.jsonl");
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8"),
        boundary = raw.lastIndexOf("\n") + 1;
      if (raw.slice(boundary).trim()) {
        writeFileSync(`${path}.torn-${this.now()}.txt`, raw.slice(boundary), {
          flag: "wx",
          mode: 0o600,
        });
        truncateSync(path, Buffer.byteLength(raw.slice(0, boundary)));
      }
      for (const line of raw.slice(0, boundary).split("\n").filter(Boolean))
        this.apply(JSON.parse(line) as Event);
      this.recovered = raw.length > 0;
    }
    this.fd = openSync(path, "a", 0o600);
    if (this.recovered)
      this.record({
        type: "fatal",
        reason: "coordinator_restarted_requires_manual_recovery",
      });
  }
  private apply(e: Event) {
    if (
      !e ||
      ![
        "worker",
        "worker-exited",
        "job",
        "begin",
        "end",
        "reconcile",
        "cooldown",
        "pause",
        "resume",
        "fatal",
      ].includes(e.type)
    )
      throw new Error("invalid_coordinator_journal");
    if ((e.type === "end" || e.type === "reconcile") && !validCounts(e.usage))
      throw new Error("invalid_journal_usage");
    if (e.type === "worker") {
      this.workers.set(e.group, e.worker);
      this.offlineGroups.delete(e.group);
      if (e.worker.epoch > 1) this.manualInterventions++;
    }
    if (e.type === "worker-exited") this.offlineGroups.add(e.group);
    if (e.type === "job") {
      const prior = this.jobs.get(e.job.key);
      if (
        prior &&
        (e.job.extraWorkMs > prior.extraWorkMs ||
          e.job.extraRouteMs > prior.extraRouteMs ||
          e.job.extraOnlineMs > prior.extraOnlineMs)
      )
        this.manualInterventions++;
      this.jobs.set(e.job.key, e.job);
    }
    if (e.type === "begin") {
      if (this.attempts.has(e.attempt.id))
        throw new Error("duplicate_reservation");
      this.attempts.set(e.attempt.id, e.attempt);
      const countKey = `${e.attempt.requestKey}/${e.attempt.cycle}`;
      this.counts.set(countKey, (this.counts.get(countKey) ?? 0) + 1);
      const slot = `${e.attempt.group}/${e.attempt.provider}`;
      this.active.set(slot, (this.active.get(slot) ?? 0) + 1);
      this.activeJobs.set(
        e.attempt.job,
        (this.activeJobs.get(e.attempt.job) ?? 0) + 1,
      );
      this.peakPi = Math.max(
        this.peakPi,
        (this.active.get("native/pi") ?? 0) +
          (this.active.get("router/pi") ?? 0),
      );
      this.peakJev = Math.max(this.peakJev, this.active.get("router/jev") ?? 0);
      this.unknownRequests++;
    }
    if (e.type === "end") {
      const a = this.attempts.get(e.id);
      if (a?.state !== "pending") throw new Error("invalid_settlement");
      a.state = "settled";
      a.status = e.status;
      a.usage = e.usage;
      if (e.reason) a.reason = e.reason;
      const slot = `${a.group}/${a.provider}`;
      this.active.set(slot, (this.active.get(slot) ?? 1) - 1);
      this.activeJobs.set(a.job, (this.activeJobs.get(a.job) ?? 1) - 1);
      this.knownTokens += e.usage.total;
      if (e.usage.complete) this.unknownRequests--;
      this.settledRequests++;
      if (e.status === 429 || e.status === 529) this.limitedRequests++;
    }
    if (e.type === "cooldown")
      this.cooldown[e.provider] = Math.max(this.cooldown[e.provider], e.until);
    if (e.type === "reconcile") {
      const a = this.attempts.get(e.id);
      if (a?.state !== "settled" || a.usage.complete)
        throw new Error("invalid_reconciliation");
      this.knownTokens += e.usage.total - a.usage.total;
      if (e.usage.complete) this.unknownRequests--;
      if (e.status === 429 || e.status === 529) this.limitedRequests++;
      a.status = e.status;
      a.usage = e.usage;
      a.reason = "local_receipt_reconciled";
    }
    if (e.type === "pause") {
      this.pauses[e.provider] = e.pause;
      this.circuitBreaks++;
    }
    if (e.type === "resume") {
      this.manualInterventions++;
      delete this.pauses[e.provider];
      for (const [key, cycle] of Object.entries(e.newCycles))
        this.cycles.set(key, cycle);
    }
    if (e.type === "fatal") this.fatal = e.reason || undefined;
  }
  private record(e: Event) {
    try {
      appendFileSync(this.fd, `${JSON.stringify(e)}\n`);
      fsyncSync(this.fd);
      this.apply(e);
    } catch {
      this.fatal = "coordinator_persistence_failure";
      throw new Error("coordinator_persistence_failure");
    }
  }
  private owner(r: RpcRequest) {
    if (!groups.includes(r.group as Group)) throw new Error("invalid_group");
    const group = r.group as Group,
      w = this.workers.get(group);
    if (!w || w.epoch !== r.epoch) throw new Error("stale_worker_epoch");
    return group;
  }
  private job(r: RpcRequest) {
    const group = this.owner(r),
      job = this.jobs.get(String(r.job));
    if (!job || job.group !== group || job.owner !== r.epoch)
      throw new Error("job_owner_mismatch");
    return job;
  }
  pause(provider: Provider, reason: string, requestKey?: string) {
    if (!this.pauses[provider])
      this.record({
        type: "pause",
        provider,
        pause: { reason, ...(requestKey ? { requestKey } : {}) },
      });
  }
  handle(r: RpcRequest): RpcReply {
    if (r.phase !== this.spec.id) throw new Error("phase_mismatch");
    if (r.op === "register") {
      const group = r.group as Group,
        pid = Number(r.pid);
      if (
        !groups.includes(group) ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        !alive(pid)
      )
        throw new Error("invalid_worker");
      const prior = this.workers.get(group);
      if (prior?.pid === pid) return { ok: true, epoch: prior.epoch };
      if (prior && alive(prior.pid)) throw new Error("group_already_owned");
      // Retain uncertain reservations and their charges when a process died.
      if (prior)
        for (const a of this.attempts.values())
          if (a.group === group && a.state === "pending") {
            this.record({
              type: "end",
              id: a.id,
              status: null,
              usage: { ...emptyCounts(), complete: false },
              reason: "owner_exited_unknown",
            });
          }
      const epoch = (prior?.epoch ?? 0) + 1;
      this.record({ type: "worker", group, worker: { pid, epoch } });
      for (const j of this.jobs.values())
        if (
          j.group === group &&
          (j.state === "running" || j.reason === "infrastructure:worker_exited")
        )
          this.record({
            type: "job",
            job: { ...j, state: "queued", owner: epoch },
          });
      return { ok: true, epoch };
    }
    if (r.op === "next") {
      const group = this.owner(r);
      if (this.workers.size < 2) return { ok: true, waitMs: 200 };
      if (this.fatal) return { ok: true, paused: this.fatal };
      if (this.pauses.pi || (group === "router" && this.pauses.jev))
        return { ok: true, paused: "provider_paused" };
      const jobs = [...this.jobs.values()].filter((j) => j.group === group);
      if (
        jobs.filter((j) => j.state === "running").length >=
        this.spec.concurrency
      )
        return { ok: true, waitMs: 200 };
      const job = jobs.find((j) => j.state === "queued");
      if (!job)
        return {
          ok: true,
          done: jobs.every((j) => j.state === "completed"),
          waitMs: 500,
          paused: jobs.some((j) => j.state === "paused")
            ? "job_paused"
            : undefined,
        };
      const assigned = {
        ...job,
        state: "running" as const,
        owner: r.epoch as number,
      };
      this.record({ type: "job", job: assigned });
      return { ok: true, job: assigned };
    }
    if (r.op === "admit") {
      const job = this.job(r),
        provider = r.provider as Provider,
        id = String(r.id),
        requestKey = String(r.requestKey);
      if (
        !providers.includes(provider) ||
        (provider === "jev" && job.group !== "router") ||
        !/^[-a-zA-Z0-9/]{1,240}$/.test(requestKey) ||
        !/^[a-f0-9-]{36}$/.test(id) ||
        !requestKey.startsWith(`${job.key}/${provider}/`)
      )
        throw new Error("invalid_admission");
      const existing = this.attempts.get(id);
      if (existing) {
        if (existing.requestKey !== requestKey || existing.epoch !== r.epoch)
          throw new Error("reservation_mismatch");
        return existing.state === "pending"
          ? { ok: true, granted: true, attempt: existing }
          : { ok: true, paused: "reservation_already_settled" };
      }
      if (
        this.fatal ||
        this.pauses.pi ||
        (provider === "jev" && this.pauses.jev) ||
        job.state !== "running"
      )
        return {
          ok: true,
          paused: this.fatal ?? "provider_or_job_paused",
          ...(this.pauses.pi
            ? { pausedProvider: "pi", pauseReason: this.pauses.pi.reason }
            : provider === "jev" && this.pauses.jev
              ? { pausedProvider: "jev", pauseReason: this.pauses.jev.reason }
              : {}),
        };
      if (
        this.attempts.size >= this.spec.maxRequests ||
        this.knownTokens >= this.spec.maxTotalTokens
      ) {
        this.record({ type: "fatal", reason: "shared_budget_limit" });
        return { ok: true, paused: this.fatal };
      }
      const cycle = this.cycles.get(requestKey) ?? 0;
      if ((this.counts.get(`${requestKey}/${cycle}`) ?? 0) >= 6) {
        this.pause(provider, "retry_exhausted", requestKey);
        return { ok: true, paused: "retry_exhausted" };
      }
      const wait = this.cooldown[provider] - this.now();
      if (wait > 0)
        return { ok: true, waitMs: Math.min(1000, wait), waiting: "cooldown" };
      if (
        (this.activeJobs.get(job.key) ?? 0) > 0 ||
        (this.active.get(`${job.group}/${provider}`) ?? 0) >=
          this.spec.concurrency
      )
        return { ok: true, waitMs: 100, waiting: "queue" };
      const attempt: AttemptRecord = {
        id,
        requestKey,
        job: job.key,
        group: job.group,
        provider,
        epoch: r.epoch as number,
        cycle,
        startedAt: this.now(),
        status: null,
        state: "pending",
        usage: { ...emptyCounts(), complete: false },
      };
      this.record({ type: "begin", attempt });
      return { ok: true, granted: true, attempt };
    }
    if (r.op === "job-state") {
      const job = this.job(r);
      return {
        ok: true,
        job,
        attempts: [...this.attempts.values()].filter((a) => a.job === job.key),
        cycles: Object.fromEntries(this.cycles),
      };
    }
    if (r.op === "reconcile") {
      const job = this.job(r),
        a = this.attempts.get(String(r.id));
      if (!a || a.job !== job.key || !validCounts(r.usage))
        throw new Error("invalid_reconciliation");
      if (
        a.state === "settled" &&
        a.status === r.status &&
        JSON.stringify(a.usage) === JSON.stringify(r.usage)
      )
        return { ok: true };
      if (
        a.state !== "settled" ||
        a.status !== null ||
        ![
          "owner_exited_unknown",
          "infrastructure_interrupted_unknown",
        ].includes(a.reason ?? "")
      )
        throw new Error("reconciliation_conflict");
      this.record({
        type: "reconcile",
        id: a.id,
        status: r.status === null ? null : Number(r.status),
        usage: r.usage as Counts,
      });
      return { ok: true };
    }
    if (r.op === "settle") {
      const group = this.owner(r),
        a = this.attempts.get(String(r.id));
      if (!a || a.group !== group || !validCounts(r.usage))
        throw new Error("invalid_settlement");
      if (a.state === "settled") {
        if (
          a.status !== r.status ||
          JSON.stringify(a.usage) !== JSON.stringify(r.usage)
        )
          throw new Error("settlement_conflict");
        return { ok: true };
      }
      if (a.epoch !== r.epoch) throw new Error("stale_settlement");
      const status = r.status === null ? null : Number(r.status);
      if (
        status !== null &&
        (!Number.isInteger(status) || status < 100 || status > 599)
      )
        throw new Error("invalid_status");
      this.record({
        type: "end",
        id: a.id,
        status,
        usage: r.usage as Counts,
        ...(typeof r.reason === "string"
          ? { reason: r.reason.slice(0, 64) }
          : {}),
      });
      if (
        typeof r.cooldownUntil === "number" &&
        Number.isFinite(r.cooldownUntil) &&
        r.cooldownUntil > this.now()
      )
        this.record({
          type: "cooldown",
          provider: a.provider,
          until: r.cooldownUntil,
        });
      return { ok: true };
    }
    if (r.op === "cooldown") {
      this.owner(r);
      const provider = r.provider as Provider,
        until = Number(r.until);
      if (!providers.includes(provider) || !Number.isFinite(until) || until < 0)
        throw new Error("invalid_cooldown");
      this.record({ type: "cooldown", provider, until });
      return { ok: true };
    }
    if (r.op === "pause") {
      this.owner(r);
      const provider = r.provider as Provider;
      if (!providers.includes(provider)) throw new Error("invalid_provider");
      this.pause(
        provider,
        String(r.reason).slice(0, 64),
        typeof r.requestKey === "string" ? r.requestKey : undefined,
      );
      return { ok: true };
    }
    if (r.op === "job-paused") {
      const job = this.job(r);
      if (job.state === "completed") return { ok: true };
      this.record({
        type: "job",
        job: { ...job, state: "paused", reason: String(r.reason).slice(0, 64) },
      });
      return { ok: true };
    }
    if (r.op === "infrastructure-failure") {
      this.owner(r);
      this.record({
        type: "fatal",
        reason: "worker_checkpoint_or_protocol_failure",
      });
      return { ok: true };
    }
    if (r.op === "complete") {
      const job = this.job(r),
        row = r.row as Trial;
      if (
        !row ||
        row.caseId !== job.caseId ||
        row.group !== job.group ||
        row.suite !== "skillret" ||
        row.evidence !== this.spec.evidence
      )
        throw new Error("invalid_trial_result");
      if (job.state === "completed") return { ok: true };
      if (
        row.status === "budget" ||
        row.status === "timeout" ||
        row.failure === "context_limit"
      ) {
        const reason = `guard:${row.failure === "turn_limit" || row.failure === "context_limit" ? row.failure : row.status}`;
        this.record({ type: "job", job: { ...job, state: "paused", reason } });
        return { ok: true, paused: reason };
      }
      if (row.status !== "completed") {
        this.pause("pi", "trial_provider_or_harness_error");
        return { ok: true, paused: "trial_error" };
      }
      const attempts = [...this.attempts.values()].filter(
        (a) => a.job === job.key,
      );
      if (
        attempts.some((a) => a.state === "pending") ||
        attempts.length !== row.requests.pi + row.requests.jev ||
        attempts.reduce((n, a) => n + a.usage.total, 0) !==
          row.pi.total + row.jev.total
      )
        throw new Error("trial_accounting_mismatch");
      this.record({ type: "job", job: { ...job, state: "completed", row } });
      return {
        ok: true,
        completedGroup: [...this.jobs.values()].filter(
          (j) => j.group === job.group && j.state === "completed",
        ).length,
      };
    }
    throw new Error("unsupported_rpc_operation");
  }
  /** Only the explicit operator CLI calls this, never a worker or restart path. */
  resume(provider: Provider, newCycle: boolean) {
    if (this.fatal)
      throw new Error("infrastructure_recovery_requires_workers_stopped");
    const cycles: Record<string, number> = {};
    if (this.pauses[provider]?.reason === "retry_exhausted" && !newCycle)
      throw new Error("new_cycle_authorization_required");
    if (newCycle)
      for (const a of this.attempts.values())
        if (a.provider === provider) {
          const current = this.cycles.get(a.requestKey) ?? 0;
          if ((this.counts.get(`${a.requestKey}/${current}`) ?? 0) >= 6)
            cycles[a.requestKey] = current + 1;
        }
    this.record({ type: "resume", provider, newCycles: cycles });
    for (const job of this.jobs.values())
      if (job.state === "paused" && job.reason?.startsWith("service:"))
        this.record({ type: "job", job: { ...job, state: "queued" } });
  }
  extend(key: string, workMs: number, routeMs: number, onlineMs: number) {
    const job = this.jobs.get(key);
    if (
      job?.state !== "paused" ||
      ![workMs, routeMs, onlineMs].every(
        (x) => Number.isSafeInteger(x) && x >= 0,
      ) ||
      workMs + routeMs + onlineMs <= 0
    )
      throw new Error("invalid_budget_extension");
    this.record({
      type: "job",
      job: {
        ...job,
        extraWorkMs: job.extraWorkMs + workMs,
        extraRouteMs: job.extraRouteMs + routeMs,
        extraOnlineMs: job.extraOnlineMs + onlineMs,
        state: job.state === "paused" ? "queued" : job.state,
      },
    });
  }
  recoverInfrastructure() {
    if ([...this.workers.values()].some((w) => alive(w.pid)))
      throw new Error("stop_workers_before_infrastructure_recovery");
    for (const a of this.attempts.values())
      if (a.state === "pending")
        this.record({
          type: "end",
          id: a.id,
          status: null,
          usage: { ...emptyCounts(), complete: false },
          reason: "infrastructure_interrupted_unknown",
        });
    for (const j of this.jobs.values())
      if (
        j.state === "running" ||
        (j.state === "paused" &&
          (j.reason?.startsWith("infrastructure:") ||
            j.reason === "operator:stop"))
      )
        this.record({ type: "job", job: { ...j, state: "queued" } });
    this.record({ type: "fatal", reason: "" });
  }
  rows() {
    return [...this.jobs.values()].flatMap((j) => (j.row ? [j.row] : []));
  }
  checkOwners() {
    for (const [group, w] of this.workers) {
      if (
        this.offlineGroups.has(group) ||
        alive(w.pid) ||
        [...this.jobs.values()]
          .filter((j) => j.group === group)
          .every((j) => j.state === "completed")
      )
        continue;
      this.record({ type: "worker-exited", group });
      for (const a of this.attempts.values())
        if (a.group === group && a.state === "pending")
          this.record({
            type: "end",
            id: a.id,
            status: null,
            usage: { ...emptyCounts(), complete: false },
            reason: "owner_exited_unknown",
          });
      for (const job of this.jobs.values())
        if (job.group === group && job.state === "running")
          this.record({
            type: "job",
            job: {
              ...job,
              state: "paused",
              reason: "infrastructure:worker_exited",
            },
          });
    }
  }
  summary() {
    return {
      phase: this.spec.id,
      kind: this.spec.kind,
      perGroupConcurrency: this.spec.concurrency,
      piPeakLimit: 2 * this.spec.concurrency,
      jevPeakLimit: this.spec.concurrency,
      admittedPeakPi: this.peakPi,
      admittedPeakJev: this.peakJev,
      active: Object.fromEntries(this.active),
      completed: this.rows().length,
      expected: this.jobs.size,
      requests: this.attempts.size,
      settledRequests: this.settledRequests,
      uncertainReservations: this.attempts.size - this.settledRequests,
      knownTokens: this.knownTokens,
      unknownRequests: this.unknownRequests,
      limitedRequests: this.limitedRequests,
      rateLimitedFraction: this.settledRequests
        ? this.limitedRequests / this.settledRequests
        : 0,
      pauses: this.pauses,
      fatal: this.fatal ?? null,
      cooldown: this.cooldown,
      recovered: this.recovered,
      circuitBreaks: this.circuitBreaks,
      manualInterventions: this.manualInterventions,
      offlineGroups: [...this.offlineGroups],
    };
  }
  saveStatus() {
    atomicJson(resolve(this.directory, "progress.json"), {
      ...this.summary(),
      updatedAt: new Date().toISOString(),
    });
  }
  close() {
    closeSync(this.fd);
  }
}
