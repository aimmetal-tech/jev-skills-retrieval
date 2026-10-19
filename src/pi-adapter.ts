import {
  type ExtensionContext,
  type ExtensionFactory,
  formatSkillsForPrompt,
  getAgentDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Fetch } from "@typesafe-ai/sdk";
import type { BatchAttempt, BatchProgress } from "./batching.ts";
import { registerJevSkillCommand } from "./commands.ts";
import { type LoadedConfig, loadConfig } from "./config.ts";
import { buildRoutingState, type ConversationTurn } from "./context.ts";
import type { CredentialStore } from "./credential-store.ts";
import { JevCredentials } from "./credentials.ts";
import { createJevEvaluator, type Evaluator } from "./jev-client.ts";
import {
  formatSkillPromptNames,
  formatSkillPromptStartup,
  formatSkillPromptStatus,
  type SkillPromptNames,
  type SkillPromptStatus,
  verifySkillPrompt,
} from "./prompt-status.ts";
import { type RouteReport, route } from "./router.ts";
import { prepareCatalog } from "./selection.ts";

export interface AdapterDependencies {
  evaluate?: Evaluator;
  fetch?: Fetch;
  getApiKey?: () => string | undefined;
  credentialStore?: CredentialStore;
  configuration?: (cwd: string) => LoadedConfig;
  onReport?: (report: RouteReport) => void;
  onAttempt?: (attempt: BatchAttempt) => void;
  onBatchProgress?: (progress: BatchProgress) => void;
  onDiagnostic?: (message: string) => void;
  /** Optional benchmark observation; normal extension behavior is unchanged. */
  onRouteStart?: () => void;
}

