import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptForApiKey } from "./key-prompt.ts";

export type CredentialResult =
  | { status: "ready" }
  | { status: "cancelled" | "unavailable" | "aborted" | "ui_error" };

/** Environment wins; interactive credentials stay private to this extension instance. */
export class JevCredentials {
  private enteredKey: string | undefined;

  constructor(
    private readonly readEnvironment: () => string | undefined = () =>
      process.env.TYPESAFE_API_KEY,
  ) {}

  readonly getApiKey = (): string | undefined =>
    this.readEnvironment()?.trim() || this.enteredKey;

  getSource(): "environment" | "memory" | "missing" {
    return this.readEnvironment()?.trim()
      ? "environment"
      : this.enteredKey
        ? "memory"
        : "missing";
  }

  async ensure(
    ctx: Pick<ExtensionContext, "ui" | "hasUI" | "mode" | "signal">,
  ): Promise<CredentialResult> {
    if (ctx.signal?.aborted) return { status: "aborted" };
    if (this.getApiKey()) return { status: "ready" };
    return this.configure(ctx, "task");
  }

  async configure(
    ctx: Pick<ExtensionContext, "ui" | "hasUI" | "mode" | "signal">,
    purpose: "task" | "configure" = "configure",
  ): Promise<CredentialResult> {
    if (ctx.signal?.aborted) return { status: "aborted" };
    if (!ctx.hasUI) return { status: "unavailable" };
    try {
      while (!ctx.signal?.aborted) {
        const value = await promptForApiKey(ctx, purpose);
        if (ctx.signal?.aborted) return { status: "aborted" };
        if (value === undefined) return { status: "cancelled" };
        const key = value.trim();
        if (!key || /[\r\n\0]/.test(key)) {
          ctx.ui.notify(
            purpose === "task"
              ? "API key 不能为空，且必须是单行文本。请重新填写，或取消本次任务。"
              : "API key 不能为空，且必须是单行文本。请重新填写，或取消修改。",
            "warning",
          );
          continue;
        }
        this.enteredKey = key;
        return { status: "ready" };
      }
      return { status: "aborted" };
    } catch {
      // Dialog failures can contain user input. Never forward their error text.
      return { status: "ui_error" };
    }
  }

  clear(): void {
    this.enteredKey = undefined;
  }
}
