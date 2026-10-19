# Jev Skill Router

## Product and boundary

Implement the confirmed Pi v1 specification from `pi-skill-router-spec.html`.
TypeScript native extension; Pi discovers skills and reads their original bodies.
Route each normal user request once. Reuse that choice during tool continuations.
Pinned paths and explicit `/skill:name` calls take precedence. Successful zero hits
and routing failures are different. Do not claim support for mid-run steering,
resumed pre-extension sessions, other harnesses, or removal of historical skills.
The user superseded the original missing-key fallback: missing credentials now
block the current Pi task until supplied. Cancel/no UI/dialog failure stops the
task without sending a provider request; never silently fall back for missing keys.
The user subsequently authorized persistence in the home directory. Persist only
to `~/.jev-skill-router/credentials.json`; never to project config or session data.

## Structure and data flow

- `src/pi-adapter.ts`: Pi lifecycle entry point and per-run structured skill catalog.
- `src/selection.ts`: request-local canonical path identity cache and catalog
  snapshot; deduplication, pinned clones and candidates are reused through routing
  and fallback. Never reuse the snapshot across normal user requests.
- `src/router.ts`: preparation/evaluation deadlines under a total safety deadline
  (excluding credential waiting), stage timings, early cancellation and fallback.
  After solution A reached Jev but the old 3s total expired, the user authorized
  increasing/splitting limits: defaults are 5s preparation, 10s evaluation, 15s
  total. Existing routeTimeoutMs overrides remain a total cap. Synchronous local
  work is checked after completion, not forcibly preempted by JavaScript timers.
- `src/batching.ts`: deterministic full-catalog byte-guard packing and strictly
  serial dispatch (concurrency fixed at 1), default 1s completion-to-next-start
  interval, per-batch cancellation/deadline, complete-score merging and per-attempt
  sanitized evidence. Defaults: 48,000 uncompressed JSON bytes per batch, 24,000
  bytes for state plus any question, 128 planned calls, 10s per call. Byte guards
  are not verified Jev token bounds. No prefiltering, prompt changes or retries.
- `src/jev-client.ts`: official SDK batch Noul requests, strict response validation,
  sanitized failure codes, allowlisted `max_tokens_exceeded` service detail,
  actual model version and token usage. Never forward arbitrary server error data.
  Shared question/request builders keep byte planning identical to SDK payloads;
  independently observed usage is retained even when answer validation fails.
- `src/context.ts`: raw current input, bounded visible conversation and prior metadata.
- `src/credentials.ts`: environment-first credential resolution, blocking input,
  cached user-file fallback, explicit key editing/reset and shutdown cache cleanup.
- `src/credential-store.ts`: home-directory credential persistence, atomic writes,
  Windows current-user DPAPI encryption and POSIX 0700-directory/0600-file modes.
- `src/key-prompt.ts`: masked TUI credential input and native RPC input bridge.
- `src/commands.ts`: `/jev-skill` configuration/help/status subcommands, native
  argument completions and contextual input hints; preserves legacy status command.
- `src/base-url.ts`: HTTP(S) API-root validation, endpoint resolution and atomic
  project `baseUrl` writes that preserve unrelated fields and reject invalid JSON.
- `src/config.ts`: defaults and validated user/project configuration merge.
  Its explicit model default is shared by routing and evaluation.
- `tests/*.test.ts`: core and real Pi provider-boundary integration tests.
- `tests/credential-fixtures.ts`: isolated memory stores for existing tests; real
  file-store tests use temporary fake homes, never the developer's home or keys.
- `eval/dataset.ts`: eight bounded synthetic metadata evaluation cases.
- `eval/run.ts`: preview by default; explicit `--live` runs real Jev requests and
  writes partial evidence after each request to `outputs/evaluation.json`.
- `eval/metrics.ts`: recall, false discoveries, zero hits, model, tokens and latency;
  never count full fallback as successful recall or claim unknown billed costs.
