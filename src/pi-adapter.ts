import {
  type ExtensionContext,
  type ExtensionFactory,
  formatSkillsForPrompt,
  getAgentDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { Fetch } from "@typesafe-ai/sdk";
import type { BatchAttempt } from "./batching.ts";
import { registerJevSkillCommand } from "./commands.ts";
import { type LoadedConfig, loadConfig } from "./config.ts";
import { buildRoutingState, type ConversationTurn } from "./context.ts";
import type { CredentialStore } from "./credential-store.ts";
import { JevCredentials } from "./credentials.ts";
import { createJevEvaluator, type Evaluator } from "./jev-client.ts";
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
    const configuration =
      dependencies.configuration ??
      ((cwd: string) => loadConfig(cwd, getAgentDir()));
    registerJevSkillCommand(pi, {
      credentials,
      configuration,
      getReport: () => lastReport,
    });
    const blockForMissingKey = (ctx: ExtensionContext, report: RouteReport) => {
      lastReport = { ...report, status: "blocked", reason: "missing_key" };
      dependencies.onReport?.(lastReport);
      pi.appendEntry("jev-skill-router", lastReport);
      ctx.ui.setStatus("jev-skill-router", "Skills: blocked · missing_key");
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
      unsupportedSession = ctx.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "message" &&
            ["user", "assistant"].includes(entry.message.role),
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
      if (event.messageType !== "user") return;
      const inputText = rawText;
      rawText = undefined;
      expectedMetadata = undefined;
      conflictReported = false;
      if (unsupportedSession || inputText === undefined) {
        const message =
          "Skill router v1 requires a fresh session and normal raw user input; using the original catalog.";
        dependencies.onDiagnostic?.(message);
        ctx.ui.notify(message, "warning");
        return;
      }
      if (ctx.signal?.aborted) return;
      dependencies.onRouteStart?.();
      const preparationStarted = performance.now();
      const loaded = configuration(ctx.cwd);
      historyLimit = loaded.config.historyMaxTurns;
      const prepared = prepareCatalog(event.systemPromptOptions.skills, {
        pinnedPaths: loaded.config.pinnedSkillPaths,
      });
      const { catalog, pinned, candidates } = prepared;
      const issues = [...loaded.issues, ...prepared.issues];
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
      }
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
          ...(dependencies.onAttempt
            ? { onAttempt: dependencies.onAttempt }
            : {}),
          ...(reader ? { fileReadTool: reader } : {}),
        },
        evaluate,
      );
      if (ctx.signal?.aborted || result.report.status === "cancelled") return;
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
      expectedMetadata = reader
        ? formatSkillsForPrompt(result.skills, reader).trim()
        : undefined;
      lastReport = result.report;
      dependencies.onReport?.(lastReport);
      pi.appendEntry("jev-skill-router", lastReport);
      ctx.ui.setStatus(
        "jev-skill-router",
        `Skills: ${result.skills.length} · ${lastReport.status}${lastReport.model ? ` · ${lastReport.model}` : ""}`,
      );
      if (lastReport.status === "fallback") {
        const message = `Skill router fallback [${lastReport.reason}]: ${lastReport.message} Using the original catalog and valid pinned skills.`;
        dependencies.onDiagnostic?.(message);
        ctx.ui.notify(message, "warning");
      }
    });
    pi.on("before_provider_request", (_event, ctx) => {
      if (expectedMetadata === undefined || conflictReported) return;
      const prompt = ctx.getSystemPrompt();
      if (
        expectedMetadata
          ? !prompt.includes(expectedMetadata)
          : prompt.includes("<available_skills>")
      ) {
        conflictReported = true;
        const message =
          "Skill router conflict: another extension or forced systemPrompt changed the routed skill metadata. Check extension order and prompt overrides.";
        dependencies.onDiagnostic?.(message);
        ctx.ui.notify(message, "warning");
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
          lastReport
            ? JSON.stringify(lastReport, null, 2)
            : "No routing result in this session.",
          "info",
        );
      },
    });
  };
}

export default createSkillRouterExtension();
