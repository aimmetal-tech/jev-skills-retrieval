# Jev Skill Router

全量 Pi benchmark 的准备、隔离启动、指标和图表工具见 [benchmark/README.md](benchmark/README.md)。
默认不调用模型；真实全量测试等待预算确认。当前 SkillsBench 87 项中有 1 项被本机安全软件阻断，
报告保留原始分母并显示缺口；详见该目录说明。

Pi 原生 TypeScript 扩展。每条正常用户请求用 Jev 对本地技能 metadata
做独立 Noul 判断，再把本轮技能交给 Pi 原生 formatter 和正文读取流程。

## 首版边界

- 复用 Pi 技能发现、原路径和显式 `/skill:name`，无需关闭磁盘扫描。
- 每轮替换自动目录，同一轮工具续跑沿用选择；用户固定项始终优先。
- 正常零命中保留空自动目录；服务错误明确提示并回退原始目录。
- 缺少 key 时阻塞式要求填写；取消或无法输入时停止本次任务，不回退后继续。
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
扩展仅在显式执行 `/jev-skill baseurl` 设置时写入项目配置；技能文件和环境变量保持原样。

Jev 优先从 `TYPESAFE_API_KEY` 读取 key；无需 `LLM_API_KEY`。
未设置时读取 `~/.jev-skill-router/credentials.json`。两者均无 key 时，首次需要
Jev 的正常用户请求会打开**阻塞式**输入框：填写前不调用
Jev，也不向聊天模型发送本次任务。终端输入显示为掩码；RPC 使用原生输入
协议，显示方式由客户端决定。留空会继续要求填写；取消会取消本次任务。
填写后先保存用户凭据，再自动继续原任务；扩展重载或退出后仍可读取。
该值不写入环境变量、项目配置、聊天历史或诊断日志。退出只清理内存缓存。
无界面模式可读取已保存的 key；没有任何 key 时阻止本次任务。
采用官方 `@typesafe-ai/sdk@0.7.0`，请求一个批次，每个候选独立 Noul。
`TYPESAFE_BASE_URL` 仍可用；项目/用户配置的 `baseUrl` 优先于该环境变量。
模型默认显式指定 `jev-1.14.0`，
可通过两层配置的 `model` 或评测的 `--model` 覆盖；不会被 SDK 的
`TYPESAFE_DEFAULT_MODEL` 改成其他模型。扩展关闭 SDK 日志，避免意外输出聊天内容。

## 插件命令

输入 `/jev-skill` 或 `/jev-skill help` 查看用法。在 `/jev-skill` 后输入空格，
Pi 会显示二级命令补全及用途说明；输入 `api`、`base` 可过滤选项。

| 命令 | 用途与提示 |
| --- | --- |
| `/jev-skill apikey` | 打开掩码输入框，填写或更换 key；Enter 保存，Esc 保留原值 |
| `/jev-skill apikey reset` | 删除用户目录中的凭据及内存缓存；环境变量仍优先 |
| `/jev-skill baseurl` | 打开带地址示例的输入框；无效地址继续提示，Esc 保留原值 |
| `/jev-skill baseurl https://api.typesafe.ai` | 设置当前项目的 Jev API 根地址，下一次路由生效 |
| `/jev-skill baseurl reset` | 移除项目地址，恢复用户配置、环境变量或默认地址 |
| `/jev-skill status` | 显示 key 是否已配置及来源、地址、模型和最近路由结果 |
| `/jev-skill help` | 显示二级命令用法 |

`apikey` 在弹窗中填写，不接收明文命令参数。提交后保存到用户目录的专用文件；
若已有 `TYPESAFE_API_KEY`，该环境变量仍优先，保存后会明确提示。
不会自动把环境变量中的 key 复制到文件。取消、弹窗失败或保存失败时保留原值。
配置修改要求当前任务已结束；帮助和状态可随时查看。命令不会调用模型或写入聊天历史。
RPC 使用原生输入协议，输入框是否掩码由客户端决定。

凭据文件路径为 `~/.jev-skill-router/credentials.json`，Windows 通常是
`C:\Users\<用户名>\.jev-skill-router\credentials.json`。
`/jev-skill status` 会显示实际绝对路径和当前凭据来源，不显示 key。
Windows 使用当前用户 DPAPI 加密文件中的 key；依赖系统 Windows PowerShell，
调用使用隐藏进程和标准输入，不把 key 放入命令参数。Linux/macOS 使用
`0700` 目录和 `0600` 文件保存明文凭据；本轮运行验证在 Windows 上完成。
文件原子替换，重置只删除该凭据文件。文件损坏或无法解密时可重新填写修复；
无 UI 或无法保存时阻止当前任务，不会回退继续调用模型。