- `benchmark/`: full public SkillRet and SkillsBench preparation and isolated Pi
  benchmark harness, added after the user confirmed the grilling design. Default
  execution is preview/offline only. The user subsequently authorized real tests
  without a monetary budget cap, and explicitly selected Pi's existing OpenAI
  OAuth account, chat model `gpt-6-luna`, and `medium` thinking. Do not send this
  model through generic LLM_BASE_URL or substitute an API-key provider. Native
  account metadata/auth is reused in place, never copied to artifacts or sandboxes.
  `sources.json` pins SkillRet test revision and separate SkillsBench task
  archive/registry commits; `requirements.in` and `requirements.txt` lock Python.
  `prepare.py` downloads/audits data; `data.ts` validates hashes and native skill
  discovery; `preflight.py` checks all official task digests using BenchFlow 0.6.3.
  `run.ts`, `pi.ts`, `budget.ts`, `types.ts` isolate and observe fixed Pi 1.3.0 runs;
  `remote.ts`, `task-worker.ts`, `skillsbench.py` bridge host tools into official
  Docker sandboxes. `benchflow_compat.py` narrowly rebinds pure sandbox-path helpers
  to POSIX semantics on Windows, without changing tasks, verifier or privileges.
  `metrics.ts` and `report.py` produce JSON/CSV/PNG/SVG/HTML; `selftest.ts` verifies
  a harmless Docker fixture with loopback fake providers. `benchmark/README.md`
  defines setup, limits, protocol differences and evidence boundaries.
  `check.ts` runs Ruff and `test_harness.py` regressions for quarantine extraction,
  archive traversal and POSIX path validation without Docker or model calls.
  `transport.ts` explicitly uses BENCHMARK_HTTP_PROXY > HTTPS_PROXY > HTTP_PROXY
  when configured, without direct fallback; no proxy URL/credentials in evidence.
  Per-provider budget wrappers count inference requests. Process-local fetch also
  routes native OAuth refresh consistently; it is not a global budget counter.
  `profile.ts` defines an explicit full-catalog benchmark profile: 590s evaluation,
  600s total, serial batches; interactive defaults remain 10s evaluation/15s total.
  Benchmark task timeout is still an explicit CLI guard; use at least 720s to leave
  Pi execution time after full routing. Never silently raise a supplied guard.
  `checkpoint.ts` implements checkpoint protocol 2 for SkillRet trials: fsynced
  pending HTTP reservations, sanitized attempt usage, hashes and locally retained
  successful real provider bodies. Matching responses replay into a fresh Pi
  session without another paid request; authorization/cookies are never saved.
  Windows atomic replacements tolerate transient reader locks for up to 2s;
  persistent checkpoint/observer writes stop further HTTP with checkpoint_failure.
  `recovery.ts` owns the run lease (Windows native named mutex via a hidden helper;
  POSIX loopback lease), fsynced result journal and conservative torn-tail repair.
  `psmux.ps1` starts a detached named psmux session with a fresh output directory
  by default; `-Resume` is explicit and only supports identical protocol-2 code,
  model, suite and task guards. Never import legacy evidence into a new run.
  psmux protects terminal disconnects, not reboot; checkpoints support later restart.
  User confirmed a separate parallel protocol 3, not an alteration or resumption of
  the stopped protocol-2 runs. `benchmark/parallel/` contains `protocol.ts` (frozen
  limits, seeded query-length calibration), `coordinator.ts` (single fsynced journal
  writer, group leases, shared costs/cooldowns/service pauses/manual recovery),
  `ipc.ts` (local named pipe on Windows / Unix socket), `timing.ts` (disjoint work,
  queue, backoff, cooldown and cumulative online time), `checkpoint.ts` (real paid
  response replay in the same experiment), `worker.ts` (one process per group and
  a task pool), `reporting.ts` (single report writer and frozen selection rule),
  `pipeline.ts` (calibrate 3 then 5, select, automatically start a fresh full run),
  `start.ps1` (hidden coordinator launch), `session.ps1` (two detached psmux group
  sessions). Per-group task limits are independent: N=3/5 means up to 6/10 Pi
  requests account-wide and 3/5 Jev requests. Per-query Jev batches stay serial,
  with query-local 1s pacing; no global 1s gate that accidentally serializes pools.
  SDK retries remain disabled. Protocol 3 performs first+5 attempts, exponential
  5/10/20/40/80s plus 0–20% positive jitter, honors longer server Retry-After,
  shares provider cooldowns and releases HTTP slots while waiting. Retryable
  codes: 408/429/500/502/503/504/529 and network/timeout failures. Exhaustion
  pauses the affected provider (Pi both groups; Jev router only). Ordinary restart
  never resets counts; explicit operator new cycles retain all prior costs.
  Actual attempts retain Jev10s/Pi120s timeouts. Route work=600s, trial work=1200s,
  cumulative online=3600s; queue/backoff/cooldown are separate, failed actual work
  is charged. Offline/user-pause time is excluded from online, natural elapsed is
  retained. Guard exhaustion pauses rather than fabricating a completed failure.
  Only operator commands append budget or retry cycles, never erase history.
  Pi adapter's optional onRouteStart observer and Pi trial's durability/config
  seams leave ordinary production timeouts, retry policy and behavior unchanged;
  the parallel harness externally enforces work limits under a 1h wall safeguard.
  Calibration is fixed 20 query-length strata with seed 20261019: 20 queries × 2
  groups × 2 profiles =80 real trials. Both profiles use fresh calls, not cross-run
  response replay. A qualifying profile must finish, have no circuit break/manual
  recovery, and 429/529 fraction <=1%. Choose 5 only if eligible and >=20% faster;
  otherwise eligible 3. Invalid 3 stops the pipeline. Full phase is fresh 8784
  trials. Combined calibration HTTP guard=40000; full HTTP guard=700000; known
  token guard=100000000000. Tokens remain a response-boundary stop, not a bill cap.
  `coordinator.jsonl` is authoritative; `results.jsonl` is a derived completed
  view. Partial running/paused costs are included in provisional summary reports.
  Reports refresh every <=60s and on stop/end. Worker death preserves uncertain
  reservations; coordinator loss is fail-closed and requires explicit recovery.
  `tests/parallel.test.ts` and `parallel-pi.test.ts` cover IPC limits, shared budget,
  cooldown scopes, six attempts/manual cycles, replay, independent clocks, restart
  journal integrity, profile choice and six concurrent real Pi fake-provider calls.
  Prior code is preserved at git b113211 and an ignored source archive under
  `outputs/benchmark/source-archives/`; old evidence is never imported or edited.
  Parallel native-account preflight must restore the local catalog with the
  default offline refresh (allowModelNetwork:false). refreshOnCreate:false leaves
  the model/auth snapshot uninitialized and cannot establish unavailability.
  Legacy protocol 2 (separate from the new parallel protocol above): the user
  explicitly authorized unknown-cost recording followed by bounded backoff
  retries in this persistent benchmark: `--continue-unknown-usage` retains unknown
  totals, retries only 429/529/transport failures up to 3 additional attempts with
  5/15/30s backoff (honoring server cooldowns up to 60s). Retry counts persist.
  Every Jev actual attempt remains capped at 10s, concurrency 1 and 1s spacing;
  the persistent profile allows 120s per logical batch for backoff, while keeping
  590s evaluation/600s total and the explicit 720s task guard. Production routing
  still has zero retries. SkillsBench sandbox mutations do not use response replay.
  `diagnose-routing.ts` verifies the full 6,006-skill request-local snapshot offline
  by default; `--live` sends at most 128 serial Jev requests, with no Pi generation.
  It requires a fresh output directory, checkpoints attempts.jsonl/partial.json,
  and exits nonzero on incomplete scoring or usage. Offline usage is a labelled
  zero-valued fixture; only actual responses establish real costs or latency.
  It writes sanitized preparation/HTTP/timing evidence below
  `outputs/benchmark/diagnostics/`; this is not a task accuracy benchmark.
