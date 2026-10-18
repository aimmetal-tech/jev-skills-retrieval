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
