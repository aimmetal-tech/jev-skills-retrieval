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

Pi OpenAI 适配层可把结构化 prompt 更新折叠为首条 system message；测试直接
检查发送后的结果。Pi 会话原始历史中的 metadata 或正文不承诺清除。

## 真实 Jev 评测的阻塞

执行了 `npm run eval -- --live`：8 个合成 metadata 用例全部发生服务回退。
追加的一次最小官方 SDK 诊断确认服务返回 `APIError`、HTTP **451**。
没有获得有效 Jev 回答、实际模型版本或 token usage，随后停止线上请求。

本地原始结果在 `outputs/evaluation.json`，故障状态确认在
`outputs/jev-network-diagnostic.json`。这些文件不进入 Git 或 npm 包。
后续评测工具已支持显示 HTTP 状态码、遇到永久 HTTP 4xx 提前停止，并在
有任何回退时返回非零退出码。旧报告来自改进诊断之前，因此只有通用故障码。

这批失败结果不能用于评估模型准确率、校准 0.65 阈值或证明正常请求的
p50/p95 延迟。任务完成率、真实目录召回、缓存表现和实际账单费用均未验证。
保留 SDK 默认模型，未锁定一个未经校准的服务模型版本。

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

服务可用后，运行 `npm run eval -- --live --output outputs/evaluation.json`。
默认至多 8 次请求，每次 3 秒且无重试；`--repeat` 可做更多采样。
这是合成 metadata 路由集，仍需用真实 catalog 和任务执行结果进一步验收。

费用默认未知；只有同时提供 `--input-usd-per-million` 与
`--output-usd-per-million`、且全部 usage 完整时才计算估算费用。
输入价格由操作者提供；不内置可能过期的服务定价。
