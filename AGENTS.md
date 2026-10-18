# Jev Skill Router

## Product and boundary

Implement the confirmed Pi v1 specification from `pi-skill-router-spec.html`.
TypeScript native extension; Pi discovers skills and reads their original bodies.
Route each normal user request once. Reuse that choice during tool continuations.
Pinned paths and explicit `/skill:name` calls take precedence. Successful zero hits
and routing failures are different. Do not claim support for mid-run steering,
resumed pre-extension sessions, other harnesses, or removal of historical skills.

## Structure and data flow

- `src/pi-adapter.ts`: Pi lifecycle entry point and per-run structured skill catalog.
- `src/selection.ts`: canonical local path identity, deduplication and pinned clones.
- `src/router.ts`: one total routing deadline, cancellation and explicit fallback.
- `src/jev-client.ts`: official SDK batch Noul requests, strict response validation,
  sanitized failure codes, actual model version and token usage.
- `src/context.ts`: raw current input, bounded visible conversation and prior metadata.
- `src/config.ts`: defaults and validated user/project configuration merge.
  Its explicit model default is shared by routing and evaluation.
- `tests/*.test.ts`: core and real Pi provider-boundary integration tests.
- `eval/dataset.ts`: eight bounded synthetic metadata evaluation cases.
- `eval/run.ts`: preview by default; explicit `--live` runs real Jev requests and
  writes partial evidence after each request to `outputs/evaluation.json`.
- `eval/metrics.ts`: recall, false discoveries, zero hits, model, tokens and latency;
  never count full fallback as successful recall or claim unknown billed costs.
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

Data flow: `input` raw text -> `before_agent_start` complete catalog and two-level
config -> fixed baseline -> bounded shared state and independent Jev Noul questions
-> deadline/response validation -> selected original Skill objects (or explicit
fallback) -> `systemPromptOptions.skills` -> Pi native formatter -> provider.
Only assistant text is retained in extension-owned recent history; tool results,
thinking, skill bodies and session custom entries are excluded. Session reload
with existing messages is explicitly unsupported and skips routing. Diagnostics
persist as `jev-skill-router` custom entries and `/skill-router-status` displays
the latest report without raw task text or credentials.

## API conventions

- Jev credentials come only from `TYPESAFE_API_KEY`, never configuration files.
- Generic LLM integrations, if introduced later, prefer `LLM_API_KEY`,
  `LLM_BASE_URL`, and OpenAI Chat Completions. V1 needs no generic LLM call.
- Use the official TypeSafe JavaScript SDK. Zero retries and one total deadline.
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
