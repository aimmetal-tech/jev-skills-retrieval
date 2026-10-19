# Pi 全量 Skills benchmark

本目录启动真实 `@earendil-works/pi-coding-agent@1.3.0`，比较 **Pi 原生 Skills** 与
**同一 Pi 加载本插件**。首轮固定配置：`jev-1.14.0`、3 秒路由截止时间、
最多选 5 个技能、选中元数据最多 4,000 字符。无重试、预筛选或分批。
用户随后授权方案 A：请求内复用路径身份、目录及候选，并在测试后按需调整超时。
3 秒实测仍超时；新默认分为本地准备 5 秒、评估 10 秒、总上限 15 秒。
完整目录已到达 Jev 并返回 HTTP 400；延长超时不能解决该输入拒绝。
随后核实服务错误码为 `max_tokens_exceeded`。Jev 1.14 默认整次请求 64k Token，
共享 state 加单个问题 32k Token；没有独立问题数量限制。
官方 262k 长上下文模式有速度/准确率影响，当前未开启。用户随后授权全量分批，
并要求降低并发；现已实现**串行（并发 1）**，没有预筛选。
修复后的测试使用新运行目录；不得与修复前的运行合并为同一被测版本。

## 串行全量分批

每批压缩前 JSON 最多 48,000 UTF-8 字节，state 加单题最多 24,000 字节，
最多计划 128 次调用；全部原始候选及 Noul 文案保留。字节不是 Token 上界。
每批成功并逐批记账后，再等待 1 秒派发下一批；失败不重试，也不自动拆分重发。
单批 10 秒，完整评估阶段 590 秒，总路由 600 秒。日常插件仍为 10 秒评估/15 秒总计。
正式 benchmark 的 `--task-timeout-ms` 建议至少 720000，为 Pi 执行留出时间；
较小的显式上限仍照常生效，不会自动延长。

`profile.ts` 是这套专用配置来源，并进入运行元数据和版本指纹。
在完整目录真实 Jev 诊断通过前，不应启动全量 Pi 对比。
全套 HTTP 预算需要先按每查询批次数核算；旧的 50000 上限未必足够。
每次实际 HTTP 都在原预算门禁前预约，attempt 回调在下一批前结算/落盘。
汇总报告不重复累加；保留成功部分的已知 Token，未知 usage 仍停止后续请求。
逻辑 SDK 尝试可能在 fetch 前被预算拒绝，不计作实际 HTTP。

当前交付包含数据准备、离线验证及运行/报告工具。用户已授权开始真实测试，
并明确指定 Pi 的 OpenAI OAuth 账户、`gpt-6-luna` 和 **medium**。
原生账户真实工具预检已返回 HTTP 200，包含有效 read 调用与 usage。
这不等于全量 benchmark 已完成。默认命令仍不调用模型，真实运行保留明确保护参数。

## 固定数据来源

