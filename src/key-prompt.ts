import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readClipboardText } from "./clipboard.ts";

/** Reuse Pi's editing/paste handling while never rendering the credential. */
export class MaskedKeyInput extends Input {
  onDispose?: () => void;
  private disposed = false;
  private readingClipboard = false;
  private pasteMessage = "";

  constructor(
    private readonly requestRender: () => void = () => {},
    private readonly purpose: "task" | "configure" = "task",
    private readonly clipboard: {
      read?: () => Promise<string | null | undefined>;
      matchesPaste?: (data: string) => boolean;
    } = {},
  ) {
    super({ placeholder: "输入或粘贴 TypeSafe API key" });
  }

  override handleInput(data: string): void {
    if (this.disposed) return;
    if (
      matchesKey(data, "ctrl+v") ||
      matchesKey(data, "ctrl+shift+v") ||
      matchesKey(data, "shift+insert") ||
      this.clipboard.matchesPaste?.(data)
    ) {
      void this.pasteFromClipboard();
      return;
    }
    // Do not submit an incomplete value while an asynchronous paste is pending.
    if (this.readingClipboard && (matchesKey(data, "enter") || data === "\n"))
      return;
    this.pasteMessage = "";
    super.handleInput(data);
    this.requestRender();
  }

  private async pasteFromClipboard(): Promise<void> {
    if (this.readingClipboard) return;
    this.readingClipboard = true;
    this.pasteMessage = "正在读取剪贴板…";
    this.requestRender();
    try {
      const text = await (this.clipboard.read ?? readClipboardText)();
      if (this.disposed || !this.focused) return;
      const key = text?.trim();
      if (!key) this.pasteMessage = "剪贴板没有可用文本；请使用终端粘贴。";
      else if (/\p{Cc}/u.test(key))
        this.pasteMessage = "API key 必须是单行文本，不能包含控制字符。";
      else {
        super.handleInput(`\x1b[200~${key}\x1b[201~`);
        this.pasteMessage = "";
      }
    } catch {
      if (!this.disposed)
        this.pasteMessage = "无法读取剪贴板；请使用终端粘贴。";
    } finally {
      this.readingClipboard = false;
      if (!this.disposed) this.requestRender();
    }
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
      this.purpose === "task"
        ? "Jev 需要 TYPESAFE_API_KEY"
        : "/jev-skill apikey",
      this.purpose === "task"
        ? "填写并保存后继续当前任务；重启后自动读取。"
        : "输入 TypeSafe API key；保存后重启仍然有效。",
      "保存到 ~/.jev-skill-router/credentials.json",
      "",
      ...input,
      "",
      this.purpose === "task"
        ? "Enter 继续 · Esc 取消本次任务"
        : "Enter 保存 · Esc 取消修改",
      this.pasteMessage || "Ctrl+V 粘贴 · Shift+Insert 粘贴",
    ].map((line) => truncateToWidth(line, width, ""));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setValue("");
    this.onDispose?.();
  }
}

export async function promptForApiKey(
  ctx: Pick<ExtensionContext, "ui" | "mode" | "signal">,
  purpose: "task" | "configure" = "task",
): Promise<string | undefined> {
  if (ctx.signal?.aborted) return undefined;
  if (ctx.mode !== "tui") {
    return ctx.ui.input(
      purpose === "task"
        ? "Jev 需要 TYPESAFE_API_KEY；填写后继续，取消将取消本次任务"
        : "/jev-skill apikey · 输入 TypeSafe API key（取消保留原值）",
      "输入或粘贴 API key；保存至 ~/.jev-skill-router/credentials.json",
      ctx.signal ? { signal: ctx.signal } : {},
    );
  }
  return ctx.ui.custom<string | undefined>(
    (tui, _theme, keybindings, done) => {
      const input = new MaskedKeyInput(() => tui.requestRender(), purpose, {
        matchesPaste: (data) =>
          keybindings.matches(data, "app.clipboard.pasteImage"),
      });
      let finished = false;
      const finish = (value: string | undefined) => {
        if (finished) return;
        finished = true;
        ctx.signal?.removeEventListener("abort", onAbort);
        input.dispose();
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
