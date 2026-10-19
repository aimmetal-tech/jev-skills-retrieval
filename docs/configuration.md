# 使用与配置

项目名称为 **jev-skills-retrieval**。旧命令、配置路径和会话标识保持兼容。

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
采用官方 `@typesafe-ai/sdk@0.7.0`，按完整目录分批请求，每个候选独立 Noul。
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
| `/jev-skill apikey add <apikey>` | 直接保存 add 后的 key，无需弹窗；支持无界面模式 |
| `/jev-skill apikey reset` | 删除用户目录中的凭据及内存缓存；环境变量仍优先 |
| `/jev-skill baseurl` | 打开带地址示例的输入框；无效地址继续提示，Esc 保留原值 |
| `/jev-skill baseurl https://api.typesafe.ai` | 设置当前项目的 Jev API 根地址，下一次路由生效 |
| `/jev-skill baseurl reset` | 移除项目地址，恢复用户配置、环境变量或默认地址 |
| `/jev-skill status` | 显示 key 是否已配置及来源、地址、模型和最近路由结果 |
| `/jev-skill help` | 显示二级命令用法 |

`apikey` 无参数时在弹窗中填写，支持 Ctrl+V、Ctrl+Shift+V、Shift+Insert，
以及 Pi 配置的剪贴板快捷键和终端直接粘贴。系统剪贴板不可用时显示可重试提示；
取消后不会采用尚未完成的剪贴板读取。终端按键由宿主拦截时，可使用宿主的粘贴操作。
也可以输入 `/jev-skill apikey add your-key`，直接保存 `add` 后的文本，去除首尾空白；
空值、多行或含控制字符的 key 会被拒绝，不打开弹窗、不回显输入。
提交后保存到用户目录的专用文件；
若已有 `TYPESAFE_API_KEY`，该环境变量仍优先，保存后会明确提示。
不会自动把环境变量中的 key 复制到文件。取消、弹窗失败或保存失败时保留原值。
配置修改要求当前任务已结束；帮助和状态可随时查看。命令不会调用模型或写入模型会话。
`apikey add` 在主编辑器中明文输入，Pi 可将它保留于本地输入历史；
需要掩码输入时使用无参数的 `/jev-skill apikey`。
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
  "routeTimeoutMs": 15000,
  "preparationTimeoutMs": 5000,
  "evaluationTimeoutMs": 10000,
  "batchMaxPayloadBytes": 48000,
  "batchMaxPairBytes": 24000,
  "batchMaxRequests": 128,
  "batchTimeoutMs": 10000,
  "batchIntervalMs": 1000,
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

全量候选现在自动按请求体大小分批，**并发固定为 1**，每批完成后默认等待 1 秒。
所有批次使用同一共享 state、原始 Noul 文案及稳定候选 ID。全部评分成功后统一执行
阈值、Top 5 和 metadata 预算；没有 BM25/向量预筛选，不做自动重试。
48,000/24,000 是压缩前完整 JSON 的 UTF-8 **字节保护**，不是精确 Jev Token 上界。
state 加单题过大、计划超过 128 批时，在网络请求前明确回退，不截断原文或丢候选。
字节预算不保证不会被服务拒绝；需要真实 usage 校准。单并发和间隔也不保证符合组织的
Token/请求速率限制，更不限制其他进程的并发。

日常总时限仍为 15 秒，大目录需要显式配置更长的评估及总时限。
benchmark 使用独立配置（评估 590 秒、总计 600 秒），详见 benchmark/README.md。
分批报告分别记录计划/完成批数、评分覆盖、已知 usage 和 usage 是否完整。
任一批失败或中途 usage 未知时停止后续批次；不把未评分候选当零分。

## 故障与诊断

`/jev-skill status` 查看配置及最近结果，旧命令 `/skill-router-status` 保持可用。
Pi 会话的 `jev-skill-router` 自定义条目
记录状态、原因、候选数、选择数、耗时、实际模型和 token usage，不记录
原始聊天或 key。

编辑器上方常驻 `[jev-skills-retrieval]` 指示区，状态栏同步显示当前状态。
启动时显示“已启用 · 等待任务”，并说明启动 `[Skills]` 是本地清单。
新请求依次显示“准备技能目录”“等待 API key”（需要时）和“Jev 评分中”；
评分时显示实际已完成的批次数，主模型尚未发送。开始评分另有一次明确通知。
完成后保留结果，下一条请求开始时更新，不因工具续跑重复提示。