- `benchmark/blocked-inputs.json`: the user-reported antivirus quarantine of
  `fix-druid-loophole-cve/verifier/test_outputs.py` (ID A9E32DDD4DA1FF17).
  Static review of the official pinned file found real CVE-2021-25646 exploit
  regression payloads, not proof of benignness or a confirmed AV false positive.
  Never automatically restore/re-extract or execute this blocked file/task.
  Preserve the official 87-task denominator; currently 86 task digests match and
  one is security-blocked. Full SkillsBench live execution stops before paid calls.
- `tests/benchmark.test.ts`: real Pi HTTP-boundary benchmark tests with fake keys,
  budget enforcement, inaccessible qrels, per-batch accounting without aggregate
  double charges, unknown usage and report honesty. `tests/batching.test.ts`
  checks all 6,006 identities, exact JSON byte sizes, serial/paced SDK calls,
  global selection, failed/unknown/mixed responses, deadlines and cancellation.
- `scripts/verify-package.ts`: build via npm pack, inspect tar contents, extract
  below `.tmp/`, and load the packed ESM extension using the real Pi loader.
- `package.json`: Pi package entry, dependencies, build and verification scripts.
- `tsconfig*.json`, `biome.json`: strict TypeScript build and lint configuration.
- `README.md`: scope, installation, implementation status and verification evidence.
- `docs/verification.md`: observed acceptance evidence, HTTP 451 diagnosis,
  successful explicit-proxy evaluation, limitations and reproduction commands.
