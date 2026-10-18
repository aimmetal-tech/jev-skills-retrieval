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
- `tests/*.test.ts`: core and real Pi provider-boundary integration tests.
- `package.json`: Pi package entry, dependencies, build and verification scripts.
- `tsconfig*.json`, `biome.json`: strict TypeScript build and lint configuration.
- `README.md`: scope, installation, implementation status and verification evidence.
- `LICENSE`: MIT license. `package-lock.json`: reproducible dependency resolution.
- `dist/`: generated package output; ignored. `.tmp/`, `outputs/`: local evidence;
  ignored. Never stage dependencies, generated packages, credentials or artifacts.

Data flow: `input` raw text -> `before_agent_start` complete catalog -> selected
original Skill objects -> `systemPromptOptions.skills` -> Pi native formatter.

## API conventions

- Jev credentials come only from `TYPESAFE_API_KEY`, never configuration files.
- Generic LLM integrations, if introduced later, prefer `LLM_API_KEY`,
  `LLM_BASE_URL`, and OpenAI Chat Completions. V1 needs no generic LLM call.
- Use the official TypeSafe JavaScript SDK. Zero retries and one total deadline.
- Compatibility baseline: `@earendil-works/pi-coding-agent@1.3.0`, specification
  source commit `482c1381a00d8d00bc81697e4a980c593db6803e`.

## Verification and commits

- `npm ci`: install the locked dependencies.
- `npm run check`: typecheck, Biome lint, meaningful tests, and production build.
- `npm run format`: apply formatting and organize imports.
- `npm pack --dry-run`: inspect package contents (runs the build).
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
