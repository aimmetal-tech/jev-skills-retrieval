import {
  type ExtensionFactory,
  formatSkillsForPrompt,
  getAgentDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { type LoadedConfig, loadConfig } from "./config.ts";
import { buildRoutingState, type ConversationTurn } from "./context.ts";
import { createJevEvaluator, type Evaluator } from "./jev-client.ts";
import { type RouteReport, route } from "./router.ts";
import { pinnedSkills, uniqueSkills } from "./selection.ts";

export interface AdapterDependencies {
  evaluate?: Evaluator;
  configuration?: (cwd: string) => LoadedConfig;
  onReport?: (report: RouteReport) => void;
  onDiagnostic?: (message: string) => void;
}

export function createSkillRouterExtension(
  dependencies: AdapterDependencies = {},
): ExtensionFactory {
  return (pi) => {
    const evaluate = dependencies.evaluate ?? createJevEvaluator();
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
      const catalog = uniqueSkills(event.systemPromptOptions.skills);
      const loaded =
        dependencies.configuration?.(ctx.cwd) ??
        loadConfig(ctx.cwd, getAgentDir());
      historyLimit = loaded.config.historyMaxTurns;
      const pinned = pinnedSkills(catalog, loaded.config.pinnedSkillPaths);
      const issues = [...loaded.issues, ...pinned.issues];
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
      event.systemPromptOptions.skills = pinned.skills;
      const result = await route(
        {
          catalog,
          pinned: pinned.skills,
          state: buildRoutingState(
            inputText,
            history,
            previous,
            loaded.config,
            earlierHistoryOmitted,
          ),
          config: loaded.config,
          signal: ctx.signal,
          issues,
          ...(reader ? { fileReadTool: reader } : {}),
        },
        evaluate,
      );
      if (ctx.signal?.aborted || result.report.status === "cancelled") return;
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
