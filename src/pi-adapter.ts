import type {
  ExtensionAPI,
  ExtensionFactory,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { pinnedSkills, uniqueSkills } from "./selection.ts";

export interface RoundInput {
  rawText: string;
  catalog: readonly Skill[];
  signal: AbortSignal | undefined;
}

export interface AdapterDependencies {
  select(input: RoundInput): Promise<readonly Skill[]>;
  pinnedPaths?: readonly string[];
}

/** Injectable selection keeps the native Pi boundary independently verifiable. */
export function createSkillRouterExtension(
  dependencies: AdapterDependencies,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let rawText: string | undefined;
    pi.on("session_start", () => {
      rawText = undefined;
    });
    pi.on("input", (event) => {
      if (!event.streamingBehavior) rawText = event.text;
    });
    pi.on("before_agent_start", async (event, ctx) => {
      if (event.messageType !== "user") return;
      const inputText = rawText ?? event.prompt;
      rawText = undefined;
      const catalog = [...event.systemPromptOptions.skills];
      const pinned = pinnedSkills(catalog, dependencies.pinnedPaths ?? []);
      for (const issue of pinned.issues) ctx.ui.notify(issue, "warning");
      // Establish the baseline before any awaited or potentially failing work.
      event.systemPromptOptions.skills = pinned.skills;
      try {
        const selected = await dependencies.select({
          rawText: inputText,
          catalog,
          signal: ctx.signal,
        });
        if (ctx.signal?.aborted) return;
        event.systemPromptOptions.skills = uniqueSkills([
          ...pinned.skills,
          ...selected,
        ]);
      } catch {
        if (ctx.signal?.aborted) return;
        event.systemPromptOptions.skills = uniqueSkills([
          ...pinned.skills,
          ...catalog,
        ]);
        ctx.ui.notify(
          "Skill routing failed; using the original catalog.",
          "warning",
        );
      }
    });
  };
}

/** Stage-one boundary prototype. Live Jev selection is introduced separately. */
export default createSkillRouterExtension({
  select: async ({ catalog }) => catalog,
});
