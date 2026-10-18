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
当前有 37 项自动回归测试，新增凭据解析、终端掩码和真实 Pi UI 桥接用例：

- 人未提交 key 前，真实 Pi 会话不发出 Jev 或聊天 provider 请求。
- 填写后用官方 SDK 继续原任务，同一扩展后续请求不重复弹窗。
- 环境变量优先；临时输入仅保存在扩展内存，退出时清除，不修改进程环境。
- 空输入、空白或多行值继续要求填写；TUI 输入和粘贴均不明文渲染。
- 取消、无界面、弹窗异常及预检后凭据失效都阻止模型请求，不回退全目录继续。
- 测试检查实际聊天 HTTP payload、会话条目及发给 Jev 的 state 中没有 key。
- 人的等待时间不消耗网络 deadline；模拟弹窗跨过 deadline 后仍能正常路由。

这些新增测试使用虚拟 key 和本机服务，不调用线上模型。RPC 使用 Pi 原生
输入协议，是否掩码由客户端控制。CLI 评测无 UI，仍要求环境变量 key。

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
