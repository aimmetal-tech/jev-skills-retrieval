# 开发与验证

## 环境与命令

Node.js >=22.19，Pi 兼容基线 1.3.0。使用锁定依赖，不提交 `node_modules/` 或 `dist/`。

| 命令 | 用途 | 是否调用模型 |
| --- | --- | --- |
| `npm ci` | 安装锁定依赖 | 否；需要包下载 |
| `npm run check` | TypeScript、Biome、测试、构建 | 否 |
| `npm run format` | 格式与 import 整理 | 否 |
| `npm run verify:package` | 打包并用真实 Pi loader 加载 | 否 |
| `npm run results:verify` | 重算 212 对公开精简结果 | 否 |
| `npm run eval` | 8 个合成用例的预览 | 否 |
| `npm run benchmark` | 预览报告 | 否 |
| `npm run benchmark:prepare` | 下载固定公开输入 | 否；需要网络 |
| `npm run benchmark:preflight` | 数据哈希与原生发现审计 | 否 |
| `npm run benchmark:check` | Python Ruff 与回归测试 | 否 |
| `npm run benchmark:verify` | 无害 Docker/Pi 假服务集成 | 否；需要 Docker |

Python 评测依赖在 `benchmark/requirements.txt` 锁定，环境位于忽略的 `outputs/benchmark/.venv/`，安装方法见[benchmark/README.md](../benchmark/README.md)。`--live`、parallel 启动器会调用真实服务，不能作为普通文档或打包检查顺带执行。当前冻结运行已停止，本次发布不恢复它。

`npm run verify:package` 在 `outputs/` 生成 `jev-skills-retrieval-0.1.0.tgz`，核对文件范围后提取到受检的唯一 `.tmp/` 子目录，再通过真实 Pi 1.3.0 loader 验证 ESM 入口、事件和命令注册。需要系统 `tar`；临时提取目录会清理。npm 文件白名单仅包含 `dist/`、README、LICENSE 和 `docs/configuration.md`，不会发布评测结果或开发 Skill。此命令不向 npm 发布。

## 验证应覆盖真实边界

修改技能选择或生命周期时，检查实际 Pi provider payload 和原生 read 工具续跑，不能只测试一个选择数组。测试使用临时本机 HTTP 服务；真实凭据和开发者 home 不应成为测试前提。凭据测试使用假 home/内存 store，覆盖取消、存储失败和损坏文件。

修改批处理时，覆盖 6,006 个身份完整性、真实 JSON 字节大小、串行和间隔、响应缺失/重复/混合失败、deadline 与取消。一次路由失败不能抹掉已经产生的 usage。

修改并行检查点时，覆盖单写者、实际 HTTP 预约/结算、响应重放、重启不重置重试、已完成查询不可再次调度，以及 Pi/Jev 暂停范围。区分任务 guard 与服务故障：任务时限或 turn limit 只暂停该任务；真实 Pi 故障影响两组，Jev 故障只影响插件组。IPC 的 60 秒本地截止与 Jev 10 秒/Pi 120 秒网络时限不能混用。

## 结果与恢复纪律

只有发出的真实 HTTP 才计实际尝试。语义完全匹配的本轮成功响应可以重放；重放不再收取模型 usage。未知用量保留未知，不能记零、按成功重试的已知用量替代，或将已知小计称为完整总量。缓存计一次，reasoning 是 output 的子集。

新实验使用新目录与独立身份；不得从旧实验导入结果。恢复已停止实验必须是当前任务明确要求，保留完成项、累计耗时、成本和重试次数。协议 3 最多首次加 5 次尝试，共 6 次；额外恢复轮和追加时间必须有明确操作记录。`coordinator.jsonl` 是权威日志，`results.jsonl` 是派生视图。终端 pane 活着不代表测试进程仍运行。

冻结证据只读不改：原始 tar、逐文件哈希、源码和数据版本留在本地 `outputs/benchmark/frozen/`。本次明确允许进入 Git 的例外是[212 对查询精选结果包](benchmarks/2026-10-19-skillret-paused-212/README.md)；它排除请求正文、模型响应、账户凭据、绝对本机路径及庞大的重复目录。

