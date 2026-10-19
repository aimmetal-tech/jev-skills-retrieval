import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  resolveBaseUrl,
  saveProjectBaseUrl,
} from "./base-url.ts";
import type { LoadedConfig } from "./config.ts";
import type { JevCredentials } from "./credentials.ts";
import {
  formatSkillPromptStatus,
  type SkillPromptStatus,
} from "./prompt-status.ts";
import type { RouteReport } from "./router.ts";

const subcommands = [
  {
    value: "apikey",
    label: "apikey [add <apikey>|reset]",
    description: "打开掩码输入框；add 直接保存 key；reset 删除本地凭据",
  },
  {
    value: "baseurl",
    label: "baseurl [URL|reset]",
    description: "设置项目 Jev API 根地址；无参数时打开输入框",
  },
  {
    value: "status",
    label: "status",
    description: "查看配置来源和最近路由状态，不显示 key",
  },
  { value: "help", label: "help", description: "显示二级命令用法" },
];

const help = [
  "/jev-skill apikey  — 打开掩码输入框，保存或更换用户 API key",
  "/jev-skill apikey add <apikey>  — 直接保存 add 后的 API key",
  "/jev-skill apikey reset  — 删除用户目录中的本地凭据",
  "/jev-skill baseurl  — 打开 Base URL 输入框",
  "/jev-skill baseurl <URL>  — 保存当前项目的 Jev API 根地址",
  "/jev-skill baseurl reset  — 移除项目地址，恢复用户配置/环境变量/默认值",
  "/jev-skill status  — 查看配置和最近路由状态（不显示 key）",
  "/jev-skill help  — 显示此帮助",
  "提示：输入 /jev-skill 后加空格，可查看二级命令补全。",
  "地址示例：https://api.typesafe.ai（不要附加 /v1/systemone）。",
  "API key 优先使用 TYPESAFE_API_KEY；弹窗输入保存至 ~/.jev-skill-router/credentials.json。",
].join("\n");

