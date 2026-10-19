# Jev Skills Retrieval：212 对查询的冻结阶段结果

数据截止 **2026-10-19 14:27:47 +08:00**。用户停止两组测试后冻结，本目录是精选派生结果；原始归档与旧图表未改动。实际完成原生组 695 条、插件组 212 条，比较只使用两组共同完成的 **212 条查询**，不是前 212 个连续 ID。

![212对查询阶段对比](comparison.png)

## 协议和指标

- 数据：[ThakiCloud/SKILLRET 固定版本](https://huggingface.co/datasets/ThakiCloud/SKILLRET/tree/a050ad233a504a43135bafe8cdf45574052b5729)，4,392 查询、6,006 技能、7,187 qrels。
- 两组：Pi 原生 Skills vs 同一 Pi、同一技能库启用 Jev Skills Retrieval。Pi 1.3.0，OpenAI OAuth `gpt-6-luna`，思考强度 `medium`；Jev `jev-1.14.0`。单次重复，两组各最多 5 个并行任务，单查询 Jev 分批串行。
- 这是 metadata 适配检索协议。ID 与发现用 frontmatter 有规范化，原始正文保留；不提供技能脚本/资源执行环境。不是官方 SkillRet full-text 检索榜单，也没有在此运行 SkillsBench 任务。
- `readIds` 是工具成功读取的技能 ID 集合；对每条查询先计算 Precision/Recall/F1，再取宏平均。重复读取不重复计分。读全标注技能仅表示 gold 集合被覆盖，不保证理解正文或完成用户任务。
- 插件 `selectedIds` 是路由选中集合，和实际读取集合不同。`routeF1` 仅对插件有意义，不能拿它与原生 `readF1` 直接比较。回退不算一次成功选择。

## 212 对主样本

| 指标 | Pi 原生 | Pi + Jev Skills Retrieval |
| --- | ---: | ---: |
| 宏平均 Precision | 40.5520% | 50.7311% |
| 宏平均 Recall | 46.6195% | 55.5031% |
| 宏平均 F1 | 40.8335% | 50.6761% |
| 读全标注技能 | 68/212（32.0755%） | 90/212（42.4528%） |
| 平均在线查询耗时 | 46.5008 s | 140.9901 s |
| Pi 已知 Token 小计 | 551,983,910 | 2,389,526 |
| Jev 已知 Token 小计 | 0 | 224,000,115 |
| 未知 usage 请求数 | 2 | 12 |
| 完整总 Token / 每成功查询 Token | 未知 | 未知 |

F1 高 9.8426 个百分点，读全标注率高 10.3774 个百分点；平均在线时间约为原生的 3.03 倍。时间包括排队、重试和恢复，不能解释为纯模型服务延迟。

## 199 对完整用量子集

只有双方 Pi 和 Jev 用量都完整的查询进入下表。此子集的检索成功数及分母与主样本不同。

| 指标 | Pi 原生 | Pi + Jev Skills Retrieval |
| --- | ---: | ---: |
| 查询数 | 199 | 199 |
| 读全标注技能 | 63 | 83 |
| Pi + Jev 总 Token | 509,534,563 | 212,485,799 |
| 平均 Token/查询 | 2,560,475.19 | 1,067,767.83 |
| Token/读全标注查询 | 8,087,850.21 | 2,560,069.87 |

该子集内平均 Token/查询低 58.30%，Token/读全标注查询低 68.35%。缓存 Token 只计一次，reasoning 属于 output 子集；这些是跨服务 Token 数量，不是货币成本或纯未缓存输入。不能把子集百分比外推到全部 4,392 条查询。

## 文件和复核

| 文件 | 内容 |
| --- | --- |
| [compact-evidence.jsonl](compact-evidence.jsonl) | 424 行，212 查询×2组；gold/read ID、插件 selected ID、usage、请求数、时间及恢复计数 |
| [summary.json](summary.json) | 主样本与完整用量子集的精确汇总 |
| [paired-queries.csv](paired-queries.csv) | 每对查询的 P/R/F1、差值、已知 Token 和完整性 |
| [provenance.json](provenance.json) | 数据、模型、源码版本，原始输入/归档及精选文件 SHA256 |
| [comparison.svg](comparison.svg) / [comparison.png](comparison.png) | 由精选汇总重新渲染的新名称图表 |

在仓库根目录执行（无线上模型调用）：

```powershell
npm ci
npm run results:verify
```

验证器调用与 benchmark 相同的指标函数，从 ID 和 usage 复算两套汇总与 CSV，并验证精选数据哈希。导出时已逐字段对比原冻结汇总，CSV 与原文件一致。它不需要本地的完整原始归档。`.gitattributes` 将本目录固定为 LF，避免跨平台 checkout 改变证据哈希。

重绘图表需[锁定 Python 依赖](../../../benchmark/README.md#安装与准备不调用模型)，在 Windows 项目根目录执行：

```powershell
outputs/benchmark/.venv/Scripts/python.exe scripts/render-snapshot.py
```

其他系统使用对应环境中的 `python`。图表只读本目录汇总，不读取账户或请求服务。维护者从本机只读冻结源重新导出时可执行：

```powershell
node --import tsx scripts/publish-snapshot.ts --source <冻结目录> --write
```

该选项只覆盖本精选目录中的数据派生文件，不编辑输入。数据改动后必须核对来源和差异，再重新绘图；不能把编辑后的汇总当作原始测量。

## 来源与限制

运行源码最终为 [`e02d7a3`](https://github.com/aimmetal-tech/jev-skills-retrieval/commit/e02d7a3a7fb269f54ccef1933b4bb48170e4b62f)，初始并行源码为 [`bb2391e`](https://github.com/aimmetal-tech/jev-skills-retrieval/commit/bb2391e97225c1d9612191a6e7a86354b5bdaec7)。运行中修复了 harness 的 guard/恢复处理，未重测完成查询；因此不是单一连续稳定状态的延迟实验。原准备清单曾用标签 `openai-gpt-6-luna`，实际 trial/response 模型均为 `gpt-6-luna`，provenance 同时保留该旧标签。

原归档为 1,331,919,872 字节，25,629 个源文件内容核验匹配；SHA256 为 `c569537186d094579a899f0f66434eb9c6eec434619706ef26c1bb66490f3e8f`。完整归档和大清单保留在本地，未上传 Git。文件哈希关联本地源，不能替代独立第三方审计。

212 对仅占全量查询的 4.83%，且按完成情况选取。未完成、暂停与中断任务不纳入检索均值；原生已完成但插件未完成的额外 483 条也不混入比较。完整用量子集还叠加了用量完整性选择偏差。

精简包排除提示词、原始模型响应、完整技能正文、凭据与本机绝对路径，因此可核验**这些记录推导出的指标**，不能独立重新审查每次工具调用或复现整场付费运行。数据集与协议来源见上方链接；本仓库的代码许可不改变上游数据权益。