状态栏在数量前显示技能名称；编辑器上方分别列出完整的“自动选择”和“固定项”，
例如 `自动选择：hf-cli、tavily-search`。零命中显示“自动选择：无”；
关闭自动筛选时只列固定项。回退不把全量目录标成自动选择。
未完成发送前核验或目录被改写时，名称标为“计划自动选择”“计划固定项”。
新任务会替换上一条任务的名单，工具续跑保留本轮名单。
终端较窄时状态栏可能被 Pi 截短，可在上方指示区或状态命令中查看完整名单。

| 显示 | 含义 |
| --- | --- |
| `先筛选后发送 · 请求含 2/16 项 metadata · 发送前已核验` | 示例：Jev 已筛选，本检查点看到的请求目录与选择结果一致；2 包含固定项，16 为本地去重完整目录数量 |
| `全量回退` | 本轮服务或配置失败，恢复完整目录 |
| `仅固定项` | 自动筛选关闭或没有自动候选；不声称已运行 Jev 评分 |
| `未筛选 · 旧会话；/new 启用筛选` | 已有历史会话不接管路由 |
| `未发送主模型` | 凭据未就绪或任务取消，停止本轮 |
| `目录被改写，筛选效果未确认` | 发送前目录与计划不同，不显示筛选成功 |
| `请求格式无法核验` | provider 请求格式未支持或不可解析；只显示计划数量 |

`/jev-skill status` 和兼容命令 `/skill-router-status` 也显示此运行摘要。
技能名称按已有请求快照在内存中区分自动项与固定项，只用于界面展示；
不把名称、路径或描述加入下述诊断条目。显示名称前会清理终端控制字符。
新增 `jev-skill-prompt` 会话条目只保存状态枚举、目录数量和核验结论，
不保存请求、技能文本或密钥。它与路由/成本报告分开，避免重复记账。
核验读取 OpenAI Chat Completions/Responses、Anthropic 的已知 system 字段，
忽略用户消息和工具结果；不支持的格式保持未知。
“发送前已核验”指本扩展的 `before_provider_request` 检查点，
不表示网络发送成功，也不能保证后续扩展没有再次改写请求。
只比较技能目录片段，历史中的正文或旧 metadata 不会被清除。
RPC 客户端是否显示常驻指示由客户端决定，可用状态命令查看摘要。

- 全部低于阈值：正常成功，自动目录为空，保留固定项。
- 缺 key：等待用户填写并保存；取消、无 UI、弹窗或落盘错误时记录 `blocked/missing_key`，
  取消当前任务，绝不把全目录交给聊天模型继续。无自动候选、自动预算为 0
  或配置校验已失败时，不进入 Jev 凭据填写流程。CLI 的 `eval --live` 缺 key
  仍直接报错退出。等待人输入及凭据存储的时间不计入路由 deadline。
- 已提供 key 后的鉴权失败、限流、服务错误、输入拒绝、无效响应、超时：回退原始
  catalog 并保留有效固定项；不把故障假装成零命中。
  若服务明确返回 `max_tokens_exceeded`，诊断记录该白名单错误码，表示模型上下文
  Token 超限；不再只显示笼统的 HTTP 400，也不会转发任意服务错误正文。
- 配置无效或固定路径无效：列出具体字段/路径，保留其余有效固定项并回退，
  本轮不调用 Jev。未知配置字段也会报告；配置中不允许放 key。
- 每个请求只解析一次各路径的规范身份，复用去重目录、固定项和候选；
  成功合并及失败回退复用同一快照。下一次用户请求重新解析，避免缓存路径变更。
- 一次总 deadline 覆盖本地目录准备、SDK、网络和响应解析，并传递共享 abort signal；
  凭据等待不计时。诊断另列 preparation/evaluation/selection 分段耗时。
  默认本地准备上限 5 秒、Jev 评估上限 10 秒、总上限 15 秒；保留 `routeTimeoutMs`
  作为总上限，旧配置仍会生效。评估包含 SDK 构造、网络、响应解析与校验。
  本地同步文件调用不能由 JS 定时器强行中断，完成后检查上限，超限不发 Jev 请求。
  `timeoutPhase` 指出触发的是 preparation、batch、evaluation 或 total。
  单批上限包含 SDK、网络和解析；阶段上限也包含批次间等待。SDK 重试固定为 0。
  已产生的批次 usage 在后续失败时仍保留，未知用量不能当零。
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

- [Pi 1.3.0 扩展 API](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md)
- [Pi package 分发](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/packages.md)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)

[项目首页](https://github.com/aimmetal-tech/jev-skills-retrieval)