export function registerJevSkillCommand(
  pi: ExtensionAPI,
  options: {
    credentials: JevCredentials;
    configuration: (cwd: string) => LoadedConfig;
    getReport: () => RouteReport | undefined;
    getPromptStatus: () => SkillPromptStatus;
  },
): void {
  pi.registerCommand("jev-skill", {
    description:
      "配置 Jev：apikey [add <apikey>|reset] · baseurl [URL|reset] · status · help",
    getArgumentCompletions: (prefix) => {
      const text = prefix.trimStart();
      if (/^apikey\s/.test(text)) {
        const argument = text.replace(/^apikey\s+/, "");
        const items = [
          {
            value: "apikey add",
            label: "add <apikey>",
            description: "直接保存 add 后的 API key（输入在编辑器中可见）",
          },
          {
            value: "apikey reset",
            label: "reset",
            description: "删除本地凭据；环境变量仍优先",
          },
        ].filter((item) =>
          item.value.slice("apikey ".length).startsWith(argument),
        );
        return items.length ? items : null;
      }
      if (/^baseurl\s/i.test(text)) {
        const argument = text.replace(/^baseurl\s+/i, "");
        return [
          {
            value: `baseurl ${DEFAULT_BASE_URL}`,
            label: DEFAULT_BASE_URL,
            description: "默认 Jev API 根地址；SDK 自动附加 /v1/systemone",
          },
          {
            value: "baseurl reset",
            label: "reset",
            description: "移除当前项目的 Base URL 配置",
          },
        ].filter((item) =>
          item.value.slice("baseurl ".length).startsWith(argument),
        );
      }
      const items = subcommands.filter((item) =>
        item.value.startsWith(text.toLowerCase()),
      );
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [, command = "", argument = ""] =
        args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
      const add = command === "apikey" && /^add(?:\s|$)/.test(argument);
      const notify = (
        message: string,
        type: "info" | "warning" | "error" = "info",
      ) => ctx.ui.notify(message, type);
      if (!command || (command === "help" && !argument)) {
        notify(help);
        return;
      }
      if (command === "status" && !argument) {
        const loaded = options.configuration(ctx.cwd);
        let endpoint = "配置无效；请检查 Base URL";
        try {
          endpoint = resolveBaseUrl(loaded.config.baseUrl);
        } catch {
          /* Never echo unvalidated values. */
        }
        const source = options.credentials.getSource();
        const report = options.getReport();
        notify(
          [
            formatSkillPromptStatus(options.getPromptStatus()),
            `API key：${source === "environment" ? "已配置（环境变量 TYPESAFE_API_KEY）" : source === "file" ? "已配置（用户凭据文件）" : "未配置；运行 /jev-skill apikey 填写"}`,
            `凭据路径：${options.credentials.filePath}`,
            ...(options.credentials.hasStorageError()
              ? ["本地凭据文件无法读取；请用 /jev-skill apikey 重新设置。"]
              : []),
            `Base URL：${endpoint}`,
            `地址来源：${loaded.config.baseUrl ? "用户/项目配置" : process.env.TYPESAFE_BASE_URL?.trim() ? "环境变量 TYPESAFE_BASE_URL" : "SDK 默认地址"}`,
            `模型：${loaded.config.model ?? "SDK 默认模型"}`,
            ...(loaded.issues.length
              ? ["配置存在问题；请检查 skill-router.json。"]
              : []),
            report
              ? `最近路由：${JSON.stringify(report, null, 2)}`
              : "当前会话尚无路由结果。",
          ].join("\n"),
        );
        return;
      }
      if (command !== "apikey" && command !== "baseurl") {
        notify(`未知命令或参数。\n${help}`, "warning");
        return;
      }
      if (command === "apikey" && argument && argument !== "reset" && !add) {
        notify(
          "用法：/jev-skill apikey、/jev-skill apikey add <apikey> 或 /jev-skill apikey reset。",
          "warning",
        );
        return;
      }
      if (!ctx.isIdle()) {
        notify("当前任务正在运行；请等待结束后再修改 Jev 配置。", "warning");
        return;
      }
      if (command === "apikey") {
        if (argument === "reset") {
          try {
            options.credentials.reset();
            notify(
              options.credentials.getSource() === "environment"
                ? "已删除本地凭据；TYPESAFE_API_KEY 仍然生效。"
                : "已删除本地凭据；下次需要 Jev 时会要求重新填写。",
            );
          } catch {
            notify("无法删除本地凭据；请检查用户目录权限。", "error");
          }
          return;
        }
        const result = ctx.signal?.aborted
          ? { status: "aborted" as const }
          : add
            ? options.credentials.save(argument.slice(3))
            : await options.credentials.configure(ctx);
        if (result.status === "ready") {
          notify(
            options.credentials.getSource() === "environment"
              ? `API key 已保存至 ${options.credentials.filePath}；当前仍优先使用 TYPESAFE_API_KEY。`
              : `API key 已保存至 ${options.credentials.filePath}；重启后自动读取。`,
          );
        } else if (result.status === "invalid") {
          notify(
            "用法：/jev-skill apikey add <apikey>；API key 不能为空，且必须是单行文本。",
            "warning",
          );
        } else if (result.status === "unavailable") {
          notify(
            "当前模式无法打开输入框；请先用交互模式的 /jev-skill apikey 保存凭据，或设置 TYPESAFE_API_KEY。",
            "error",
          );
        } else if (result.status === "storage_error") {
          notify(
            "无法保存本地凭据；请检查用户目录权限。未采用本次输入，原凭据未改变。",
            "error",
          );
        } else if (result.status === "ui_error") {
          notify("无法打开 API key 输入框；原配置未改变。", "error");
        } else notify("已取消 API key 修改；原配置未改变。");
        return;
      }
      let value: string | undefined = argument || undefined;
      if (!value) {
        if (!ctx.hasUI) {
          notify(
            "当前模式无法打开输入框；用法：/jev-skill baseurl <URL>。",
            "warning",
          );
          return;
        }
        try {
          while (true) {
            value = await ctx.ui.input(
              "/jev-skill baseurl · Jev API 根地址（取消保留原值）",
              `例如 ${DEFAULT_BASE_URL}；SDK 自动附加 /v1/systemone`,
              ctx.signal ? { signal: ctx.signal } : {},
            );
            if (value === undefined || ctx.signal?.aborted) {
              notify("已取消 Base URL 修改；原配置未改变。");
              return;
            }
            try {
              value = normalizeBaseUrl(value);
              break;
            } catch {
              notify(
                "请输入有效的 HTTP(S) API 根地址；不能包含账户、密码、查询参数或片段。",
                "warning",
              );
            }
          }
        } catch {
          notify("无法打开 Base URL 输入框；原配置未改变。", "error");
          return;
        }
      }
      if (ctx.signal?.aborted) return;
      if (value !== "reset") {
        try {
          value = normalizeBaseUrl(value);
        } catch {
          notify(
            "Base URL 无效。用法：/jev-skill baseurl https://api.typesafe.ai；只支持无凭据、查询参数或片段的 HTTP(S) 根地址。",
            "warning",
          );
          return;
        }
      }
      try {
        saveProjectBaseUrl(ctx.cwd, value === "reset" ? undefined : value);
        notify(
          value === "reset"
            ? "已移除项目 Base URL，后续按用户配置 → TYPESAFE_BASE_URL → 默认地址读取。"
            : `已保存项目 Base URL：${value}；下一次 Jev 路由生效。`,
        );
      } catch {
        notify(
          "无法保存项目 Base URL；请检查 .pi/skill-router.json 的 JSON 格式和写入权限。原配置未改变。",
          "error",
        );
      }
    },
  });
}
