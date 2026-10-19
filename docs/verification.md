# 首版验收记录

日期：2026-10-18。兼容对象为官方 npm 包 `@earendil-works/pi-coding-agent@1.3.0`，
Jev SDK 为 `@typesafe-ai/sdk@0.7.0`。不扩展声明其他版本的兼容性。

## 已覆盖的行为

`npm run check` 包含严格类型检查、Biome、核心/集成测试及生产构建。
集成测试使用 Pi 原生技能发现、真正的会话循环和本机 OpenAI 协议 HTTP 服务，
在服务端检查最终 provider payload；未使用线上模型。

- 选择项和固定项出现在最终 metadata，未选项被排除；真实 `read` 工具续跑
  保持本轮目录且只查询一次选择器。
- `/skill:name` 的原始命令进入 Jev state，正文由 Pi 原生加载；磁盘标记不变。
- 下一轮由 A 换 B；聊天历史只含原始用户文本、助手可见回复和上轮 metadata。
- 成功零命中与故障回退不同；有效固定项在异常路径仍保留。
- 同名异路径的身份、阈值边界、确定性排序、原生 XML 字符预算和配置层级。
- 超时与取消、无效响应、缺 key、鉴权失败、限流、输入拒绝及 HTTP 451。
- 总 deadline 覆盖永不完成的 evaluator 和永不结束的 SDK 响应正文。
- 其他扩展强制覆盖 systemPrompt 时报告冲突；已有历史会话重载明确跳过。
- 官方 SDK 与真实 Pi provider 的组合路径通过离线集成测试。
- 评测统计不会把回退全量目录算成命中，也不会把未知费用标成零费用。

## 阻塞式凭据输入

按用户后续要求，缺 key 的 Pi 行为由“提示后回退”改为“阻塞填写”。
凭据解析、终端掩码和真实 Pi UI 桥接用例覆盖以下行为：

- 人未提交 key 前，真实 Pi 会话不发出 Jev 或聊天 provider 请求。
- 填写后用官方 SDK 继续原任务，同一扩展后续请求不重复弹窗。
- 环境变量优先；输入保存到用户凭据文件，退出只清理缓存，不修改进程环境。
- 空输入、空白或多行值继续要求填写；TUI 输入和粘贴均不明文渲染。
- 取消、无界面、弹窗异常及预检后凭据失效都阻止模型请求，不回退全目录继续。
- 测试检查实际聊天 HTTP payload、会话条目及发给 Jev 的 state 中没有 key。
- 人的等待时间不消耗网络 deadline；模拟弹窗跨过 deadline 后仍能正常路由。

这些新增测试使用虚拟 key 和本机服务，不调用线上模型。RPC 使用 Pi 原生
输入协议，是否掩码由客户端控制。CLI 评测无 UI，仍要求环境变量 key。

## `/jev-skill` 配置命令

新增插件根命令和 `apikey`、`baseurl`、`status`、`help` 二级命令。
真实 Pi loader 检查命令说明、参数补全、前缀过滤和 `baseurl reset` 提示。
命令最初交付时共 49 项测试；增加持久化后当前共 57 项。

- 根命令、帮助、状态、未知参数、设置 key/地址均不触发模型请求，不进入聊天历史。
- `apikey` 使用掩码弹窗，可更换用户文件中的 key；取消保留原值，后续 SDK 请求使用正确凭据。
- key 仍优先读取环境变量；状态和成功消息不显示 key，明文 key 参数会被拒绝。
- `baseurl` 支持参数和弹窗输入，空白/无效输入会继续提示；重置后恢复用户地址。
- 测试检查 SDK 请求的实际 URL，包含网关路径前缀和 SDK 追加的 `/v1/systemone`。
- 地址保存保留其他 JSON 字段；无效 URL、损坏的 JSON、弹窗异常不覆盖原配置。
- 取消 Base URL 修改保留原文件；任务运行中拒绝配置修改，无 UI 时仍可显式传入地址。
- 用户/项目 `baseUrl` 配置完成校验，优先于 `TYPESAFE_BASE_URL`；无配置使用官方根地址。
- 打包验证也检查 `/jev-skill` 注册和 `apikey` 参数补全，未调用线上 API。