- `LICENSE`: MIT license. `package-lock.json`: reproducible dependency resolution.
- `dist/`: generated package output; ignored. `.tmp/`, `outputs/`: local evidence;
  ignored. Never stage dependencies, generated packages, credentials or artifacts.
  `outputs/benchmark/` holds pinned data, Python environment, preview reports,
  MOCK verification and future `runs/<id>/` evidence; `__pycache__/` is ignored.
  `outputs/benchmark/live-preflight/` stores sanitized real API/account diagnostics,
  distinct from full benchmark results. Direct API and native OAuth are different
  paths; do not infer account model availability from LLM_BASE_URL's /models.

Data flow: `input` raw text -> `before_agent_start` complete catalog and two-level
config -> fixed baseline -> blocking credential gate -> bounded shared state and independent Jev Noul questions
-> deadline/response validation -> selected original Skill objects (or explicit
fallback) -> `systemPromptOptions.skills` -> Pi native formatter -> provider.
Only assistant text is retained in extension-owned recent history; tool results,
thinking, skill bodies and session custom entries are excluded. Session reload
with existing messages is explicitly unsupported and skips routing. Diagnostics
persist as `jev-skill-router` custom entries and `/skill-router-status` displays
the latest report without raw task text or credentials.
Catalog preparation produces a single request-local snapshot before the credential
gate; its duration is passed to the router and consumes the same total deadline.
Credential input/storage waiting does not consume that deadline. Reports include
preparation, evaluator (SDK/network/parsing) and selection milliseconds; timeoutPhase
distinguishes preparation/evaluation/total/batch. The user subsequently authorized
full-catalog batching and asked to lower concurrency: it is fixed at 1. Every
eligible candidate is scored once; partial results cannot become normal zero hits
or selected results. Failure retains normal explicit fallback; missing keys and
caller cancellation keep their blocking/cancellation behavior. No prefiltering.
Per-attempt callbacks run synchronously after settlement and before the next call.
The benchmark accounts/checkpoints actual dispatched HTTP attempts there; the final
route report only summarizes them. Logical SDK attempts blocked before fetch are
not counted as actual HTTP. Known partial costs survive failure; unknown usage and
permanent HTTP errors still stop further budgeted traffic.
The persistent SkillRet benchmark is an explicit user-authorized exception to
unknown-usage stopping: unknown costs remain visible, full token totals and
tokens-per-success stay unknown, and only known subtotals feed the token guard.
Fresh retests require separate directories, start metadata with no imported old
results, and independent psmux sessions. Preserve all earlier evidence unchanged.
`/jev-skill apikey` saves the same credential used by the blocking gate to the user
file; `apikey reset` removes the file and cache. It takes no plaintext key argument.
`/jev-skill baseurl [URL|reset]` updates only
the project `.pi/skill-router.json` endpoint; no argument opens an input dialog.
Config mutations require an idle agent, send no model request and do not enter
conversation history. `/jev-skill status` displays source/presence, never key values.