`baseurl` 只修改当前项目 `.pi/skill-router.json` 的 `baseUrl`，保留其他字段；
已有 JSON 无效或无法写入时报告失败。地址接受 HTTP(S) 根地址及网关路径前缀，
不接受内嵌账户、密码、查询参数或片段。SDK 会附加 `/v1/systemone`，无需手填该后缀。
Base URL 是 Jev 服务地址；它不会配置系统 HTTP 代理。

## 配置

用户级：Pi agent 目录下的 `skill-router.json`，通常是
`~/.pi/agent/skill-router.json`，遵循 Pi 的 `PI_CODING_AGENT_DIR`。
项目级：`<cwd>/.pi/skill-router.json`。每轮重新读取；普通参数项目优先，
固定路径取两层并集。相对路径以各自配置文件的目录为基准，支持 `~/`。
`baseUrl` 为可选字段；读取顺序为项目 > 用户 > `TYPESAFE_BASE_URL` >
`https://api.typesafe.ai`。删除项目字段不会删除用户配置。

```json
{
  "historyMaxTurns": 3,
  "historyMaxChars": 8000,
  "maxAutoSkills": 5,
  "autoMetadataMaxChars": 4000,
  "pinnedSkillPaths": ["./skills/my-skill/SKILL.md"],
  "minProbability": 0.65,
  "routeTimeoutMs": 3000,
  "model": "jev-1.14.0",
  "baseUrl": "https://api.typesafe.ai"
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

默认参数是试验初值，并非实测最优值。模型按用户要求固定为 `jev-1.14.0`；
修改 `model` 可以切换版本。每轮仍记录服务实际返回的模型版本和 token usage。

## 故障与诊断

`/jev-skill status` 查看配置及最近结果，旧命令 `/skill-router-status` 保持可用。
Pi 会话的 `jev-skill-router` 自定义条目
记录状态、原因、候选数、选择数、耗时、实际模型和 token usage，不记录
原始聊天或 key。TUI 状态栏显示选择数量及模型；故障另有明确通知。

- 全部低于阈值：正常成功，自动目录为空，保留固定项。
- 缺 key：等待用户填写并保存；取消、无 UI、弹窗或落盘错误时记录 `blocked/missing_key`，
  取消当前任务，绝不把全目录交给聊天模型继续。无自动候选、自动预算为 0
  或配置校验已失败时，不进入 Jev 凭据填写流程。CLI 的 `eval --live` 缺 key
  仍直接报错退出。等待人输入的时间不计入 3 秒网络 deadline。
- 已提供 key 后的鉴权失败、限流、服务错误、输入拒绝、无效响应、超时：回退原始
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

## 评测与分发

`npm run verify:package` 构建并生成 `outputs/jev-skill-router-0.1.0.tgz`，
检查包内文件，并用真正的 Pi loader 加载打包后的 ESM 入口。不调用线上 API。
`dist/`、tarball 和本地报告均不进入 Git；npm 包仅包含构建产物和交付文档。

```powershell
npm run eval
npm run eval -- --live --output outputs/evaluation.json
```

第一条只预览 8 个合成 metadata 用例，不联网。第二条使用环境中的 Jev key
运行至多 8 次真实请求，每次默认 3 秒且不重试；遇到永久 HTTP 4xx 提前停止。
任何回退使评测返回非零退出码。报告按请求逐次保存，支持 `--repeat 1..20`、
`--model`、`--threshold` 和 `--timeout-ms`，可用于比较阈值或重复采样。

报告记录必需技能召回、误选、零命中、实际模型、token usage 和 p50/p95。
不把全量回退当成命中；费用、缓存、任务完成率缺少证据时标为 `null`。
同时提供 `--input-usd-per-million`、`--output-usd-per-million` 且 usage
完整时，可得到基于操作者输入价格的费用估算。

**2026-10-18 实测状态：** 本地功能检查与打包加载已验证。沙盒外未明确指定
代理时遇到 HTTP 451；显式通过 `http://127.0.0.1:7688` 后，真实模型
`jev-1.14.0` 成功完成全部 8 个合成用例，无回退、无误选，必需技能召回 8/8；
本次 p50 为 263.9 毫秒，p95 为 578.1 毫秒。

代理仅注入本次测试进程，扩展默认入口尚未配置为自动使用系统代理。
小样本结果不能代表真实目录或最优阈值；任务完成率、缓存和账单费用仍待验收。
[完整记录与临时代理复验方式](docs/verification.md)。
