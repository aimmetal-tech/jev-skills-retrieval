import type { Skill } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "./config.ts";

export interface ConversationTurn {
  user: string;
  assistant: string;
}
export interface RoutingState {
  currentMessage: string;
  recentConversation: { turns: ConversationTurn[]; truncated: boolean };
  previousSkills: Array<{ name: string; description: string }>;
}

/** Keep newest text first when trimming, but present it in conversational order. */
export function buildRoutingState(
  currentMessage: string,
  history: readonly ConversationTurn[],
  previous: readonly Pick<Skill, "name" | "description">[],
  config: RouterConfig,
  earlierHistoryOmitted = false,
): RoutingState {
  let remaining = config.historyMaxChars;
  let truncated =
    earlierHistoryOmitted || history.length > config.historyMaxTurns;
  const turns: ConversationTurn[] = [];
  const window = history.slice(-config.historyMaxTurns);
  if (config.historyMaxTurns === 0) window.length = 0;
  for (let index = window.length - 1; index >= 0; index--) {
    const turn = window[index];
    if (!turn) continue;
    if (remaining === 0) {
      truncated = true;
      break;
    }
    const assistant = turn.assistant.slice(-remaining);
    remaining -= assistant.length;
    const user = remaining > 0 ? turn.user.slice(-remaining) : "";
    remaining -= user.length;
    if (
      user.length < turn.user.length ||
      assistant.length < turn.assistant.length
    )
      truncated = true;
    turns.unshift({ user, assistant });
  }
  return {
    currentMessage,
    recentConversation: { turns, truncated },
    previousSkills: previous.map(({ name, description }) => ({
      name,
      description,
    })),
  };
}
