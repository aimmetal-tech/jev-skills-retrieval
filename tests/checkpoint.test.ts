import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { Budget } from "../benchmark/budget.ts";
import {
  atomicJson,
  RECOVERY_POLICY,
  responseUsage,
  TrialCheckpoint,
} from "../benchmark/checkpoint.ts";
import {
  acquireRunLock,
  commitTrial,
  readCommittedTrials,
} from "../benchmark/recovery.ts";
import { emptyCounts, type Trial } from "../benchmark/types.ts";

const limits = {
  maxRequests: 30,
  maxTotalTokens: 10000,
  maxTurns: 5,
  maxOutputTokens: 128,
  taskTimeoutMs: 10000,
};
const policy = {
  ...RECOVERY_POLICY,
  continueUnknownUsage: true,
  retryDelaysMs: [1, 2, 3],
  jevIntervalMs: 0,
  jevAttemptTimeoutMs: 50,
};
const init = {
  method: "POST",
  headers: { authorization: "Bearer fixture-private-key" },
  body: JSON.stringify({
    state: "public benchmark",
    questions: { q: { type: "noul", instructions: "Is it applicable?" } },
  }),
};
const answer = () =>
  Response.json({
    model: "jev-fixture",
    answers: { q: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  });

test("atomic checkpoints tolerate a brief Windows reader that denies file replacement", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jev-checkpoint-reader-"));
  const path = resolve(root, "state.json");
  atomicJson(path, { version: 1 });
  try {
    if (process.platform === "win32") {
      const child = spawn(
        resolve(
          process.env.SystemRoot ?? "C:/Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(
            "$s = [IO.File]::Open($env:JEV_TEST_FILE, 'Open', 'Read', 'ReadWrite'); [Console]::WriteLine('LOCKED'); [Threading.Thread]::Sleep(400); $s.Dispose()",
            "utf16le",
          ).toString("base64"),
        ],
        {
          windowsHide: true,
          env: { SystemRoot: process.env.SystemRoot, JEV_TEST_FILE: path },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const closed = new Promise<void>((done) =>
        child.once("exit", () => done()),
      );
      await new Promise<void>((done, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => done());
        child.once("exit", (code) => {
          if (code) reject(new Error("fixture_reader_failed"));
        });
      });
      try {
        atomicJson(path, { version: 2 });
      } finally {
        await closed;
      }
    } else atomicJson(path, { version: 2 });
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable paid responses restore scores without another HTTP request or double accounting", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jev-receipts-"));
  try {
    let calls = 0;
    const firstBudget = new Budget(limits, true);
    const first = new TrialCheckpoint(root, "scope", firstBudget, policy);
    const response = await first.fetch("jev", async () => {
      calls++;
      return answer();
    })("http://fixture.invalid/v1/systemone", init);
    assert.equal((await response.json()).answers.q.noul, 0.9);
    assert.equal(firstBudget.tokens, 12);
    const restoredBudget = new Budget(limits, true);
    const restored = new TrialCheckpoint(root, "scope", restoredBudget, policy);
    const replay = await restored.fetch("jev", async () => {
      throw new Error("Must use saved real response");
    })("http://fixture.invalid/v1/systemone", init);
    assert.equal((await replay.json()).answers.q.noul, 0.9);
    assert.equal(restoredBudget.tokens, 12);
    assert.equal(restoredBudget.requests, 1);
    assert.equal(restored.stats().replayed.jev, 1);
    assert.equal(calls, 1);
    const saved = (
      await Promise.all(
        (await readdir(root)).map((f) => readFile(resolve(root, f), "utf8")),
      )
    ).join("\n");
    assert.doesNotMatch(saved, /fixture-private-key|authorization/i);
    const mismatchBudget = new Budget(limits, true);
    const mismatch = new TrialCheckpoint(root, "scope", mismatchBudget, policy);
    await assert.rejects(
      () =>
        mismatch.fetch("jev", async () => answer())(
          "http://fixture.invalid/v1/systemone",
          { ...init, body: "changed input" },
        ),
      /checkpoint_request_mismatch/,
    );
    assert.equal(mismatchBudget.stopped, "checkpoint_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("529 unknown costs survive bounded retry and restart; strict mode still stops", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jev-retry-"));
  try {
    let calls = 0;
    const budget = new Budget(limits, true);
    const store = new TrialCheckpoint(
      resolve(root, "enabled"),
      "scope",
      budget,
      policy,
    );
    const reply = await store.fetch("jev", async () =>
      ++calls === 1
        ? Response.json(
            { detail: { error_type: "overloaded" } },
            { status: 529 },
          )
        : answer(),
    )("http://fixture.invalid", init);
    assert.equal(reply.status, 200);
    assert.equal(calls, 2);
    assert.equal(budget.unknownRequests, 1);
    assert.equal(budget.tokens, 12);
    assert.equal(store.stats().jev.complete, false);
    const secondBudget = new Budget(limits, true);
    const resumed = new TrialCheckpoint(
      resolve(root, "enabled"),
      "scope",
      secondBudget,
      policy,
    );
    await resumed.fetch("jev", async () => {
      throw new Error("No resend");
    })("http://fixture.invalid", init);
    assert.equal(secondBudget.unknownRequests, 1);
    assert.equal(secondBudget.requests, 2);
    const strictBudget = new Budget(limits);
    let strictCalls = 0;
    const strict = new TrialCheckpoint(
      resolve(root, "strict"),
      "scope",
      strictBudget,
      { ...policy, continueUnknownUsage: false },
    );
    assert.equal(
      (
        await strict.fetch("jev", async () => {
          strictCalls++;
          return Response.json({}, { status: 529 });
        })("http://fixture.invalid", init)
      ).status,
      529,
    );
    assert.equal(strictCalls, 1);
    assert.equal(strictBudget.stopped, "unknown_usage");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry exhaustion cannot be reset by restarting, and pending intents stay unknown", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jev-interrupted-"));
  try {
    let calls = 0;
    const first = new TrialCheckpoint(root, "scope", new Budget(limits, true), {
      ...policy,
      maxRetries: 1,
    });
    await first.fetch("jev", async () => {
      calls++;
      return Response.json({}, { status: 529 });
    })("http://fixture.invalid", init);
    assert.equal(calls, 2);
    const again = new TrialCheckpoint(root, "scope", new Budget(limits, true), {
      ...policy,
      maxRetries: 1,
    });
    await assert.rejects(
      () =>
        again.fetch("jev", async () => {
          calls++;
          return answer();
        })("http://fixture.invalid", init),
      /attempts_exhausted/,
    );
    assert.equal(calls, 2);
    const pendingPath = resolve(root, "pending");
    const pending = new TrialCheckpoint(
      pendingPath,
      "scope",
      new Budget(limits, true),
      policy,
    );
    pending.onChange = () => {
      throw new Error("Simulated loss after durable intent");
    };
    await assert.rejects(() =>
      pending.fetch("jev", async () => {
        throw new Error("Not reached");
      })("http://fixture.invalid", init),
    );
    const recoveryBudget = new Budget(limits, true);
    const recovered = new TrialCheckpoint(
      pendingPath,
      "scope",
      recoveryBudget,
      policy,
    );
    await recovered.fetch("jev", async () => answer())(
      "http://fixture.invalid",
      init,
    );
    assert.equal(recoveryBudget.requests, 2);
    assert.equal(recoveryBudget.unknownRequests, 1);
    assert.equal(recovered.stats().jev.complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Responses and Completions receipts count cache once and reasoning as an output subset", () => {
  const raw = Buffer.from(
    `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 8, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 2 } } } })}\n\n`,
  );
  const usage = responseUsage("pi", raw);
  assert.equal(usage.input, 90);
  assert.equal(usage.cacheRead, 10);
  assert.equal(usage.output, 8);
  assert.equal(usage.reasoning, 2);
  assert.equal(usage.total, 108);
  assert.equal(
    responseUsage("pi", Buffer.from('data: {"type":"response.created"}\n\n'))
      .complete,
    false,
  );
  assert.equal(
    responseUsage(
      "jev",
      Buffer.from('{"usage":{"input_tokens":7,"output_tokens":null}}'),
    ).input,
    7,
  );
});