## API conventions

- Jev credentials prefer `TYPESAFE_API_KEY`; when missing in an interactive mode,
  read the user credential file, otherwise await input and save it before routing.
  Never copy environment credentials to disk automatically or write keys to project
  configuration, process environment, conversation history, route state, reports or logs. TUI
  input is masked; RPC rendering is controlled by the client. Empty input retries;
  cancellation, missing UI, dialog errors and persistence failure block the task
  with `missing_key`. Corrupt files can be repaired by entering a replacement;
  never forward file contents, crypto subprocess output or raw errors. DPAPI
  subprocesses are hidden, take secrets on stdin and never in command arguments.
  Human input/file crypto time is outside the routing network deadline. Clear only
  the memory cache on shutdown; keep the file. Non-interactive live evaluation
  remains environment-only; Pi headless mode can use a previously saved credential.
- Generic LLM integrations, if introduced later, prefer `LLM_API_KEY`,
  `LLM_BASE_URL`, and OpenAI Chat Completions. V1 needs no generic LLM call.
- Use the official TypeSafe JavaScript SDK. Zero retries; evaluator time is capped
  by min(evaluationTimeoutMs, remaining routeTimeoutMs).
- Live full-catalog diagnostics reached Jev and received HTTP 400 with
  `detail.error_type=max_tokens_exceeded`. Official live docs confirm Jev 1.14
  defaults to 64k per request and 32k for state plus any one question; there is no
  separate question-count limit. The 262k long-context header is opt-in and has
  documented speed/accuracy tradeoffs. It has not been enabled. Batching is now
  implemented after solution A; prefiltering remains unimplemented. Serial calls
  and spacing do not guarantee compliance with account-wide RPS/TPS limits or
  prevent other processes from using the same organization's quota.
- Jev Base URL precedence: project `baseUrl` > user `baseUrl` >
  `TYPESAFE_BASE_URL` > `https://api.typesafe.ai`. Pass it as SDK `baseURL`;
  the SDK appends `/v1/systemone`. This is a Jev API root, not a proxy setting.
  Reject non-HTTP(S) URLs, embedded credentials, query parameters and fragments
  without echoing invalid input. API key commands write only the dedicated user
  credential file, never the environment. Status shows source and path, not key.
- Default routing and evaluation model is explicitly `jev-1.14.0`, as requested
  by the user. User/project `model` and evaluation `--model` may override it;
  the SDK environment default must not silently replace the chosen version.
- Compatibility baseline: `@earendil-works/pi-coding-agent@1.3.0`, specification
  source commit `482c1381a00d8d00bc81697e4a980c593db6803e`.

## Verification and commits

- `npm ci`: install the locked dependencies.
- `npm run check`: typecheck, Biome lint, meaningful tests, and production build.
- `npm run format`: apply formatting and organize imports.
- `npm run eval`: preview the bounded synthetic suite without network calls.
- `npm run benchmark:prepare`: download full pinned public test inputs; no model.
- `npm run benchmark:preflight`: offline full input/hash/native-discovery audit;
  reports security-blocked inputs and returns exit 2 when not all tasks are ready.
- `npm run benchmark`: empty/preview report by default; no model calls. Explicit
  `--live` requires positive HTTP/token/turn/output/time guards, TYPESAFE_API_KEY
  and Pi's existing OpenAI OAuth account. User clarified the CLI label as provider
  `openai`, model `gpt-6-luna`, thinking `medium`; use native Responses/account
  routing, separately from Jev 1.14. No silent provider/model substitution.
  Actual HTTP requests are capped before fetch. Tokens are an observed response
  boundary stop, not a strict monetary cap; unknown usage stops further requests.
  Preserve raw trial evidence and coverage; mock/empty charts are labelled clearly.
  `pwsh -NoProfile -File benchmark/psmux.ps1 -Output runs/<fresh-id> -Namespace
  <unique-namespace> -Session <unique-session>` starts a fresh detached full
  SkillRet two-group run with the authorized persistent retry policy. It refuses
  existing output/session names. Attach with `psmux -L <namespace> attach -t
  <session>`; check `progress.json`, `active-trial.json`, trial `partial.json`,
  `checkpoint/` and `psmux-console.log`. `psmux-exit.json` records process exit;
  a live pane alone is not evidence that the benchmark process is running.
  `tests/checkpoint.test.ts` covers paid-response replay, unknown retries/restart,
  exhausted attempt persistence, cache/reasoning accounting, journal repair and
  concurrent-writer exclusion. Pi HTTP-boundary tests cover durable Responses
  and Completions accounting with fake providers, without real account access.
