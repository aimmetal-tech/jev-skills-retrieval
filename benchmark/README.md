# Pi 全量 Skills benchmark

本目录启动真实 `@earendil-works/pi-coding-agent@1.3.0`，比较 **Pi 原生 Skills** 与
**同一 Pi 加载本插件**。插件源码和默认配置保持不变：`jev-1.14.0`、3 秒路由截止时间、
最多选 5 个技能、选中元数据最多 4,000 字符。无重试、预筛选、分批或测试中调参。

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

## 将来启动真实测试

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
全量 SkillRet 每次把 6,006 个候选放入一次 Jev 批量请求，容量/超时尚未实测；
超限、超时和回退如实记录，不把回退全库算作正确路由。

HTTP 上限在实际 fetch 之前检查，Pi 和 Jev 共用计数。Token 停止阈值按已收到的 usage 检查，
**不是严格费用封顶**：一个在途响应可能超过剩余 Token；缺失 usage 会停止后续请求。
缓存只计一次，reasoning 是 output 子项，不重复相加。未提供价格，不推断账单美元。
每成功任务成本 = 本组所有尝试的 Pi+Jev 总 Token / 成功任务数；失败尝试也计成本。

逐条结果写 `results.jsonl`，每次传输开始和模型完成后写该 trial 的 `partial.json`。
verifier 异常保留已观察到的模型 usage，单独标记 verifier error。
`--resume --output runs/full-001` 继续未尝试的组合，必须保持相同代码、模型及套件，
不会重试失败样本；可提高累计预算。存在未知 usage 或遗留 running.lock 时拒绝自动继续。
崩溃后先核对 partial 与已消耗请求，再人工处理锁，避免漏记费用。

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

`outputs/benchmark/data/` 保存固定数据、映射及 manifest；`.venv/` 为隔离 Python 依赖，
`preview/` 是空结果/预检报告，`verification/` 是 MOCK 证据，`runs/<id>/` 是将来的真实结果。
每个报告包含 `run.json`、`results.jsonl`、`results.csv`、`summary.json`、
`comparison.png`、`comparison.svg` 和自包含 `report.html`。这些文件全部被 Git 忽略。

代码：`prepare.py` 下载与输入审计；`data.ts` 验证/原生技能发现；`run.ts` 调度/预算门禁；
`pi.ts` 固定 Pi 会话与观测；`remote.ts`、`task-worker.ts`、`skillsbench.py` 负责容器桥接；
`benchflow_compat.py` 为已验证的 Windows 容器路径修正；`metrics.ts` 与 `report.py` 计算和绘图；
`selftest.ts` 验证无害 Docker 夹具。来源锁、依赖锁与安全阻断清单在本目录。
