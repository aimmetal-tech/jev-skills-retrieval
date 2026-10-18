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
- `src/selection.ts`: canonical local path identity, deduplication and pinned clones.
- `src/router.ts`: one total routing deadline, cancellation and explicit fallback.
- `src/jev-client.ts`: official SDK batch Noul requests, strict response validation,
  sanitized failure codes, actual model version and token usage.
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
  execution is preview/offline only; real model calls await a separately agreed
  budget. `sources.json` pins SkillRet test revision and separate SkillsBench task
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
- `benchmark/blocked-inputs.json`: the user-reported antivirus quarantine of
  `fix-druid-loophole-cve/verifier/test_outputs.py` (ID A9E32DDD4DA1FF17).
  Static review of the official pinned file found real CVE-2021-25646 exploit
  regression payloads, not proof of benignness or a confirmed AV false positive.
  Never automatically restore/re-extract or execute this blocked file/task.
  Preserve the official 87-task denominator; currently 86 task digests match and
  one is security-blocked. Full SkillsBench live execution stops before paid calls.
- `tests/benchmark.test.ts`: real Pi HTTP-boundary benchmark tests with fake keys,
  budget enforcement, inaccessible qrels, usage accounting and report honesty.
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

Data flow: `input` raw text -> `before_agent_start` complete catalog and two-level
config -> fixed baseline -> blocking credential gate -> bounded shared state and independent Jev Noul questions
-> deadline/response validation -> selected original Skill objects (or explicit
fallback) -> `systemPromptOptions.skills` -> Pi native formatter -> provider.
Only assistant text is retained in extension-owned recent history; tool results,
thinking, skill bodies and session custom entries are excluded. Session reload
with existing messages is explicitly unsupported and skips routing. Diagnostics
persist as `jev-skill-router` custom entries and `/skill-router-status` displays
the latest report without raw task text or credentials.
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
- Use the official TypeSafe JavaScript SDK. Zero retries and one total deadline.
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
  `--live` requires positive HTTP/token/turn/output/time limits and environment
  credentials; execution model remains exactly `openai-gpt-6-luna` (unverified
  proxy alias), separate from default Jev 1.14 routing. No silent model substitution.
  Actual HTTP requests are capped before fetch. Tokens are an observed response
  boundary stop, not a strict monetary cap; unknown usage stops further requests.
  Preserve raw trial evidence and coverage; mock/empty charts are labelled clearly.
- `npm run benchmark:verify`: explicit harmless Docker/BenchFlow/Pi integration
  using loopback fake providers, no public CVE tasks and no real model calls.
  Python dependency setup and resume/report commands are in benchmark/README.md.
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