- `npm run benchmark:verify`: explicit harmless Docker/BenchFlow/Pi integration
  using loopback fake providers, no public CVE tasks and no real model calls.
  Python dependency setup and resume/report commands are in benchmark/README.md.
- `pwsh -NoProfile -File benchmark/parallel/start.ps1 -Output parallel/<fresh-id>`:
  explicitly authorized live parallel pipeline. Creates two independent psmux
  sessions plus a hidden coordinator; calibrates before automatic fresh full run.
  `npm run benchmark:parallel -- --output parallel/<id> --status` reads live IPC;
  `--stop` closes admission and cancels active trials while preserving evidence.
  `--resume-provider pi|jev --new-cycle` is explicit manual retry authorization;
  `--extend-job <group/query> --work-minutes N --route-minutes N --online-minutes N`
  appends paused-task guards. `start.ps1 -Resume` restarts coordinator fail-closed;
  stop old workers, use `--recover-infrastructure`, then explicitly restart each
  group worker in its existing session. No automatic recovery loop resets limits.
  Full instructions and root/phase output identities are in benchmark/README.md.
- `npm run benchmark:check`: locked Python Ruff checks/formatting and meaningful
  no-network preparation/compatibility/verifier-failure tests in the dedicated Python environment.
- `npm run eval -- --live`: paid Jev evaluation with `TYPESAFE_API_KEY`; default
  at most 8 requests, no retries, 3 seconds each. Stops on permanent HTTP 4xx.
- `npm run eval -- --live --output outputs/evaluation.json`: evidence output path;
  `--repeat 1..20`, `--model`, `--threshold`, `--timeout-ms` configure calibration.
- Explicit proxy diagnosis used process-local Undici `ProxyAgent` bound to
  `http://127.0.0.1:7688`, with no direct fallback. Reproduction is documented in
  `docs/verification.md`; evidence is in `outputs/proxy-7688-probe.json` and
  `outputs/evaluation-proxy-7688.json`; the requested `jev-1.14.0` evaluation is
  in `outputs/evaluation-jev-1.14.0-proxy-7688.json`. The default extension does not yet enable
  a proxy automatically. Do not confuse sandbox elevation with proxy routing.
- `npm pack --dry-run`: inspect package contents (runs the build).
- `npm run verify:package`: build and create `outputs/jev-skill-router-0.1.0.tgz`,
  validate packaged files, and load the extracted extension in Pi without an API call.
  Needs system `tar`; temporary extraction is removed after verification.
- Integration tests must inspect actual Pi provider requests, not only arrays.
  They bind a temporary loopback HTTP server; restricted environments may need
  permission for local networking. Tests never need real provider credentials.
- With added/deleted/moved files, module/data-flow changes, or changed commands or
  output paths, synchronize this project-level AGENTS.md in the same change.
- Finish one functional milestone, handle failures, synchronize docs, pass checks,
  inspect `git status --short`, `git diff`, and `git diff --cached`, then commit.
- Stage only the current milestone. Use Conventional Commits; never claim a
  blocked check passed. Do not mix independent changes into one commit.

## Tools and responses

Use Context7 for current library/API/CLI docs; use Tavily for web evidence where
needed. Prefer official sources. Use answer-me-with-html for conclusions and
delivery summaries, 2–4 panels, rendered with `--no-open`; link the absolute page
path at the end. Explicit plain-text requests and trivial nonconclusions are exempt.
