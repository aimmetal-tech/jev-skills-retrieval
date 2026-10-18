import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type CredentialStore,
  FileCredentialStore,
  validApiKey,
} from "./credential-store.ts";
import { promptForApiKey } from "./key-prompt.ts";

export type CredentialResult =
  | { status: "ready" }
  | {
      status:
        | "cancelled"
        | "unavailable"
        | "aborted"
        | "ui_error"
        | "storage_error";
    };

/** Environment wins; a cached user credential survives process/extension restarts on disk. */
export class JevCredentials {
  private enteredKey: string | undefined;
  private loaded = false;
  private storageError = false;

  constructor(
    private readonly readEnvironment: () => string | undefined = () =>
      process.env.TYPESAFE_API_KEY,
    private readonly store: CredentialStore = new FileCredentialStore(),
  ) {}

  readonly getApiKey = (): string | undefined => {
    const environment = this.readEnvironment()?.trim();
    if (environment) return environment;
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.enteredKey = this.store.read();
      } catch {
        this.storageError = true;
      }
    }
    return this.enteredKey;
  };

  getSource(): "environment" | "file" | "missing" {
    if (this.readEnvironment()?.trim()) return "environment";
    return this.getApiKey() ? "file" : "missing";
  }

  get filePath(): string {
    return this.store.filePath;
  }
  hasStorageError(): boolean {
    return this.storageError;
  }

  reset(): void {
    this.store.remove();
    this.clear();
  }

  async ensure(
    ctx: Pick<ExtensionContext, "ui" | "hasUI" | "mode" | "signal">,
  ): Promise<CredentialResult> {
    if (ctx.signal?.aborted) return { status: "aborted" };
    if (this.getApiKey()) return { status: "ready" };
    if (this.storageError && ctx.hasUI)
      ctx.ui.notify(
        "本地 Jev 凭据文件无法读取。请重新填写以修复，或取消本次任务。",
        "warning",
      );
    if (this.storageError && !ctx.hasUI) return { status: "storage_error" };
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
        if (!validApiKey(key)) {
          ctx.ui.notify(
            purpose === "task"
              ? "API key 不能为空，且必须是单行文本。请重新填写，或取消本次任务。"
              : "API key 不能为空，且必须是单行文本。请重新填写，或取消修改。",
            "warning",
          );
          continue;
        }
        try {
          this.store.save(key);
        } catch {
          return { status: "storage_error" };
        }
        this.enteredKey = key;
        this.loaded = true;
        this.storageError = false;
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
    this.loaded = false;
    this.storageError = false;
  }
}
