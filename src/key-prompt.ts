import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";

/** Reuse Pi's editing/paste handling while never rendering the credential. */
export class MaskedKeyInput extends Input {
  onDispose?: () => void;

  constructor(private readonly requestRender: () => void = () => {}) {
    super({ placeholder: "输入或粘贴 TypeSafe API key" });
  }

  override handleInput(data: string): void {
    super.handleInput(data);
    this.requestRender();
  }

  override render(width: number): string[] {
    if (width < 1) return [];
    const value = this.getValue();
    let input: string[];
    try {
      this.setValue("*".repeat(value.length));
      input = super.render(width);
    } finally {
      this.setValue(value);
    }
    return [
      "Jev 需要 TYPESAFE_API_KEY",
      "填写后继续当前任务；仅在当前会话内存中使用。",
      "",
      ...input,
      "",
      "Enter 继续 · Esc 取消本次任务",
    ].map((line) => truncateToWidth(line, width, ""));
  }

  dispose(): void {
    this.setValue("");
    this.onDispose?.();
  }
}

export async function promptForApiKey(
  ctx: Pick<ExtensionContext, "ui" | "mode" | "signal">,
): Promise<string | undefined> {
  if (ctx.signal?.aborted) return undefined;
  if (ctx.mode !== "tui") {
    return ctx.ui.input(
      "Jev 需要 TYPESAFE_API_KEY；填写后继续，取消将取消本次任务",
      "仅在当前会话内存中使用",
      ctx.signal ? { signal: ctx.signal } : {},
    );
  }
  return ctx.ui.custom<string | undefined>(
    (tui, _theme, _keybindings, done) => {
      const input = new MaskedKeyInput(() => tui.requestRender());
      let finished = false;
      const finish = (value: string | undefined) => {
        if (finished) return;
        finished = true;
        ctx.signal?.removeEventListener("abort", onAbort);
        input.setValue("");
        done(value);
      };
      const onAbort = () => finish(undefined);
      input.onSubmit = finish;
      input.onEscape = onAbort;
      input.onDispose = () => {
        finished = true;
        ctx.signal?.removeEventListener("abort", onAbort);
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal?.aborted) queueMicrotask(onAbort);
      return input;
    },
    {
      overlay: true,
      overlayOptions: { width: "85%", minWidth: 28, margin: 1 },
    },
  );
}