| 测试集 | 来源与固定版本 | 全量范围 |
| --- | --- | --- |
| SkillRet | [官方数据](https://huggingface.co/datasets/ThakiCloud/SKILLRET/tree/a050ad233a504a43135bafe8cdf45574052b5729) | test: 6,006 skills、4,392 queries、7,187 qrels |
| SkillsBench v1.1 | [任务归档](https://github.com/benchflow-ai/skillsbench/tree/55bfe693f2a19f6b2f29aca3f54fe98b9d994668)、[固定 registry](https://github.com/benchflow-ai/skillsbench/blob/b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af/registry.json) | 87 个标准任务，排除 tasks-extra |

清单和任务归档使用两个不同的固定提交：归档自带的旧 registry 与 v1.1 后来修正的 registry
并不相同。预检用官方 `task_digest()` 核对每项，而不是仅检查任务目录数量。
两组、每项一次重复，总计划为 8,958 次 Pi 运行；这不是 API 请求次数上限。

**本机安全阻断**：安全软件删除了
`fix-druid-loophole-cve/verifier/test_outputs.py`，告警 ID `A9E32DDD4DA1FF17`。
静态审查确认[固定文件](https://github.com/benchflow-ai/skillsbench/blob/55bfe693f2a19f6b2f29aca3f54fe98b9d994668/tasks/fix-druid-loophole-cve/verifier/test_outputs.py)
含真实 CVE-2021-25646 利用测试；未据此宣布无毒或判定 AV 误报。
`blocked-inputs.json` 保留该任务的阻断记录。准备器不会重新释放该文件，后端拒绝执行该任务。
目前 86/87 个任务摘要匹配，原始 87 分母保留。全量 SkillsBench 的 live 入口因此在模型请求前停止，
不会静默缩成 86 个任务。隔离文件未恢复，CVE task/oracle/verifier 未执行。

## 安装与准备（不调用模型）

在项目根目录运行。要求 Node >=22.19、Python 3.12、`uv`、`hf` 和 Linux Docker 服务。
当前本机验证基线为 Windows、Node 24、BenchFlow 0.6.3。

```powershell
npm ci
uv venv outputs/benchmark/.venv
uv pip install --python outputs/benchmark/.venv/Scripts/python.exe -r benchmark/requirements.txt
npm run benchmark:prepare
npm run benchmark:preflight
npm run benchmark
```

`prepare` 只下载公开测试划分、任务及来源文档。缓存与文件哈希保存在 outputs 内。
已有数据的无网络审计：`python -X utf8 benchmark/prepare.py --offline`。
若环境代理是 SOCKS 且 Python 缺少 SOCKS 依赖，可为当前进程配置已确认的 HTTP 代理后重试；
工具不自动修改系统代理或做直连降级。本机下载曾显式使用已有 `http://127.0.0.1:7688` 代理。

`preflight` 校验完整 SkillRet 输入、生成文件和实际原生发现的 6,006 项，
再核对全部 SkillsBench registry 条目、任务摘要及 task.md 解析。
存在已知安全阻断时写出完整审计并返回非零（退出码 2），不能把它描述为 87 项全通过。
默认 `benchmark` 生成空结果报告：图上显示 N/A 和 NO LIVE RESULTS，不编造性能。

```powershell
npm test
npm run benchmark:check
npm run benchmark:verify
```

`npm test` 包含本地 HTTP 假服务上的真实 Pi 请求边界测试，不需要任何真实凭据。
`benchmark:verify` 显式启动一个无害 Docker 夹具，测试容器 read/bash、官方 verifier
与两组 Pi。它只使用回环假模型与假 Jev，不运行公开 CVE 任务；输出醒目标记 MOCK，
不能视为真实模型成绩。Docker 镜像构建需要网络和本地 Docker 权限。

## 启动真实测试

执行模型使用 `sources.json` 中的 **`(openai) gpt-6-luna`**，保持 **medium**。
通过原生 ModelRuntime 读取 Pi 已登录账户和模型目录（`~/.pi/agent/auth.json`、
`models.json`），保留 Responses/OAuth 路由。只复用账户，不自动加载全局技能或上下文。
不会用同名 Decisions classifier，也不会把账户请求转发到 `LLM_BASE_URL`。
两组共享相同账户、模型、推理档位与传输方式；不复制、打印或传递 OAuth 凭据到容器。

Jev 仍需要 `TYPESAFE_API_KEY`，可用 `TYPESAFE_BASE_URL` 指定 API 根。
通用 LLM_API_KEY/LLM_BASE_URL 规则保留给通用 API 集成及隔离测试，不适用于本次用户明确选择的账户路径。

benchmark 显式使用 `BENCHMARK_HTTP_PROXY > HTTPS_PROXY > HTTP_PROXY`，配置代理后不直连降级。
原生 OAuth 刷新与推理请求使用同一进程代理；运行证据不保存代理地址或凭据。
2026-10-18 原生账户预检在现有 HTTP 代理下成功，观察到 medium 和 81 个 Token；
同日通用 API 的 Unsupported model 只说明那条独立接口不支持该名称。

运行保护参数明确后替换下面的占位符；缺少任一上限会在请求前报错：

```text
npm run benchmark -- --live --suite all --output runs/full-001 --max-requests <HTTP上限> --max-total-tokens <Token停止阈值> --max-turns <每任务轮数> --max-output-tokens <每响应输出上限> --task-timeout-ms <每任务毫秒>
```

`--suite skillret|skillsbench|all` 默认 all。输出路径相对于 `outputs/benchmark/`。
源文件指纹、两组协议、数据版本和默认配置写入 `run.json`。
全量 SkillRet 对全部 6,006 个候选做串行分批评分，无预筛选；完整成功后全局选择。
超限、超时和回退如实记录，不把回退全库算作正确路由。

HTTP 上限在实际 fetch 之前检查，Pi 和 Jev 共用计数。Token 停止阈值按已收到的 usage 检查，
**不是严格费用封顶**：一个在途响应可能超过剩余 Token；默认缺失 usage 会停止后续请求。
用户已明确授权持久化测试使用 `--continue-unknown-usage`：记录未知成本后有限重试。
有未知用量时总 Token 和每成功任务 Token 保持未知，仅另外报告已知小计。
缓存只计一次，reasoning 是 output 子项，不重复相加。未提供价格，不推断账单美元。
每成功任务成本 = 本组所有尝试的 Pi+Jev 总 Token / 成功任务数；失败尝试也计成本。

逐条结果 fsync 写 `results.jsonl`，每次传输开始和响应落盘后原子写该 trial 的 `partial.json`。
verifier 异常保留已观察到的模型 usage，单独标记 verifier error。

### psmux 从头重测与独立结果

```powershell
pwsh -NoLogo -NoProfile -File benchmark/psmux.ps1 -Output runs/skillret-retest-v2-<时间戳> -Namespace jev-retest-<时间戳> -Session skillret-retest
psmux -L jev-retest-<时间戳> attach -t skillret-retest
psmux -L jev-retest-<时间戳> capture-pane -p -t skillret-retest
```

启动器要求全新的目录和会话，不读取、续跑或合并旧运行。`psmux-session.json` 和
`run-start-*.json` 标明 `resume/resumed=false`、`oldResultsImported=false`。
旧目录 `runs/skillret-full-serial-20261018-223527` 保持原状；本次结果只来自新目录。
每个新运行拥有独立 `run.json`、`results.jsonl`、检查点和图表，不能合并后声称同一轮成绩。

启动器只跑全量 SkillRet 两组（4,392 查询，各一次），沿用原生 OAuth、medium、并发 1。
实际 HTTP 上限 700,000，已知 Token 停止阈值 100,000,000,000，每任务 12 轮、
每响应输出 4,096、每任务 720 秒。这些是运行保护，不是费用预测。
SkillsBench 仍被安全隔离项阻断，未启动，也未缩减原始 87 任务分母。

psmux 的 detached 会话独立于启动终端；关闭终端不会结束 benchmark。
psmux 不保证机器重启后进程存活。状态应同时核对 `running.lock` 的进程和
`progress.json`、`active-trial.json`、trial 的 `partial.json`，不能只看 pane 存活。
控制台日志为 `psmux-console.log`，结束记录为 `psmux-exit.json`。

### 检查点协议 2 与未来恢复

`checkpoint.ts` 在实际 HTTP 前 fsync 保存 pending 预留；响应完整读取并 fsync 后再交 SDK。
每次尝试保存状态码、实际 usage、耗时与安全 request ID，不保存认证头或 cookie。
成功且 usage 完整的真实响应正文留在本地 `checkpoint/pi-*.json`、`jev-*.json`，
用于恢复 fresh Pi 内存会话和已付费 Jev 评分。正文含公开 benchmark 内容，不宜随意分享。
重放先验证请求语义哈希与响应 SHA；不另发 HTTP、不重复计费，不能作为新独立重复实验。
崩溃遗留 pending 一律记为未知，不能当作免费或零 Token。

429、529、网络异常最多额外重试 3 次，等待 5/15/30 秒；尊重最长 60 秒服务 cooldown，
更长 cooldown 不提前重试。次数跨重启保留，永久 4xx 停止。生产插件仍零重试。
实际 Jev 每次 10 秒；持久化 profile 的逻辑批次给 120 秒容纳重试，
整轮路由仍为评估 590 秒/总 600 秒，任务 CLI 上限仍生效。

未来确需恢复**同一新运行**时，在相同 launcher 命令上加 `-Resume`。
要求相同代码指纹、模型、套件、每任务参数及协议 2；可提高累计预算。
已完成 trial 不重跑，未完成 SkillRet trial 重建上下文并复用已保存的真实响应。
Windows 原生命名 mutex 防止双写；崩溃释放后旧锁记录归档。结果日志只修复断裂尾部，
完整损坏记录不会静默丢弃。旧版运行不迁移；SkillsBench 容器写操作不支持该响应重放。
Windows 状态读取可能短暂占用目标文件，原子替换对此最多等待 2 秒。
这只是本地写文件重试，不发送额外模型请求；持续写入失败会停止后续 HTTP。

重新生成报告不调用模型：

```powershell
npm run benchmark -- --report --output runs/full-001
```

## 评价口径与适配边界

- SkillRet 两组都只做检索：原始 query 送到 Pi/路由器，统一系统约束要求读取相关 SKILL.md
  后结束；只开放 read，且只允许读该候选库中的文件，不能读 qrels 或执行技能载荷。
  统计成功 read 的唯一 ID 集合的 Precision/Recall/F1、全 gold 召回，并另列插件筛选 F1。
  记录 offset/limit/截断，成功 read 不代表读完正文。
- SkillRet 官方检索文本包含正文；本实验忠实测插件的元数据路由，是适配实验，
  不能与官方全文 retriever 排行直接比较。205 个同名额外项使用稳定 ID 后缀避免 Pi 丢项。
  生成器规范化可自动发现的 frontmatter；原始文件保留在固定数据文件中。
  只提供 SKILL.md，不补齐脚本或依赖，因此不能把这部分称为实际任务完成测试。
- SkillsBench 保持原始任务、输入与 verifier，用 BenchFlow 0.6.3 管理每个独立 Docker
  sandbox、非 root agent 用户和官方路径保护；宿主 Pi 的原生工具 operations 代理到容器。
  Windows 虚拟路径映射为 POSIX 路径。只在内存修正 BenchFlow 0.6.3 几个纯容器路径辅助函数
  的 Windows Path 问题；不改安装包、任务文件、verifier 或权限策略。
  使用私有 `_env` 生命周期 seam，因此固定版本并通过显式 Docker 夹具验证。
- 实际任务通过必须由正式 `rollout.verify()` 返回 reward=1；verifier 错误与失败分开。
  任务自带 curated skills 是关联证据，不是穷尽相关性真值，相关 read 指标是诊断项。
- 两组隔离全局 skills、AGENTS/CLAUDE、其他扩展、提示模板、配置与历史；
  每个 trial 新建内存会话，成对运行顺序交替。无需删除 `~/.agents/skills` 或 Pi 技能目录。
  单次重复与顺序交替不能消除所有服务缓存、随机性或运行时抖动，图中保留样本量与覆盖率。

## 输出与文件职责

`npx tsx benchmark/diagnose-routing.ts --output diagnostics/local-a` 使用完整 SkillRet
目录验证请求快照与全量分批，本身不联网。加 `--live` 后最多发送 128 次串行 Jev 请求，
不调用 Pi 聊天模型。输出目录必须全新，不能覆盖/混合旧证据。
`--timeout-ms 3000` 可显式覆盖总上限；`--preparation-timeout-ms` 和
`--evaluation-timeout-ms` 可覆盖分段上限。输出保存路径解析次数、候选摘要、分段耗时和 HTTP
状态，不保存查询原文、凭据、请求或响应正文。失败调用的 Token 可能未知。
`preparation.json` 列出计划批数/大小；`attempts.jsonl` 与 `partial.json` 逐批落盘；
`result.json` 汇总整轮评分覆盖与已知/未知 usage。失败或 usage 不完整时退出非零。
离线模式的 usage=0 是明确标记的夹具值，不能当作实际成本或模型效果。
服务的 `max_tokens_exceeded` 通过白名单从 SDK 错误体提取到路由报告；其他任意错误正文
仍不进入证据。限制依据见 [官方模型说明](https://docs.typesafe.ai/models#context-length)。
这些诊断结果与正式检索/任务完成率报告分开。

`outputs/benchmark/data/` 保存固定数据、映射及 manifest；`.venv/` 为隔离 Python 依赖，
`preview/` 是空结果/预检报告，`verification/` 是 MOCK 证据，`runs/<id>/` 是各轮独立真实结果。
每个报告包含 `run.json`、`results.jsonl`、`results.csv`、`summary.json`、
`comparison.png`、`comparison.svg` 和自包含 `report.html`。这些文件全部被 Git 忽略。

代码：`prepare.py` 下载与输入审计；`data.ts` 验证/原生技能发现；`run.ts` 调度/预算门禁；
`pi.ts` 固定 Pi 会话与观测；`remote.ts`、`task-worker.ts`、`skillsbench.py` 负责容器桥接；
`benchflow_compat.py` 为已验证的 Windows 容器路径修正；`metrics.ts` 与 `report.py` 计算和绘图；
`selftest.ts` 验证无害 Docker 夹具；`diagnose-routing.ts` 诊断完整目录串行分批路由。
`checkpoint.ts` 负责逐请求持久化与恢复；`recovery.ts` 负责互斥锁和结果日志；
`psmux.ps1` 负责独立持久会话、固定运行参数和控制台记录。
来源锁、依赖锁与安全阻断清单在本目录。

## 已确认的双 psmux 并行协议 3

该协议独立于已停止的旧轮，用户已确认实施、80 trial 校准，以及达标后自动启动新全量。
先完成 `npm run check`，再启动；不将旧轮 451 条、失败新轮、校准或正式结果互相合并。

```powershell
pwsh -NoLogo -NoProfile -File benchmark/parallel/start.ps1 -Output parallel/<fresh-id>
npm run benchmark:parallel -- --output parallel/<fresh-id> --status
```

启动器隐藏运行一个本地协调器，并建立同一独立 psmux namespace 下的 `native` 和
`router` 两个会话。namespace 与日志位置见本轮 `psmux.json`。分别查看：

```powershell
psmux -L <psmux.json中的namespace> attach -t native
psmux -L <psmux.json中的namespace> attach -t router
```

每组各有 N=3 或5个任务名额，OpenAI 请求理论峰值为2N，Jev峰值N。
各查询独立 Pi 内存会话，内部 Jev 仍串行，保留查询本地1秒间隔。
这不是所有任务共享的全局1秒闸门；协调器按组限制在途请求、共享服务冷却和总预算。
原生组单独只需原生 OAuth，插件组还需 `TYPESAFE_API_KEY`。凭据仍从原处复用，不复制。

校准按查询长度分为20层，以固定seed20261019哈希挑选每层一条。3档和5档同20条，
两组各执行一次，共80个trial；每档都进行新的真实调用，不使用另一档的本地响应重放。
固定模型仍为 `openai/gpt-6-luna`、medium；数据、完整6006候选、阈值和Top5保持一致。
依据旧样本，80个trial包含约3300次HTTP而不是80次，实际次数与重试单独记账。

3档必须完整结束、无熔断/耗尽/人工恢复，且429/529不超过实际尝试的1%，否则停止排障。
5档采用同一条件，且整体吞吐至少比3档高20%才选5，否则使用合格3档。
吞吐按整个阶段历时计算，包含排队和退避，另列缓存变化。校准不用于证明准确率或长期配额。
符合规则后在全新 `full-3/` 或 `full-5/` 自动开始4392×2个trial；不会重用校准响应。
完整SkillsBench仍被隔离项阻断，本流水线仅运行SkillRet。

每个恢复轮最多首次+5次尝试。重试白名单为408/429/500/502/503/504/529、网络异常和超时；
退避5/10/20/40/80秒加0–20%正向抖动，尊重更长的服务端Retry-After。
429/529/503或服务端明确等待形成provider共享冷却，等待不占HTTP名额。
SDK内置重试关闭；不通过多层重试放大次数。永久错误与有效200缺失usage会暂停并报告。
耗尽后Jev暂停插件组、Pi暂停两组；普通重启保留次数，不能绕过上限。

```powershell
npm run benchmark:parallel -- --output parallel/<id> --resume-provider jev --new-cycle
npm run benchmark:parallel -- --output parallel/<id> --extend-job router/q-xxxxx --work-minutes 10 --route-minutes 10 --online-minutes 30
npm run benchmark:parallel -- --output parallel/<id> --stop
```

`--new-cycle` 是明确人工授权，可使历史累计超过6次；旧次数、已知与未知用量均保留。
预算追加只作用于已暂停任务，已消耗时间不清零。没有相应指令不会自行重开恢复轮或加时。
停机时停止新准入并通知各worker取消，在途不确定调用保留为未知；后台pane可保留。

单次网络超时Jev10秒/Pi120秒。路由有效工作600秒、任务1200秒、累计在线3600秒。
失败尝试网络时间照计；排队、退避、共享冷却分列且互不重复计时；正常查询内节奏仍计工作。
人工暂停和进程离线不扣累计在线预算，完整自然历时另报。五次是上限，不保证整体预算允许用满。
校准两档共用40000 HTTP保护上限，正式两组合计700000；已知Token阈值100000000000。
这些是运行保护而非账单封顶，未知成本不被归零，总Token不完整时不声称精确效率提升。

`coordinator.jsonl` 为单写者fsync事件账本，包含发送前预留、结算、周期和人工操作。
各trial的checkpoint保留成功真实响应及语义/正文哈希，不保存认证头；只在同一实验恢复时回放。
派生 `results.jsonl` 只包含已完成结果；报告还纳入运行/暂停trial的已观察成本并标为临时数据。
JSON/CSV约5秒或完成事件后更新，图表/HTML约60秒及暂停/结束时更新。

各阶段的 `run.json`、`summary.json`、`progress.json`、图表和group trial目录分别隔离。
根 `pipeline.json` 记录当前阶段、指纹、worker状态和总保护；`selection.json` 保存选档证据。
psmux活着不代表worker活着；进程退出和协调器失联都会明确暂停，不能继续绕过共享账本发请求。

协调器重启先停旧worker，再明确恢复基础设施，随后在两个已有pane中分别启动对应worker：

```powershell
pwsh -NoProfile -File benchmark/parallel/start.ps1 -Output parallel/<id> -Resume
npm run benchmark:parallel -- --output parallel/<id> --recover-infrastructure
node --import tsx benchmark/parallel/worker.ts --pipeline <本轮绝对目录> --group native
# 另一个 pane 使用 --group router
```

同一实验恢复要求源码指纹完全一致。跨进程租约防止旧、新worker双跑。
协调器中断或人工干预后的校准不再作为无故障选档证据；不能据此抹除原失败。
旧版源代码已冻结在git提交b113211，并保留忽略的source archive，旧证据保持原目录。