test("result journal repairs only torn tails, preserves committed rows and rejects corruption", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jev-result-journal-"));
  try {
    const path = resolve(root, "results.jsonl");
    const row = {
      suite: "skillret",
      caseId: "one",
      group: "native",
      pi: emptyCounts(),
      jev: emptyCounts(),
    } as Trial;
    commitTrial(path, row);
    await writeFile(path, `${JSON.stringify(row)}\n{"unfinished":`);
    assert.equal(readCommittedTrials(path).length, 1);
    assert((await readdir(root)).some((f) => f.includes("torn-")));
    await writeFile(path, `${JSON.stringify(row)}\nnot-json\n`);
    assert.throws(() => readCommittedTrials(path));
    await writeFile(path, `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`);
    assert.throws(() => readCommittedTrials(path), /journal_invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run lease prevents concurrent writers and safely archives a dead owner's stale lock", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jev-run-lease-"));
  try {
    const first = await acquireRunLock(root);
    const owner = JSON.parse(
      await readFile(resolve(root, "running.lock"), "utf8"),
    );
    await assert.rejects(() => acquireRunLock(root), /already_owned/);
    await first.close();
    atomicJson(resolve(root, "running.lock"), { ...owner, pid: 2000000000 });
    const recovered = await acquireRunLock(root);
    assert.equal((await readdir(resolve(root, "lock-history"))).length, 1);
    await recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