命令文档来自 [Pi 1.3.0 扩展 API](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md)
及 [官方命令示例](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/examples/extensions/commands.ts)。
SDK 地址约定依据 [TypeSafeClientConfig](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig)。

## 用户目录凭据持久化

按用户后续授权，替换原先的“仅内存”方案：`/jev-skill apikey` 和缺 key 时的
自动弹窗都保存到 `~/.jev-skill-router/credentials.json`。
优先级为 `TYPESAFE_API_KEY` > 用户文件；不自动复制环境变量到文件。
`/jev-skill apikey reset` 删除文件与缓存；`status` 显示路径和来源。

本轮新增 8 项测试，完整检查共 57 项通过：

- 真实 Windows DPAPI 加密/解密，磁盘 JSON 不含虚拟 key 的明文；支持 Unicode 输入。
- 用户文件通过新 store 和新的真实 Pi 扩展实例继续读取，无 UI 也能执行后续任务。
- 原子更新不残留临时文件；取消、无效输入和保存失败保留旧凭据。
- 删除文件后不再复用缓存；环境变量可绕过损坏的文件，且始终优先。
- 损坏 JSON、格式版本不符和无法解密均使用脱敏错误；可通过交互填写修复。
- 保存失败时真实 Pi 不发送 Jev 或聊天 provider 请求，错误与会话记录中没有 key。
- 现有测试使用可注入的内存 store，新文件测试使用临时假主目录；不触碰真实用户凭据。

