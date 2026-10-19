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

/** UI-only names kept separate from the persisted counter-only status. */
export interface SkillPromptNames {
  automatic: readonly string[];
  pinned: readonly string[];
}

export function formatSkillPromptStartup(
  mode: "active" | "existing_session" | "disabled" | "invalid_config",
): string {
  if (mode === "existing_session")
    return [
      "[jev-skills-retrieval] 已加载 · 旧会话未接管筛选",
      "请执行 /new 启用先筛选后发送；已有历史不会被清除。",
      "启动 [Skills] 是本地发现清单，不能据此判断当前目录是否已经筛选。",
    ].join("\n");
  if (mode === "invalid_config")
    return [
      "[jev-skills-retrieval] 已加载 · 配置存在问题，筛选尚未就绪",
      "请检查 skill-router.json；当前请求可能回退完整技能目录。",
    ].join("\n");
  if (mode === "disabled")
    return [
      "[jev-skills-retrieval] 已加载 · 自动筛选已关闭",
      "[Skills] 仅为本地清单；正常请求仅保留固定项，不自动写入完整目录。",
      "配置异常时仍会明确提示全量回退。",
    ].join("\n");
  return [
    "[jev-skills-retrieval] 已开启 · 先筛选后发送",
    "[Skills] 只是本地发现清单；正常请求不会自动把全部 skill metadata 装入系统提示词。",
    "Jev 先筛选，仅选中项与固定项进入本轮系统提示词；正文由 Pi 按需读取。",
    "服务或配置异常时，会明确提示全量回退。",
  ].join("\n");
}

export function formatSkillPromptNames(
  status: SkillPromptStatus,
  names?: SkillPromptNames,
): string[] {
  if (!names || !["filtered", "fixed_only", "fallback"].includes(status.mode))
    return [];
  const display = (items: readonly string[]) =>
    items
      .map((name) => name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim())
      .filter(Boolean)
      .join("、");
  const prefix = status.verification === "matched" ? "" : "计划";
  const lines: string[] = [];
  if (status.mode === "filtered")
    lines.push(`${prefix}自动选择：${display(names.automatic) || "无"}`);
  if (names.pinned.length || status.mode === "fixed_only")
    lines.push(`${prefix}固定项：${display(names.pinned) || "无"}`);
  return lines;
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

export function formatSkillPromptStatus(
  status: SkillPromptStatus,
  names?: SkillPromptNames,
): string {
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
  const selections = formatSkillPromptNames(status, names);
  return `Jev 技能：${label}${selections.length ? ` · ${selections.join(" · ")}` : ""}${counts} · ${check}${status.reason ? ` · ${reasons[status.reason]}` : ""}`;
}