SkillsBench 的 `fix-druid-loophole-cve/verifier/test_outputs.py` 被安全软件隔离（ID `A9E32DDD4DA1FF17`）。文件含真实 CVE-2021-25646 回归载荷，不能直接断言误报。不得自动恢复、重新解压或执行；保留 87 项分母与 86 已核验、1 安全阻断状态。完整 SkillsBench live 在付费调用前停止。

## 提交与文档

完成一次功能闭环，处理失败路径、同步配置与文档、通过相关检查后及时提交。提交前检查 `git status --short`、`git diff`、`git diff --cached`，只暂存本轮文件。采用 Conventional Commits，例如 `fix(benchmark): preserve completed trials on resume`。受环境阻断的检查要明确记录，不得声称通过。

新增、删除、移动文件或改变职责、入口、数据流、命令、输出路径时，在同一修改中同步项目级 [AGENTS.md](../AGENTS.md) 的 ASCII Tree、Mermaid、命令或相关边界。README 保持用途、最短上手、关键结果和文档入口，细节更新到对应文档。

项目展示名和包名统一为 `jev-skills-retrieval`；[兼容标识](architecture.md#凭据与兼容)不能全局替换。开发经验 Skill 位于 [.agents/skills/jev-skills-retrieval-dev/SKILL.md](../.agents/skills/jev-skills-retrieval-dev/SKILL.md)。

## 发布分支

本轮保留现有提交历史，首次上传目标为远端 `dev`；`main` 留作后续稳定分支。推送前检查远端状态，不强推，不自动发布 npm。GitHub 保存源码、文档和精选结果；本地完整运行证据不上传。

2026-10-19 本轮交付验证：`npm run check` 的类型、Lint、98 项测试和构建通过；Python Ruff 与 6 项无网络回归测试通过；新包由 Pi 1.3.0 loader 加载成功。受限沙盒中的临时文件/DPAPI 测试曾失败，使用正常主机权限复验通过，没有据此修改生产实现。精选结果离线重算和相对链接检查通过，开发 Skill 格式校验通过。未启动线上模型或公开 CVE 任务。

2026-10-19 密钥粘贴修复：`npm run check` 的类型、Lint、103 项测试和构建通过；
`npm run verify:package` 确认 43 个文件的运行包由 Pi 1.3.0 loader 成功加载。
新增回归覆盖剪贴板快捷键、掩码编辑、取消后的异步结果、保存失败和 `apikey add` 的
持久化、无界面配置、环境变量优先级、忙碌拒绝及模型会话脱敏。
沙盒阻断本机假服务连接和文件替换后，使用正常主机权限完成复验。
剪贴板测试注入假文本；未读取开发者真实剪贴板或凭据，未调用线上模型。

2026-10-19 运行可见性：`npm run check` 的类型、Lint、110 项测试及构建通过；
`npm run verify:package` 确认 46 个文件的包由真实 Pi 1.3.0 loader 加载成功。
新增验证在真实 Pi/本机假 provider 边界比对 UI 与请求，覆盖常驻 widget、
凭据等待、批次进度、正常/零命中/关闭自动选择/回退、旧会话、取消和 payload 改写；
同轮工具续跑去重，安全会话条目不含技能正文、prompt 或 key。
纯解析测试覆盖 Completions/Responses/Anthropic system 字段、同数量目录替换及未知格式。
未执行真实宿主终端的人工截图验收，未调用线上模型。

2026-10-19 所选名称显示：`npm run check` 的类型、Lint、113 项测试及构建通过；
`npm run verify:package` 的 46 文件运行包通过真实 Pi loader 验证。
名称在状态栏、widget、通知及状态命令中显示，测试覆盖自动/固定分类、零命中、
回退不冒充自动选择、跨任务更新、未核验时的计划标记及终端控制字符清理。
持久化诊断仍只有枚举与计数；本轮未调用线上模型。