export function createSkillRouterExtension(
  dependencies: AdapterDependencies = {},
): ExtensionFactory {
  return (pi) => {
    const credentials = new JevCredentials(
      dependencies.getApiKey,
      dependencies.credentialStore,
    );
    const evaluate =
      dependencies.evaluate ??
      createJevEvaluator({
        getApiKey: credentials.getApiKey,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      });
    let rawText: string | undefined;
    let history: ConversationTurn[] = [];
    let previous: Skill[] = [];
    let current: ConversationTurn | undefined;
    let historyLimit = 3;
    let earlierHistoryOmitted = false;
    let expectedMetadata: string | undefined;
    let conflictReported = false;
    let unsupportedSession = false;
    let lastReport: RouteReport | undefined;
    let promptStatus: SkillPromptStatus = {
      mode: "waiting",
      verification: "not_sent",
    };
    let lastPromptNotice: string | undefined;
    let promptNames: SkillPromptNames = { automatic: [], pinned: [] };
    const showPromptStatus = (ctx: ExtensionContext) => {
      ctx.ui.setStatus(
        "jev-skill-router",
        formatSkillPromptStatus(promptStatus, promptNames),
      );
      ctx.ui.setWidget(
        "jev-skills-retrieval",
        () =>
          new Text(
            [
              "[jev-skills-retrieval]",
              formatSkillPromptStatus(promptStatus),
              ...formatSkillPromptNames(promptStatus, promptNames),
            ].join("\n"),
            0,
            0,
          ),
        { placement: "aboveEditor" },
      );
    };
    const configuration =
      dependencies.configuration ??
      ((cwd: string) => loadConfig(cwd, getAgentDir()));
    registerJevSkillCommand(pi, {
      credentials,
      configuration,
      getReport: () => lastReport,
      getPromptStatus: () => promptStatus,
      getPromptNames: () => promptNames,
    });
    const blockForMissingKey = (ctx: ExtensionContext, report: RouteReport) => {
      lastReport = { ...report, status: "blocked", reason: "missing_key" };
      dependencies.onReport?.(lastReport);
      pi.appendEntry("jev-skill-router", lastReport);
      promptStatus = {
        ...promptStatus,
        mode: "blocked",
        verification: "not_sent",
        reason: "missing_key",
      };
      showPromptStatus(ctx);
      const message =
        lastReport.message ?? "Jev 缺少 API key；本次任务已停止。";
      dependencies.onDiagnostic?.(message);
      ctx.ui.notify(message, "error");
      ctx.abort();
    };
    pi.on("session_start", (_event, ctx) => {
      rawText = undefined;
      history = [];
      earlierHistoryOmitted = false;
      previous = [];
      current = undefined;
      expectedMetadata = undefined;
      lastReport = undefined;
      lastPromptNotice = undefined;
      promptNames = { automatic: [], pinned: [] };
      unsupportedSession = ctx.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "message" &&
            ["user", "assistant"].includes(entry.message.role),
        );
      promptStatus = unsupportedSession
        ? {
            mode: "unrouted",
            verification: "not_sent",
            reason: "existing_session",
          }
        : { mode: "waiting", verification: "not_sent" };
      showPromptStatus(ctx);
      const loaded = configuration(ctx.cwd);
      const startupMode = unsupportedSession
        ? "existing_session"
        : loaded.issues.length
          ? "invalid_config"
          : loaded.config.maxAutoSkills === 0 ||
              loaded.config.autoMetadataMaxChars === 0
            ? "disabled"
            : "active";
      ctx.ui.notify(
        formatSkillPromptStartup(startupMode),
        unsupportedSession || loaded.issues.length ? "warning" : "info",
      );
    });
    pi.on("input", (event, ctx) => {
      if (event.streamingBehavior) {
        const message =
          "Skill router v1 does not reroute mid-run steering or queued input.";
        dependencies.onDiagnostic?.(message);
        ctx.ui.notify(message, "warning");
      } else rawText = event.text;
    });
    pi.on("session_shutdown", () => credentials.clear());
    pi.on("before_agent_start", async (event, ctx) => {
      lastPromptNotice = undefined;
      promptNames = { automatic: [], pinned: [] };
      const skills = event.systemPromptOptions.skills;
      const tools = event.systemPromptOptions.selectedTools;
      const hidden = event.systemPromptOptions.hiddenTools;
      const reader =
        tools.includes("read") && !hidden.includes("read")
          ? "read"
          : tools.includes("bash") && !hidden.includes("bash")
            ? "bash"
            : tools.includes("read") || tools.includes("bash")
              ? "indirect"
              : undefined;
      const metadata = (items: readonly Skill[]) =>
        reader ? formatSkillsForPrompt([...items], reader).trim() : "";
      expectedMetadata = undefined;
      conflictReported = false;
      promptStatus = {
        mode: "unrouted",
        verification: "pending",
        catalogCount: skills.length,
        plannedCount: reader
          ? skills.filter((skill) => !skill.disableModelInvocation).length
          : 0,
        reason:
          event.messageType !== "user"
            ? "custom_turn"
            : unsupportedSession
              ? "existing_session"
              : "missing_input",
      };
      if (event.messageType !== "user") {
        expectedMetadata = metadata(skills);
        showPromptStatus(ctx);
        return;
      }
      const inputText = rawText;
      rawText = undefined;
      if (unsupportedSession || inputText === undefined) {
        expectedMetadata = metadata(skills);
        const message =
          "Skill router v1 requires a fresh session and normal raw user input; using the original catalog.";
        dependencies.onDiagnostic?.(message);
        ctx.ui.notify(message, "warning");
        showPromptStatus(ctx);
        return;
      }
      if (ctx.signal?.aborted) {
        promptStatus = {
          mode: "blocked",
          verification: "not_sent",
          reason: "cancelled",
        };
        showPromptStatus(ctx);
        return;
      }
      promptStatus = {
        mode: "routing",
        verification: "not_sent",
        phase: "preparing",
      };
      showPromptStatus(ctx);
      dependencies.onRouteStart?.();
      const preparationStarted = performance.now();
      const loaded = configuration(ctx.cwd);
      historyLimit = loaded.config.historyMaxTurns;
      const prepared = prepareCatalog(event.systemPromptOptions.skills, {
        pinnedPaths: loaded.config.pinnedSkillPaths,
      });
      const { catalog, pinned, candidates } = prepared;
      promptStatus = {
        mode: "routing",
        verification: "not_sent",
        catalogCount: catalog.length,
        phase: "preparing",
      };
      showPromptStatus(ctx);
      const issues = [...loaded.issues, ...prepared.issues];
      // Fixed baseline is written before remote work. Errors explicitly restore the catalog.
      event.systemPromptOptions.skills = pinned;
      const state = buildRoutingState(
        inputText,
        history,
        previous,
        loaded.config,
        earlierHistoryOmitted,
      );
      const preparationMs = performance.now() - preparationStarted;
      const candidateCount = candidates.length;
      if (
        !issues.length &&
        candidateCount > 0 &&
        loaded.config.maxAutoSkills > 0 &&
        loaded.config.autoMetadataMaxChars > 0
      ) {
        // Human input is awaited before the network deadline begins. Missing credentials
        // must never fall through to an un-routed model request.
        if (!credentials.getApiKey()) {
          promptStatus = { ...promptStatus, phase: "credentials" };
          showPromptStatus(ctx);
        }
        const credential = await credentials.ensure(ctx);
        if (credential.status !== "ready") {
          const message =
            credential.status === "storage_error"
              ? "无法读取或保存 Jev 本地凭据；请用 /jev-skill apikey 重新设置并检查用户目录权限。本次任务已停止。"
              : credential.status === "unavailable"
                ? "Jev 缺少 API key，当前模式无法弹出输入框。请用 /jev-skill apikey 保存凭据或设置 TYPESAFE_API_KEY 后重启；本次任务已停止。"
                : credential.status === "ui_error"
                  ? "无法打开 Jev API key 输入框；本次任务已停止。"
                  : "未提供 Jev API key；本次任务已取消，未发送模型请求。";
          blockForMissingKey(ctx, {
            status: "blocked",
            reason: "missing_key",
            message,
            elapsedMs: preparationMs,
            candidateCount,
            selectedCount: pinned.length,
          });
          return;
        }
        promptStatus = {
          ...promptStatus,
          phase: "evaluating",
          completedBatches: 0,
        };
        showPromptStatus(ctx);
        ctx.ui.notify(
          `[jev-skills-retrieval] 已启动 · 正在为本次请求评分 ${candidateCount} 个候选技能。`,
          "info",
        );
      }
      let rateLimitNotified = false;
      const result = await route(
        {
          catalog,
          pinned,
          prepared,
          preparationMs,
          state,
          config: loaded.config,
          signal: ctx.signal,
          issues,
          onAttempt: (attempt) => {
            dependencies.onAttempt?.(attempt);
          },
          onProgress: (progress) => {
            dependencies.onBatchProgress?.(progress);
            promptStatus = {
              ...promptStatus,
              phase: progress.phase === "cooldown" ? "backoff" : "evaluating",
              completedBatches: progress.completed,
              batchConcurrency: progress.concurrency,
            };
            showPromptStatus(ctx);
            if (progress.phase === "cooldown" && !rateLimitNotified) {
              rateLimitNotified = true;
              ctx.ui.notify(
                "[jev-skills-retrieval] 收到 HTTP 429，已降低并发并等待共享冷却后有限重试；仍受本轮总时限约束。",
                "warning",
              );
            }
          },
          ...(reader ? { fileReadTool: reader } : {}),
        },
        evaluate,
      );
      if (ctx.signal?.aborted || result.report.status === "cancelled") {
        promptStatus = {
          ...promptStatus,
          mode: "blocked",
          verification: "not_sent",
          reason: "cancelled",
        };
        showPromptStatus(ctx);
        return;
      }
      if (result.report.reason === "missing_key") {
        blockForMissingKey(ctx, {
          ...result.report,
          selectedCount: pinned.length,
          message: "Jev API key 已不可用；本次任务已停止，未发送模型请求。",
        });
        return;
      }
      event.systemPromptOptions.skills = result.skills;
      previous = result.skills;
      current = { user: inputText, assistant: "" };
      expectedMetadata = metadata(result.skills);
      const disabled =
        loaded.config.maxAutoSkills === 0 ||
        loaded.config.autoMetadataMaxChars === 0;
      promptStatus = {
        mode:
          result.report.status === "fallback"
            ? "fallback"
            : disabled || !candidates.length
              ? "fixed_only"
              : "filtered",
        verification: "pending",
        catalogCount: catalog.length,
        plannedCount: reader
          ? result.skills.filter((skill) => !skill.disableModelInvocation)
              .length
          : 0,
        ...(result.report.status !== "fallback" &&
        (disabled || !candidates.length)
          ? {
              reason: disabled
                ? ("disabled" as const)
                : ("no_candidates" as const),
            }
          : {}),
      };
      // Use the existing request snapshot and object identities; do not resolve paths again.
      const fixed = new Set(pinned);
      const visible = reader
        ? result.skills.filter((skill) => !skill.disableModelInvocation)
        : [];
      promptNames = {
        automatic:
          promptStatus.mode === "filtered"
            ? visible
                .filter((skill) => !fixed.has(skill))
                .map((skill) => skill.name)
            : [],
        pinned: visible
          .filter((skill) => fixed.has(skill))
          .map((skill) => skill.name),
      };
      lastReport = result.report;
      dependencies.onReport?.(lastReport);
      pi.appendEntry("jev-skill-router", lastReport);
      showPromptStatus(ctx);
      if (lastReport.status === "fallback") {
        const message = `Skill router fallback [${lastReport.reason}]: ${lastReport.message} Using the original catalog and valid pinned skills.`;
        dependencies.onDiagnostic?.(message);
        ctx.ui.notify(message, "warning");
      }
    });
    pi.on("before_provider_request", (event, ctx) => {
      if (expectedMetadata === undefined) return;
      // Other extensions may change the prompt after routing; inspect the provider fields.
      promptStatus = verifySkillPrompt(
        promptStatus,
        event.payload,
        expectedMetadata,
      );
      showPromptStatus(ctx);
      const summary = formatSkillPromptStatus(promptStatus, promptNames);
      if (summary !== lastPromptNotice) {
        lastPromptNotice = summary;
        pi.appendEntry("jev-skill-prompt", promptStatus);
        ctx.ui.notify(
          summary,
          promptStatus.verification === "mismatch" ||
            promptStatus.mode === "fallback" ||
            promptStatus.mode === "unrouted"
            ? "warning"
            : "info",
        );
      }
      if (promptStatus.verification === "mismatch" && !conflictReported) {
        conflictReported = true;
        const message =
          "Skill router conflict: the effective skill catalog at this request checkpoint differs from the planned selection. Check prompt overrides (including forced systemPrompt) and extension order.";
        dependencies.onDiagnostic?.(message);
      }
    });
    pi.on("message_end", (event) => {
      if (!current || event.message.role !== "assistant") return;
      const text = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text) current.assistant += `${current.assistant ? "\n" : ""}${text}`;
    });
    pi.on("agent_end", () => {
      expectedMetadata = undefined;
      if (current) history.push(current);
      if (history.length > historyLimit) earlierHistoryOmitted = true;
      history = historyLimit === 0 ? [] : history.slice(-historyLimit);
      current = undefined;
    });
    pi.registerCommand("skill-router-status", {
      description:
        "Show the latest Jev skill-routing diagnostic (no prompt or key)",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          [
            formatSkillPromptStatus(promptStatus, promptNames),
            lastReport
              ? JSON.stringify(lastReport, null, 2)
              : "No routing result in this session.",
          ].join("\n"),
          "info",
        );
      },
    });
  };
}

export default createSkillRouterExtension();