Windows DPAPI 使用当前用户范围，依据 [.NET 数据保护文档](https://github.com/dotnet/docs/blob/main/docs/standard/security/how-to-use-data-protection.md)。
Windows 的文件模式不提供 Unix 所有者隔离，见 [Node.js 文件权限说明](https://github.com/nodejs/node/blob/main/doc/api/fs.md)。
Linux/macOS 分支采用 0700 目录和 0600 明文文件，本轮未在这两个系统运行。
CLI `eval --live` 仍只读取环境变量；本节的保存文件读取适用于 Pi 扩展。

Pi OpenAI 适配层可把结构化 prompt 更新折叠为首条 system message；测试直接
检查发送后的结果。Pi 会话原始历史中的 metadata 或正文不承诺清除。

## HTTP 451 与显式代理复验

执行了 `npm run eval -- --live`：8 个合成 metadata 用例全部发生服务回退。
追加的一次最小官方 SDK 诊断确认服务返回 `APIError`、HTTP **451**。
当时没有获得有效 Jev 回答、实际模型版本或 token usage，随后停止线上请求。

本地原始结果在 `outputs/evaluation.json`，故障状态确认在
`outputs/jev-network-diagnostic.json`。这些文件不进入 Git 或 npm 包。
后续评测工具已支持显示 HTTP 状态码、遇到永久 HTTP 4xx 提前停止，并在
有任何回退时返回非零退出码。旧报告来自改进诊断之前，因此只有通用故障码。

随后按用户要求，在沙盒外用 Undici `ProxyAgent` 显式指定
`http://127.0.0.1:7688`。每个请求都绑定该 dispatcher，不回落直连。
最小真实推理成功，模型为 `jev-1.13.0`，耗时约 318 毫秒。
同一代理下补跑 8 个合成 metadata 用例，全部成功，无回退：

| 指标 | 本次观测 |
|---|---|
| 实际模型 | jev-1.13.0 |
| 必需技能召回 | 8/8 |
| 误选数量 | 0 |
| 零命中用例 | 正确返回空自动目录 |
| p50 / p95 | 265.9 / 644.7 毫秒 |
| 输入 / 输出 token | 6319 / 4680 |

代理最小验证保存在 `outputs/proxy-7688-probe.json`，本次完整评测保存在
`outputs/evaluation-proxy-7688.json`，与先前失败报告分开保留。
匿名模型目录请求仍返回 403；上述成功证据来自携带环境凭据的真实推理请求。

先前的沙盒外运行没有保证 Node fetch 使用系统代理。显式指定该代理后，
本次真实推理不再受到 451 阻塞。当前验证仅为测试进程注入代理，**没有修改
扩展默认入口的代理行为，也没有写入系统代理设置**。

上述结果是最初使用 SDK 默认模型的观测。随后按用户要求，默认模型改为
显式 `jev-1.14.0`。通过同一 7688 代理再次运行 8 个用例，实际返回模型
均为 `jev-1.14.0`，全部成功，无回退、无误选，必需技能召回为 8/8。
本次 p50 / p95 为 263.9 / 578.1 毫秒，输入 / 输出 token 为 6319 / 4680。
新报告保存在 `outputs/evaluation-jev-1.14.0-proxy-7688.json`，旧版本报告保留。

扩展配置与评测共享这个默认值；两层 `model` 配置与评测 `--model` 可以
显式覆盖。默认请求会携带模型版本，不受 SDK 模型别名或环境默认值漂移影响。
离线测试检查实际 SDK 序列化的 model 字段，以及服务返回版本的独立记录。

这些小样本不能代表真实目录的广泛准确率，也不足以确定最优阈值、稳定延迟
分位数或两版本的速度差异。阈值暂时保留 0.65；任务完成率、真实目录召回、
缓存表现和实际账单费用仍未验证。

临时代理评测的执行方式如下；仅影响当前 Node 进程：

```powershell
node --import tsx --input-type=module -e '
import { ProxyAgent, fetch } from "undici";
const agent = new ProxyAgent("http://127.0.0.1:7688");
globalThis.fetch = (url, init = {}) => fetch(url, { ...init, dispatcher: agent });
process.argv = [process.execPath, "--live", "--output", "outputs/evaluation-jev-1.14.0-proxy-7688.json"];
try { await import("./eval/run.ts"); }
finally { await agent.destroy(); }
'
```

这里使用项目已安装的 Undici 进行诊断；它不是本包直接声明的运行依赖。
正式提供代理配置时，仍应显式声明依赖并验证取消与超时行为。

## 复验

```powershell
npm ci
npm run check
npm run verify:package
npm run eval
```

`verify:package` 生成 `outputs/jev-skill-router-0.1.0.tgz`，检查包内容，
再提取到本项目 `.tmp/` 并交给真正的 Pi loader 加载编译后的 ESM 入口。
临时提取目录随后删除。此步骤不调用 Jev，也不写用户 Pi 设置。

网络出口可用时，运行 `npm run eval -- --live --output outputs/evaluation.json`。
默认至多 8 次请求，每次 3 秒且无重试；`--repeat` 可做更多采样。
这是合成 metadata 路由集，仍需用真实 catalog 和任务执行结果进一步验收。

费用默认未知；只有同时提供 `--input-usd-per-million` 与
`--output-usd-per-million`、且全部 usage 完整时才计算估算费用。
输入价格由操作者提供；不内置可能过期的服务定价。

## 全量公开 Pi benchmark 准备（2026-10-18）

用户确认采用完整 SkillRet v1.1 测试划分和 SkillsBench v1.1 标准任务，
原生 Pi Skills 对比启用插件；当前只完成准备与离线验证，真实调用预算另定。
插件 `src/` 未改动，固定默认 Jev 1.14、3 秒、最多 5 项，不做分批或预筛选。

- SkillRet 固定 `a050ad233a504a43135bafe8cdf45574052b5729`，已下载并核验
  6,006 skills、4,392 queries、7,187 qrels。使用 Pi 原生发现加载全部 6,006 项，
  205 个重名额外项由稳定 ID 后缀消歧，映射与哈希存于本机 outputs。
- SkillsBench 任务归档固定 `55bfe693f2a19f6b2f29aca3f54fe98b9d994668`，
  registry 单独固定 `b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af`；
  归档内旧 registry 不能代替后续修正的 v1.1 清单。
- BenchFlow 0.6.3 的官方摘要函数验证了 **86/87** 个完整任务。
  `fix-druid-loophole-cve/verifier/test_outputs.py` 被安全中心删除，
  用户提供告警 ID `A9E32DDD4DA1FF17`。静态阅读官方固定文件确认其含
  CVE-2021-25646 主动利用回归载荷；未发现该文件中的自复制、持久化、
  硬编码外部收集地址，但未据此认定 AV 误报或保证安全。
  所读官方文件 SHA-256 为
  `786bb1be0a1e81c49e005ea2b2af725cdb69804500be4ba389fde59e175479ce`。
  未恢复该文件，未执行该安全任务、oracle 或 verifier。
- `npm run benchmark:preflight` 写出审计报告后因一项 security_blocked 返回非零
  （程序退出码 2）；这不是完整数据通过的结论。完整 SkillsBench live 启动也会
  在模型请求前停止，原始 87 项分母保留。
- `npm run check`：63 个测试、TypeScript、Biome 和生产构建通过。
  新增 6 个测试通过真实 Pi 的回环 HTTP 请求边界验证两组提示、技能读取、
  Pi/Jev Token、硬请求上限、未知 usage 和不可读取 qrels。
- `npm run benchmark:check`：Ruff 检查、格式检查及 6 个 Python 回归测试通过。
  覆盖重新准备时不释放隔离文件、归档目录穿越、完整清单、Windows/POSIX 权限路径验证，
  以及 verifier 异常时保留已产生的模型 usage、合法部分得分不误报 verifier error。
- `npm run benchmark:verify`：无害 Docker 答案夹具在两组均完成
  Pi -> sandbox read/bash -> 官方 `rollout.verify()` 的闭环。
  使用本地假模型/假 Jev 与假 key，没有真实 API 调用。
  MOCK 证据与图表位于 `outputs/benchmark/verification/`，
  不能当作 `openai-gpt-6-luna` 的真实性能、成本或插件提升证据。
- Windows 下固定 BenchFlow 有容器路径误用宿主 Path/normpath 的问题；
  harness 仅在内存重绑定相应纯路径函数，保留非 root agent 与原始路径保护，
  不修改官方任务/verifier 或已安装包；Docker 夹具验证了该接口衔接。

执行模型仍固定为 `openai-gpt-6-luna`；只读模型列表检查未列出该精确 ID，
实际生成和工具调用能力尚未确认。Pi 内置同名 classifier 不作为执行模型替代。
未请求真实模型、未生成真实性能结果、未估算未知代理账单。

复现和预算/续跑/报告命令见 [benchmark/README.md](../benchmark/README.md)。
原始官方任务、依赖环境、包与图表全部留在忽略的 outputs 下，不进入提交。

## 方案 A 与分段超时（2026-10-18，后续实测）

用户已授权真实调用，并纠正执行模型为 Pi 已登录的 `(openai) gpt-6-luna`、
OAuth、medium。原生账户工具预检成功，首轮真实 SkillRet 运行已产生模型 usage。
该运行因连续路由超时被停止，不能当作完整 benchmark 或插件提升证据。
此前关于模型不可用、预算待定、src 未变的描述是初始准备阶段记录。

本轮按用户要求实施方案 A：单次请求的规范路径身份、去重目录、固定项、候选和
成功/失败合并共享快照；每个新请求重新生成，不跨请求缓存，也不预筛选或分批。
取消先于本地解析检查，空固定项不构造路径索引。

- 原始代码离线诊断：完整 6,006 项共访问真实路径 54,054 次，本地流程约 14.21 秒，
  未进入 evaluator。证据：`outputs/benchmark/diagnostics/local-routing/profile.json`。
- 修复后离线诊断：真实路径访问 6,006 次，完整本地流程约 1.95 秒，进入无网络夹具。
  证据：`outputs/benchmark/diagnostics/solution-a-offline/result.json`。
  两次是单次开发诊断，不能作为统计性能或正确率结论。
- 保持 3 秒总上限的真实诊断：已发出 1 次 Jev HTTP 请求，本地准备约 1.26 秒，
  剩余评估约 1.75 秒耗尽，触发 timeout。证据：`solution-a-live-3s/result.json`。
- 放宽到 15 秒后：一次 HTTP 请求返回 **400**，约 4.82 秒结束；不再是超时。
  新默认为准备 5 秒、评估 10 秒、总上限 15 秒；旧 `routeTimeoutMs` 仍为总上限。
  分段默认验证约 6.40 秒返回 400，原因由现有分类器记为 `input_limit`。
  证据：`solution-a-live-15s/result.json`、`solution-a-split-defaults/result.json`。
- 后续检查仅 47 字节的拒绝说明，明确返回 `detail.error_type=max_tokens_exceeded`。
  早期摘要器漏读 `error_type`，因此其 `unclassified` 不表示服务未给出原因。
  已在正式 SDK 错误处理白名单中保留该错误码，不转发任意服务器错误字段。
  证据：`http-400-inspection/result.json` 及同次操作的脱敏控制台说明；
  额外核验记录为 `http-400-confirmed.json`，未保存原始错误正文。
- 用户指定的本地 TypeSafe Skill 要求读取实时文档，已通过官方
  [API 错误表](https://docs.typesafe.ai/api#errors) 及
  [模型限制](https://docs.typesafe.ai/models#context-length) 核实：Jev 1.14 默认
  每请求 64k、state 加任一问题 32k Token；没有独立问题数量上限。
  可用专用长上下文请求头将两者扩到 262k，但官方说明更慢且准确率较低。
  该头未启用。分批/预筛选也未实施，以免改变已确认的单批全候选设计。
- 数据统计：技能名称/描述共 1,416,271 字符，重复判断说明共 1,189,188 字符；
  第一条查询 734 字符，最长技能描述 2,472 字符。
  字符数不是实际 Token 数；不能由此声称精确 Token 用量或长上下文一定足够。
- 本轮总计 6 次真实 Jev 请求，无 Pi 聊天生成；失败调用 Token/费用未知。
  正式全量任务没有重启，不能据此给出检索正确率、任务成功率或 Token 提升。
- `npm run check`：71 项测试、TypeScript、Biome 和构建通过；
  `npm run verify:package`：37 文件的包由真正的 Pi 1.3.0 加载成功。
  新回归覆盖 6,006 路径只解析一次、路径别名/固定克隆、跨请求路径变更、
  三种超时归因、同步 SDK 超限、取消、已知失败 usage 保留，以及 SDK 服务错误白名单。

复现：`npx tsx benchmark/diagnose-routing.ts --output diagnostics/new-local`；
加 `--live` 最多调用一次真实 Jev，不启动 Pi 模型。超时参数见 benchmark/README.md。
所有相对证据路径以 `outputs/benchmark/diagnostics/` 为根目录。

## 全量串行分批实现与真实 Jev 验证（2026-10-18）

用户授权实施全量分批并降低并发。现在固定**并发 1**，每批结算后默认等待 1 秒；
保持原始 Noul 文案、全候选覆盖、稳定 ID、阈值 0.65、Top 5 和 4,000 字符预算。
不启用长上下文、预筛选、自动二分或重试。所有批次成功后才进行全局选择。
任意批次失败明确回退，缺 key 和用户取消仍保留原阻塞/取消行为。

`src/batching.ts` 负责完整装包、串行调度、批次/整轮取消、评分集合校验及安全证据。
SDK 共享请求构造器用于精确测量压缩前 JSON 的 UTF-8 字节；默认每批 48,000、
state 加单题 24,000 字节，最多 128 批。这是工程保护，并非已经验证的 Jev Token 上界。
当前账户的 TPS/RPS 未读取；串行和间隔不能保证所有负载都不会限流。

benchmark 使用独立 `profile.ts`（评估 590 秒、总路由 600 秒），日常默认保持
评估 10 秒、总计 15 秒。CLI 提供的任务时限始终生效，大目录需要显式留出 Pi 时间。
逐批 attempt 回调在下一批前记账和落盘，整轮报告不重复累加。HTTP 上限仍在 fetch
之前执行；已知部分 usage 不丢弃，未知 usage 或永久 HTTP 错误仍停止后续流量。

验证结果：

- `npm run check`：78 项测试、TypeScript、Biome 和生产构建通过。
  新增测试覆盖全 6,006 项的精确装包与覆盖、SDK 串行/间隔/记账顺序、全局选择、
  失败及未知用量、模型不一致、批次/阶段/总时限、SDK 超时归因和取消。
  真实 Pi 回环 HTTP 边界验证分批 usage 不重复统计，以及预算/未知 usage 停止后续调用。
- `npm run verify:package`：40 文件的包由 Pi 1.3.0 真正加载，未调用模型。
- 离线完整目录：75/75 批、6,006/6,006 项完成，规范路径解析 6,006 次，
  实际 HTTP=0。零值 usage 是标记明确的夹具，不是模型成本或效果证据。
  证据：`outputs/benchmark/diagnostics/serial-batches-offline/result.json`。
- 真实完整目录单查询：75/75 次串行 HTTP 调用成功，6,006 项评分齐全，
  所有返回模型均为 `jev-1.14.0`，全局选出 5 项；没有 Token 超限、429 或超时。
  总路由时间 **101,107.0603 ms**，最大批次压缩前 JSON **47,999 字节**。
  实际 usage：输入 **607,463**、输出 **441,084**，合计 **1,048,547** Token，usage 完整。
  证据：`outputs/benchmark/diagnostics/serial-batches-live-20261018/` 下
  `preparation.json`、`attempts.jsonl`、`partial.json`、`result.json`。
  成功诊断后仅补充了 SDK 提前超时的阶段归因，不改变装包、成功路径或实测参数。

真实调用只执行 Jev 路由，没有 Pi 聊天生成。这是一个查询的完整目录可行性证据，
不是 4,392 条查询的正确率、端到端任务通过率或 Token 节省结论；没有据此估算账单。
正式运行仍需独立新目录、按完整查询计划重新核算 HTTP 保护参数及任务时限。
SkillsBench 的既有安全隔离不受本次改动影响，仍保留原始 87 任务分母。

## 持久化 SkillRet 测试与独立重测（2026-10-18）

用户要求使用 psmux，随后明确“不要恢复，直接重测”和“新旧结果分开”。
本轮实现检查点协议 2，但启动器默认始终要求新目录、新会话，从首个查询开始。
旧运行 `outputs/benchmark/runs/skillret-full-serial-20261018-223527` 不导入、不迁移。
新运行通过 `psmux-session.json`、`run-start-*.json` 记录 fresh 标记与独立进程。

请求发送前持久化预留，响应完整落盘后再交给 SDK；记录实际尝试次数与已知/未知 usage。
成功真实响应保存语义哈希与正文 SHA，未来恢复时可重建 fresh Pi 内存状态和 Jev 评分，
不重发已完成 HTTP、不重复计费。遗留 pending 记为未知；不保存认证头、cookie 或 OAuth 密钥。
这是 SkillRet 只读任务机制，未声称支持 SkillsBench 容器变更重放。

用户明确选择“记录未知用量后有限退避重试”。持久化测试支持显式
`--continue-unknown-usage`，仅 429/529/网络异常最多额外 3 次，退避 5/15/30 秒。
未知成本不因后续成功而清除，总 Token 与每成功任务 Token 仍未知，另报已知小计。
Jev 每实际尝试仍 10 秒、串行、间隔 1 秒；逻辑批次 120 秒容纳退避。
590 秒评估/600 秒总路由及 CLI 720 秒任务上限保持明确。生产插件没有增加重试。

验证：

- `npm run check`：85/85 测试、TypeScript、Biome 和生产构建通过。
  首次全套出现两个 Pi 回环连接失败；独立复核 24/24、随后完整复核 85/85 通过。
- 新检查点测试覆盖真实响应保存/重放、529 未知计费及重启、重试耗尽跨重启保留、
  缓存与 reasoning 不重复计数、断裂日志尾部修复，以及并发写入互斥。
- Pi 实际 HTTP 边界测试以回环假服务验证 durable Responses/Completions 和 Jev 记账。
  这些测试不是公开 benchmark 的真实模型成绩。
- `npm run verify:package`：40 文件由真正 Pi 1.3.0 加载，无真实模型调用。
- PowerShell 解析器验证 `benchmark/psmux.ps1` 无语法错误。
- psmux 3.4.0 的无害 detached fixture 在启动 shell 结束后仍能 capture-pane/list-panes；
  夹具已单独清理。该验证不等于公开模型测试已经启动。

psmux 仅保护终端断开，机器重启后仍需从本轮检查点恢复。Windows 使用原生命名 mutex
排除双写，崩溃锁记录在取得 mutex 后归档。完整损坏的结果记录不会静默删除。
使用方法和实际输出路径规范见 `benchmark/README.md`；SkillsBench 安全阻断仍保留。

首次 psmux 新运行 `skillret-retest-v2-20261018-233900` 已中断并独立保留。
该轮出现保存的 HTTP 200 正文可离线解析、但 trial/provider 和路由异常的情况。
排查以无害临时文件确定复现了 Windows 读者占用导致 rename EPERM 的失败路径；
原运行未保存原始本地异常，不能将这项复现称为已证实的唯一原因。
原子替换现对 Windows 短暂占用最多等待 2 秒，持久写入/观测回调失败则停止后续 HTTP，
防止把本地落盘失败持续计作模型失败。修复后 `npm run check` 86/86、类型/Lint/构建通过。
异常轮不恢复、不并入修复后的新一轮结果。原 22:35 旧运行证据哈希未改变。

## 双会话并行协议 3（2026-10-19）

用户经过Q1–Q13确认：每组独立3/5任务池，Pi峰值6/10；先80个真实校准trial，
合格5档吞吐至少提高20%才选5，否则合格3档；达标后自动开启独立新全量。
旧451条运行保持停止，不导入校准或正式结果。此前代码b113211已归档，SHA256：
`E80B933B13F35B0173A34FDDBC5FF459D68352E47B25FFA9B2617147F6560E19`。

新实现使用本地IPC协调器的fsync事件账本，共享成本/冷却、每组分别限流，
每请求首次+5次指数退避。超时、未知成本、暂停和人工恢复周期不被普通重启清除。
真实Pi回环假服务验证六个隔离会话、Pi同时在途6、Jev最多3、medium、read续轮及usage。
核心回归覆盖跨客户端总预算、服务冷却作用域、六次耗尽/人工新轮、响应回放/输入不符、
分离计时、journal重启与断尾、固定抽样及20%选档规则。这些回归不是真实模型成绩。

执行与恢复命令、阶段目录和校准口径见 `benchmark/README.md`。正式模型验证结果另记
在本轮独立outputs下，源码和本文不伪造校准已经完成或提前选定正式并发档位。

实现冻结前验证：`npm run check` 94/94、TypeScript、Biome、生产构建通过；
`npm run verify:package` 40文件由真实Pi加载，无真实模型调用；两个PowerShell启动脚本
通过语法解析。六会话假服务测试用请求屏障确证Pi同时在途峰值6，而不是只检查任务数组。
当前机器磁盘可用空间约1.28TB（本机读数），可以保存本轮独立请求证据。

首次并行启动在真实请求前停止：预检错误使用refreshOnCreate:false，未恢复Pi本地模型目录。
官方Pi文档与安装源码确认getModel读取的是已恢复快照，空快照不能判断账户不可用。
改为默认离线refresh且allowModelNetwork:false，与原正常benchmark路径一致。
该启动目录无模型请求，独立保留，不复用为修复后的新校准结果。

### 已完成真实校准并自动启动全量

独立根目录：`outputs/benchmark/parallel/per-group-20261019-104926/`。
冻结代码bb2391e，源归档SHA256为
`2e99ecda378f1c4762bb446fb28c8a4b980c4ee1af34fcf5a1c0e236445dfb8f`。

| 每组并发 | trial | 阶段历时 | 吞吐/trial每小时 | HTTP尝试 | 已知Token |
|---|---:|---:|---:|---:|---:|
| 3 | 40/40 | 909996ms | 158.2425 | 1658 | 83703170 |
| 5 | 40/40 | 527092ms | 273.1971 | 1645 | 81206977 |

共80个真实trial、3303次HTTP，两个阶段均无429/529、熔断、未知用量、恢复或本地响应重放。
Pi实际返回模型均为gpt-6-luna，OAuth/Responses/medium保持一致；Jev均为jev-1.14.0，
每档20条插件查询均完成6006候选的全量评分。观测准入峰值为Pi6/Jev3及Pi10/Jev5。
5档整体吞吐提高72.6446%，满足已冻结20%规则，因此自动选择每组5并在full-5/开始8784条新全量。

这是容量校准，不是完整准确率结论。3档包含首次worker加载，两个档位先后运行，
缓存读Token分别39158528/40654080；启动、缓存与服务波动未完全控制，不把吞吐差异全部归因于并发。
本轮完整证据为根selection.json、calibration-verification.json、各阶段coordinator.jsonl与reports。
额外导出根calibration-throughput.png/.svg，不与正式原生/插件对比图混淆。

新全量首批出现一次Jev无HTTP状态的传输/中断失败，第二次尝试HTTP200且usage完整，
原失败用量仍未知并保留，不因重试成功归零。正式轮当时继续运行、没有熔断；
后续状态应读取实时pipeline.json与full-5/progress.json，不能把本次启动验收当作全量完成。
旧三个运行的results.jsonl哈希再次核对，全部未变，记录见isolation-verification.json。

### 同轮保护与续跑修复（2026-10-19）

用户明确要求修复并继续两组，已完成查询不得重测。修复前保存本轮586条已完成查询的
结果/partial哈希与11303次预留账本边界，位于 `before-fix-preservation.json`。
轮数超限曾被后续abort错误覆盖为provider_error，进而全局暂停Pi；Jev准入又将共享Pi
暂停误标service:jev。临时串行恢复脚本将暂停作为未捕获异常退出，因而未完成自动交接。

正式worker现在保留turn_limit，预算/时间/上下文保护只暂停单项，真实服务暂停保留来源。
本地IPC独立提升到60秒，回放主动让出I/O；生产Jev和Pi HTTP超时、重试和推理配置不变。
显式源码升级入口停止旧进程后备份manifest，记录新旧哈希/提交；原检查点身份和已完成结果
不变，新源码另用runtimeFingerprint校验。常规恢复仍拒绝指纹不匹配；升级不导入其他运行。
正式worker负责后续持久暂停与恢复，临时恢复/交接脚本不再使用。

新增真实Pi假服务回归验证轮数超限后不再发HTTP且保留budget/turn_limit；IPC测试验证
独立截止与取消；协调器测试验证局部保护、跨服务暂停来源、已完成任务不可重排，以及
停止后仅重新排队可恢复中断。升级回归验证检查点身份保留、源文件/预算变化拒绝和备份。
完整 `npm run check` 的98项测试、类型、Lint和构建通过；真实续跑验收另存本轮outputs。
