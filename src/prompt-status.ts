/** Safe counters only: never retain provider payloads, prompts or credentials. */
export interface SkillPromptStatus {
  mode:
    | "waiting"
    | "routing"
    | "filtered"
    | "fixed_only"
    | "fallback"
    | "unrouted"
    | "blocked";
  verification: "not_sent" | "pending" | "matched" | "mismatch" | "unavailable";
  catalogCount?: number;
  plannedCount?: number;
  observedCount?: number;
  phase?: "preparing" | "credentials" | "evaluating";
  completedBatches?: number;
  reason?:
    | "existing_session"
    | "missing_input"
    | "custom_turn"
    | "disabled"
    | "no_candidates"
    | "missing_key"
    | "cancelled";
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const texts: string[] = [];
  for (const part of value) {
    if (!record(part) || typeof part.text !== "string") return undefined;
    texts.push(part.text);
  }
  return texts.join("\n");
}

/** Inspect only known system fields, never user messages, tool results or images. */
function systemText(payload: unknown): string | undefined {
  if (!record(payload)) return undefined;
  if ("system" in payload) return textContent(payload.system);
  const texts: string[] = [];
  let recognized = false;
  if ("instructions" in payload) {
    const text = textContent(payload.instructions);
    if (text === undefined) return undefined;
    texts.push(text);
    recognized = true;
  }
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : payload.input;
  if (Array.isArray(messages)) {
    recognized = true;
    for (const message of messages) {
      if (!record(message)) return undefined;
      if (message.role !== "system" && message.role !== "developer") continue;
      const text = textContent(message.content);
      if (text === undefined) return undefined;
      texts.push(text);
    }
  }
  return recognized ? texts.join("\n") : undefined;
}

function skillBlocks(text: string): string[] | undefined {
  const blocks = [
    ...text.matchAll(/<available_skills>[\s\S]*?<\/available_skills>/g),
  ].map((match) => match[0]);
  // An incomplete or unfamiliar representation must not look like an empty catalog.
  const rest = text.replace(
    /<available_skills>[\s\S]*?<\/available_skills>/g,
    "",
  );
  return /<\/?available_skills\b/.test(rest) ? undefined : blocks;
}

export function verifySkillPrompt(
  status: SkillPromptStatus,
  payload: unknown,
  expected: string | undefined,
): SkillPromptStatus {
  const text = systemText(payload);
  const observed = text === undefined ? undefined : skillBlocks(text);
  const planned = expected === undefined ? undefined : skillBlocks(expected);
  if (!observed || !planned) {
    const unavailable: SkillPromptStatus = {
      ...status,
      verification: "unavailable",
    };
    delete unavailable.observedCount;
    return unavailable;
  }
  const observedCount = observed.reduce(
    (sum, block) => sum + [...block.matchAll(/<skill>/g)].length,
    0,
  );
  const matches =
    observed.length === planned.length &&
    observed.every((block, index) => block === planned[index]);
  return {
    ...status,
    observedCount,
    verification: matches ? "matched" : "mismatch",
  };
}

const reasons: Record<NonNullable<SkillPromptStatus["reason"]>, string> = {
  existing_session: "旧会话；/new 启用筛选",
  missing_input: "缺少原始输入",
  custom_turn: "扩展触发的任务",
  disabled: "自动筛选已关闭",
  no_candidates: "无自动候选",
  missing_key: "凭据未就绪",
  cancelled: "任务已取消",
};

export function formatSkillPromptStatus(status: SkillPromptStatus): string {
  if (status.mode === "waiting")
    return "Jev 技能：已启用 · 等待任务（启动 Skills 为本地清单）";
  if (status.mode === "routing") {
    const phase =
      status.phase === "credentials"
        ? "等待 API key"
        : status.phase === "evaluating"
          ? `Jev 评分中 · 已完成 ${status.completedBatches ?? 0} 批`
          : "准备技能目录";
    return `Jev 技能：${phase} · 尚未发送主模型`;
  }
  if (status.mode === "blocked")
    return `Jev 技能：未发送主模型 · ${status.reason ? reasons[status.reason] : "任务已停止"}`;
  const verified = status.verification === "matched";
  const label =
    status.verification === "mismatch"
      ? "目录被改写，筛选效果未确认"
      : status.mode === "filtered"
        ? verified
          ? "先筛选后发送"
          : "筛选完成，待核验"
        : status.mode === "fallback"
          ? "全量回退"
          : status.mode === "fixed_only"
            ? "仅固定项"
            : "未筛选";
  const count = status.observedCount ?? status.plannedCount;
  const counts =
    count === undefined
      ? ""
      : ` · ${status.observedCount === undefined ? "计划" : "请求含"} ${count}${status.catalogCount === undefined ? "" : `/${status.catalogCount}`} 项 metadata`;
  const check = verified
    ? "发送前已核验"
    : status.verification === "pending"
      ? "等待发送前核验"
      : status.verification === "mismatch"
        ? "请求与计划不一致"
        : status.verification === "not_sent"
          ? "尚未发送主模型"
          : "请求格式无法核验";
  return `Jev 技能：${label}${counts} · ${check}${status.reason ? ` · ${reasons[status.reason]}` : ""}`;
}
