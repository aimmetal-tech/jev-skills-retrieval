import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getCurrentSystemPrompt,
  getSystemMessageText,
  renderSystemMessageUpdate,
  type SystemMessage,
} from "@earendil-works/pi-ai";
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
    /自动选择：hf-cli、tavily-search.*固定项：项目约定.*本轮清单/,
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
      /先筛选后发送.*本轮清单 1\/3 项.*发送前已核验/,
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
    assert.match(formatSkillPromptStatus(result), /本轮清单与计划不一致/);
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
    assert.doesNotMatch(
      formatSkillPromptStatus(result),
      /先筛选后发送|本轮清单 \d/,
    );
  }
});

test("Pi native skill updates replace the active catalog while historical metadata is counted separately", () => {
  const oldCatalog = `<available_skills>${["a", "b", "c", "d"]
    .map((name) => `<skill><name>${name}</name></skill>`)
    .join("")}</available_skills>`;
  const initial: SystemMessage = {
    role: "system",
    content: "base prompt",
    sections: { skills: oldCatalog },
    timestamp: 1,
  };
  const update: SystemMessage = {
    role: "system",
    content: "",
    sections: { skills: beta, cwd: "new-cwd" },
    timestamp: 2,
  };
  assert.match(getCurrentSystemPrompt([initial, update]), /<name>beta<\/name>/);
  assert.doesNotMatch(
    getCurrentSystemPrompt([initial, update]),
    /<name>a<\/name>/,
  );
  for (const payload of [
    {
      instructions: getSystemMessageText(initial),
      input: [
        { role: "developer", content: renderSystemMessageUpdate(update) },
      ],
    },
    {
      messages: [
        { role: "system", content: getSystemMessageText(initial) },
        { role: "user", content: alpha },
        { role: "developer", content: renderSystemMessageUpdate(update) },
        { type: "additional_tools", role: "developer", tools: [] },
      ],
    },
  ]) {
    const before = JSON.stringify(payload);
    const result = verifySkillPrompt(
      { ...selected, catalogCount: 14 },
      payload,
      beta,
    );
    assert.equal(result.verification, "matched");
    assert.equal(result.observedCount, 1);
    assert.equal(result.historicalCount, 4);
    assert.match(
      formatSkillPromptStatus(result),
      /本轮清单 1\/14 项.*历史另带 4 条/,
    );
    assert.equal(JSON.stringify(payload), before);
    assert.doesNotMatch(JSON.stringify(result), /secret-metadata|beta|new-cwd/);
  }
});

test("Pi section replacement, removal and unrelated updates replay in order including zero hits", () => {
  const initial: SystemMessage = {
    role: "system",
    content: "",
    sections: { skills: alpha },
    timestamp: 1,
  };
  const patches: SystemMessage[] = [
    { role: "system", content: "", sections: { cwd: "new-cwd" }, timestamp: 2 },
    { role: "system", content: "", sections: { skills: beta }, timestamp: 3 },
    {
      role: "system",
      content: "",
      sections: { skills: null, cwd: "last-cwd" },
      timestamp: 4,
    },
  ];
  const payload = {
    instructions: getSystemMessageText(initial),
    input: patches.map((message) => ({
      role: "developer",
      content: renderSystemMessageUpdate(message),
    })),
  };
  assert.doesNotMatch(
    getCurrentSystemPrompt([initial, ...patches]),
    /available_skills/,
  );
  const removed = verifySkillPrompt(
    { ...selected, plannedCount: 0 },
    payload,
    "",
  );
  assert.equal(removed.verification, "matched");
  assert.equal(removed.observedCount, 0);
  assert.equal(removed.historicalCount, 2);
  assert.equal(
    verifySkillPrompt(selected, payload, beta).verification,
    "mismatch",
  );
  const restored = {
    role: "developer",
    content: renderSystemMessageUpdate({
      role: "system",
      content: "",
      sections: { skills: alpha },
      timestamp: 5,
    }),
  };
  payload.input.push(restored);
  const result = verifySkillPrompt(selected, payload, alpha);
  assert.equal(result.verification, "matched");
  assert.equal(result.observedCount, 1);
  assert.equal(result.historicalCount, 2);
});

test("replay does not hide wrong latest catalogs or unframed additions and malformed updates stay unknown", () => {
  const update = (value: string) =>
    renderSystemMessageUpdate({
      role: "system",
      content: "",
      sections: { skills: value },
      timestamp: 2,
    });
  for (const input of [
    [{ role: "developer", content: update(beta) }],
    [
      { role: "developer", content: update(alpha) },
      { role: "developer", content: beta },
    ],
    [
      { role: "developer", content: beta },
      { role: "developer", content: update(alpha) },
    ],
  ]) {
    assert.equal(
      verifySkillPrompt(selected, { instructions: alpha, input }, alpha)
        .verification,
      "mismatch",
    );
  }
  for (const text of [
    `Updated system prompt section "skills":\n${beta}`,
    update("<available_skills><skill>"),
    'Removed system prompt section "skills".\n\nunrecognized suffix',
  ]) {
    const result = verifySkillPrompt(
      { ...selected, observedCount: 1, historicalCount: 4 },
      { instructions: alpha, input: [{ role: "developer", content: text }] },
      beta,
    );
    assert.equal(result.verification, "unavailable");
    assert.equal(result.observedCount, undefined);
    assert.equal(result.historicalCount, undefined);
  }
});

test("provider-side history and top-level system baselines with opaque updates remain unverified", () => {
  for (const payload of [
    {
      previous_response_id: "fake-response-id",
      instructions: alpha,
      input: [],
    },
    {
      system: alpha,
      messages: [{ role: "user", content: "opaque update not inspected" }],
    },
  ]) {
    const result = verifySkillPrompt(
      { ...selected, observedCount: 1, historicalCount: 4 },
      payload,
      beta,
    );
    assert.equal(result.verification, "unavailable");
    assert.equal(result.observedCount, undefined);
    assert.equal(result.historicalCount, undefined);
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
