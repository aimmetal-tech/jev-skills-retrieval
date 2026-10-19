import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSkillPromptNames,
  formatSkillPromptStatus,
  type SkillPromptStatus,
  verifySkillPrompt,
} from "../src/prompt-status.ts";

const alpha =
  "<available_skills>\n<skill><name>alpha</name><description>secret-metadata</description></skill>\n</available_skills>";
const beta = alpha.replace("alpha", "beta");
const selected: SkillPromptStatus = {
  mode: "filtered",
  verification: "pending",
  catalogCount: 3,
  plannedCount: 1,
};

test("selected names distinguish automatic and pinned skills and remain planned until verified", () => {
  const names = {
    automatic: ["hf-cli", "tavily-search"],
    pinned: ["项目约定"],
  };
  const matched = {
    ...selected,
    plannedCount: 3,
    observedCount: 3,
    verification: "matched" as const,
  };
  assert.deepEqual(formatSkillPromptNames(matched, names), [
    "自动选择：hf-cli、tavily-search",
    "固定项：项目约定",
  ]);
  assert.match(
    formatSkillPromptStatus(matched, names),
    /自动选择：hf-cli、tavily-search.*固定项：项目约定.*请求/,
  );
  for (const verification of ["pending", "unavailable", "mismatch"] as const) {
    assert.deepEqual(
      formatSkillPromptNames({ ...selected, verification }, names),
      ["计划自动选择：hf-cli、tavily-search", "计划固定项：项目约定"],
    );
  }
  assert.deepEqual(
    formatSkillPromptNames(matched, { automatic: [], pinned: [] }),
    ["自动选择：无"],
  );
  assert.deepEqual(
    formatSkillPromptNames({ ...matched, mode: "fallback" }, names),
    ["固定项：项目约定"],
  );
  assert.deepEqual(
    formatSkillPromptNames({ ...matched, mode: "blocked" }, names),
    [],
  );
});

test("displayed skill names cannot inject terminal controls or extra lines", () => {
  const lines = formatSkillPromptNames(
    { ...selected, verification: "matched" },
    {
      automatic: [" hf-cli\n", "unsafe\x1b[31m\u202ename\u2028next"],
      pinned: [],
    },
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /hf-cli/);
  assert.doesNotMatch(lines[0] ?? "", /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

test("prompt verification reads known system fields and ignores user and tool content", () => {
  for (const payload of [
    {
      messages: [
        { role: "system", content: alpha },
        { role: "user", content: beta },
        { role: "tool", content: beta },
      ],
    },
    {
      messages: [
        { role: "developer", content: [{ type: "text", text: alpha }] },
      ],
    },
    { instructions: alpha, input: [{ role: "user", content: beta }] },
    {
      input: [
        { role: "system", content: [{ type: "input_text", text: alpha }] },
      ],
    },
    {
      system: [{ type: "text", text: alpha }],
      messages: [{ role: "user", content: beta }],
    },
  ]) {
    const result = verifySkillPrompt(selected, payload, alpha);
    assert.equal(result.verification, "matched");
    assert.equal(result.observedCount, 1);
    assert.match(
      formatSkillPromptStatus(result),
      /先筛选后发送.*请求含 1\/3 项.*发送前已核验/,
    );
    assert.doesNotMatch(JSON.stringify(result), /secret-metadata|alpha|beta/);
  }
});

test("verification detects same-count replacements, additions, removals and duplicate catalogs", () => {
  for (const text of [
    beta,
    `${alpha}\n${beta}`,
    "forced prompt",
    alpha.replace("secret-metadata", "changed-description"),
  ]) {
    const result = verifySkillPrompt(
      selected,
      { messages: [{ role: "system", content: text }] },
      alpha,
    );
    assert.equal(result.verification, "mismatch");
    assert.match(formatSkillPromptStatus(result), /目录被改写/);
    assert.doesNotMatch(formatSkillPromptStatus(result), /先筛选后发送/);
  }
});

test("zero hits require a known empty system catalog; malformed and unsupported payloads stay unverified", () => {
  const empty = { ...selected, plannedCount: 0 };
  assert.equal(
    verifySkillPrompt(
      empty,
      { messages: [{ role: "system", content: "base prompt" }] },
      "",
    ).verification,
    "matched",
  );
  assert.equal(
    verifySkillPrompt(
      empty,
      { messages: [{ role: "user", content: alpha }] },
      "",
    ).observedCount,
    0,
  );
  for (const payload of [
    undefined,
    "secret-payload",
    {},
    { instructions: null },
    { messages: [{ role: "system", content: [{ type: "unknown" }] }] },
    { messages: [{ role: "system", content: "<available_skills><skill>" }] },
    {
      messages: [
        {
          role: "system",
          content: "<available_skills custom='x'></available_skills>",
        },
      ],
    },
  ]) {
    const result = verifySkillPrompt(
      { ...selected, observedCount: 3 },
      payload,
      alpha,
    );
    assert.equal(result.verification, "unavailable");
    assert.equal(result.observedCount, undefined);
    assert.doesNotMatch(formatSkillPromptStatus(result), /先筛选后发送|请求含/);
  }
});

test("running, fallback, fixed-only, skipped and blocked states never masquerade as filtered", () => {
  assert.match(
    formatSkillPromptStatus({ mode: "waiting", verification: "not_sent" }),
    /已启用.*启动 Skills 为本地清单/,
  );
  assert.match(
    formatSkillPromptStatus({
      mode: "routing",
      phase: "credentials",
      verification: "not_sent",
    }),
    /等待 API key.*尚未发送/,
  );
  assert.match(
    formatSkillPromptStatus({
      mode: "routing",
      phase: "evaluating",
      completedBatches: 2,
      verification: "not_sent",
    }),
    /Jev 评分中.*已完成 2 批/,
  );
  for (const [mode, label] of [
    ["fallback", /全量回退/],
    ["fixed_only", /仅固定项/],
    ["unrouted", /未筛选/],
    ["blocked", /未发送主模型/],
  ] as const) {
    const text = formatSkillPromptStatus({
      ...selected,
      mode,
      verification: "matched",
    });
    assert.match(text, label);
    assert.doesNotMatch(text, /先筛选后发送/);
  }
});
