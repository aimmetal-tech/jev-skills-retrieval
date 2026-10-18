# Jev Skill Router

Pi 原生 TypeScript 扩展。每条正常用户请求用 Jev 对本地技能 metadata
做独立 Noul 判断，再把本轮技能交给 Pi 原生 formatter 和正文读取流程。

## 首版边界

- 复用 Pi 技能发现、原路径和显式 `/skill:name`，无需关闭磁盘扫描。
- 每轮替换自动目录，同一轮工具续跑沿用选择；用户固定项始终优先。
- 正常零命中保留空自动目录；服务错误明确提示并回退原始目录。
- 首版不支持运行中插话、接管已有历史会话、其他 harness 或清除历史正文。
- 兼容基线：`@earendil-works/pi-coding-agent@1.3.0`。需求源码基线：
  [`482c1381`](https://github.com/earendil-works/pi/tree/482c1381a00d8d00bc81697e4a980c593db6803e)。

## 开发

Node.js >=22.19，建议 Node.js 24。`npm ci` 安装依赖，`npm run check`
执行类型检查、Lint、测试和构建。构建输出在 `dist/`。

第一阶段已验证：原生发现的技能目录可按轮替换；实际 HTTP provider payload
只包含选择项和固定项；真实 `read` 工具续跑保持目录；显式技能正文仍由 Pi
加载，选择器保留展开前的输入。测试使用临时本机服务，不消耗线上凭据。

## 使用

```powershell
npm ci
npm run build
$env:TYPESAFE_API_KEY = "your-key"
pi -e ./dist/pi-adapter.js
```

在一个新的 Pi 会话中开始聊天。上面的 `-e` 只对本次启动生效。
长期使用可以在构建后运行 `pi install <本项目绝对路径>`。
本项目不自动改动用户 Pi 配置、技能文件或环境变量。

Jev 只从 `TYPESAFE_API_KEY` 读取 key；无需 `LLM_API_KEY`。
采用官方 `@typesafe-ai/sdk@0.7.0`，请求一个批次，每个候选独立 Noul。
SDK 自身的 `TYPESAFE_BASE_URL` 和 `TYPESAFE_DEFAULT_MODEL` 仍可用；配置中的
`model` 优先。扩展关闭 SDK 日志，避免日志级别环境变量意外输出聊天内容。

## 配置

用户级：Pi agent 目录下的 `skill-router.json`，通常是
`~/.pi/agent/skill-router.json`，遵循 Pi 的 `PI_CODING_AGENT_DIR`。
项目级：`<cwd>/.pi/skill-router.json`。每轮重新读取；普通参数项目优先，
固定路径取两层并集。相对路径以各自配置文件的目录为基准，支持 `~/`。

```json
{
  "historyMaxTurns": 3,
  "historyMaxChars": 8000,
  "maxAutoSkills": 5,
  "autoMetadataMaxChars": 4000,
  "pinnedSkillPaths": ["./skills/my-skill/SKILL.md"],
  "minProbability": 0.65,
  "routeTimeoutMs": 3000
}
```

固定项默认是空列表。固定路径必须已经在 Pi 发现的 catalog 中，且文件存在；
扩展不会因固定路径而额外加载技能正文。原生同名冲突处理仍由 Pi 决定。
固定技能可显示被 `disable-model-invocation` 禁用的 metadata；仅克隆本轮对象。
其余被禁用的技能不参与自动选择，显式命令仍由 Pi 处理。

概率达到阈值后按概率降序排序，同分按本地路径派生的稳定 ID 排序。
自动预算统计 Pi formatter 实际渲染的完整 metadata（含 XML 转义和说明）；
过大候选会跳过，再考虑后续候选。固定项、显式正文不占自动预算。
数量、字符预算可设为 0 来关闭对应自动部分。字符按 JavaScript UTF-16
长度计算，并非 token。当前用户原文不截断；历史从近到远取，截断有标记。

默认参数是试验初值，并非实测最优值。可加 `"model": "已校准的模型版本"`
锁定模型；每轮记录服务实际返回的模型版本和 token usage。

## 故障与诊断

`/skill-router-status` 查看最近结果，Pi 会话的 `jev-skill-router` 自定义条目
记录状态、原因、候选数、选择数、耗时、实际模型和 token usage，不记录
原始聊天或 key。TUI 状态栏显示选择数量及模型；故障另有明确通知。

- 全部低于阈值：正常成功，自动目录为空，保留固定项。
- 缺 key、鉴权失败、限流、服务错误、输入拒绝、无效响应、超时：回退原始
  catalog 并保留有效固定项；不把故障假装成零命中。
- 配置无效或固定路径无效：列出具体字段/路径，保留其余有效固定项并回退，
  本轮不调用 Jev。未知配置字段也会报告；配置中不允许放 key。
- 一次总 deadline 覆盖 SDK、网络和响应解析，并传递共享 abort signal；
  SDK 重试固定为 0。超大目录目前不分批，服务拒绝时明确降级。
- 取消沿用 Pi 语义，不重启工作。Pi 1.3.0 在 `before_agent_start` 阶段可能
  没有暴露操作 signal，因此启动时取消可能等待本次路由 deadline；真实
  Pi 测试确认取消后不会发起 provider 请求。
- 检测到其他扩展的强制 systemPrompt 覆盖目录时通知冲突。扩展加载顺序会
  影响输入与目录；不承诺能检测所有后续 provider payload 改写。

扩展在启用后的新会话维护自己的原始用户文本和助手可见回复。
`/reload` 后若存在历史消息，则明确跳过路由，需 `/new` 开始；不回填旧会话。
不额外读取工具结果、思考内容和技能正文。已经进入 Pi 历史的旧 metadata
或正文不会删除；下一轮只替换活动目录。旧的 prompt delta 可能仍在请求历史中。

## 接口来源

- [Pi 生命周期与扩展 API](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md)
- [Pi package 分发](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/packages.md)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Noul 概率语义](https://docs.typesafe.ai/primitives/noul)

目前已接通真实 SDK 和 Pi provider 边界的离线测试。线上召回率、误命中率、
费用、缓存和 p50/p95 延迟需要另行运行真实目录评测，不能从模拟测试推断。
