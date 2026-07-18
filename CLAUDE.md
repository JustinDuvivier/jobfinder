# CLAUDE.md

Guidance for any AI agent (and human) working in this repository. **Read this first, every session.**

## What this project is

JobFinder is a personal, single-user, local LinkedIn job-application pipeline: scrape → score → decide → tailor resume (LaTeX/PDF, one page) → approve & save → track. It runs as **one Next.js (Node) process with a single SQLite file**.

## Sources of truth — read before writing code

Two documents define this project. Read both before implementing anything, and re-read the relevant section before each task.

1. **`PRD.md` — the requirements (what & why).** Goals, scope, non-goals, and the numbered functional/non-functional requirements (`FR-*` / `NFR-*`). The authority on *what to build and why*.
2. **`jobfinder-docs.md` — the technical design (how).** Architecture, module responsibilities, data model, route contracts, design patterns, and the security and one-page invariants. The authority on *how it is built*.

Rules for using the docs:

- **Every change must trace to a requirement in `PRD.md` and fit the design in `jobfinder-docs.md`.** If a task is not covered by either, stop and ask before building.
- **The docs win over assumptions.** If code and docs disagree, the docs are correct — unless you are explicitly updating them.
- **If the docs are wrong, ambiguous, or in conflict with each other, flag it and propose a fix** in the same change, rather than silently diverging. Code and docs stay in sync.

## Engineering principles

- **Justify everything; build only what is required.** Implement what the PRD/design call for and nothing more — no speculative features, no gold-plating, no abstraction without a second concrete caller. If you believe something beyond the docs is warranted, state the justification and get agreement *before* adding it. YAGNI by default.
- **Follow established best practices.** Clear module boundaries and single responsibility; small, pure, testable functions; dependency-light. Strong typing end to end (TypeScript — no `any` without a written reason). Handle errors at boundaries and fail loudly rather than silently. No dead code, no commented-out code, no copy-paste — extract shared logic. Keep functions and files small enough to hold in your head.
- **Match the documented architecture.** One Next.js process; route handlers under `app/api/` are the entire backend; SQLite via `better-sqlite3` is the only writer; SSE for the three streaming routes (`/api/scrape`, `/api/score`, `/api/rewrite`) and refetch elsewhere; status is a TypeScript union + a `transitions` table (**not** a class per status); the four patterns are the transition table, the scraper Strategy, the scrape Chain of Responsibility, and undoable Commands. Do not reintroduce removed complexity (no extra services, no second datastore, no real-time layer).
- **Honor the invariants.**
  1. **One-page guarantee** — `/api/save` must verify the compiled PDF is exactly one page and refuse otherwise.
  2. **Truthful rewrites** — only from the user's resume + source of truth.
  3. **Reversibility** — status-changing actions are Commands with working `undo`.
  4. **Atomic approval** — disk write + DB write succeed together or not at all.

## Security (non-negotiable)

- Build file paths server-side from identifiers (`job_id`, company, title, owner). **Never** accept a path string from the client. Same rule for "open folder."
- Compile LaTeX in a hardened sandbox: `pdflatex -no-shell-escape`, a hard timeout, restricted file reads, an isolated temp directory. LaTeX here is untrusted input (LLM-generated, then user-edited).
- The Anthropic API key stays server-side. Bind the server to `127.0.0.1`.

## Testing — required for every module

Tests are part of "done," not optional. No module is complete without them, and **no change merges with failing tests.**

- **One test file per module**, colocated (e.g. `path-builder.ts` → `path-builder.test.ts`). Cover the happy path, edge cases, and failure modes.
- **Test the deterministic logic hard** — this is where bugs hide and tests pay off:
  - Scrape HTML → normalized `Job` parser (including missing-field drops).
  - The scrape Chain of Responsibility: field parse → blocklist filter → dedup → validation → salary normalize, plus their ordering and short-circuiting.
  - The status `transitions` table: every valid transition allowed, every invalid one rejected.
  - `PathBuilder`: sanitization of illegal/reserved names, the disambiguator suffix, `MAX_PATH` truncation, `YYYYMMDD` ordering.
  - The LaTeX diff + semantic cleanup.
  - Command `execute`/`undo`, including the version-ID-based undo vs. autosave race.
  - The one-page page-count check and the SQLite read/write layer.
- **For the AI calls (score / rewrite / explain), do not assert exact model output** — it is non-deterministic. Mock the Anthropic client and test instead:
  - Request construction: prompt assembly, cache-breakpoint placement, model routing (Haiku for scoring, Sonnet for rewrite/explain), and `max_tokens`.
  - Response handling: JSON-shape validation, and `stop_reason: "max_tokens"` → a truncation warning rather than silently persisting a cut-off document.
  - The deterministic post-processing around the call.

### Golden file(s)

Maintain golden-master fixtures for the deterministic transforms so regressions surface as a diff:

- **`golden/jobs.parse.golden.json`** — a committed fixture of guest-API HTML (in `golden/fixtures/`) paired with the exact normalized `Job[]` the parser must produce. This is the primary golden file. The fixtures are **real captured responses from randomly sampled live jobs** (see each fixture's header comment for capture date and query), not hand-written HTML; synthetic edge cases live in the unit tests instead.
- **`golden/job-detail.golden.json`** — real captured `jobPosting/{id}` detail HTML (three jobs covering: criteria + applicants only, salary in prose only, dedicated salary block) paired with the exact `JobDetail` the detail parser must produce.
- **`golden/greenhouse.parse.golden.json`** — a real captured `active-ats` aggregator response (fantastic.jobs Active Jobs DB, direct data API, restricted to `source=greenhouse`; fixture in `golden/fixtures/greenhouse-active-ats.json`, capture date 2026-07-13) paired with the exact `RawJob[]` the Greenhouse response mapper must produce — pinning `gh:<id>` id namespacing, the real `*.greenhouse.io` posting URL, and the text description.
- **`golden/score.golden.json`** — the scoring-prompt eval set for comparing scoring models (e.g. Haiku vs. a local model): the three captured job details plus synthetic probe postings covering the failure modes absent from the real sample — overscore traps (`10+`/two-digit years reads, range floors, "none stated" inference) and recall-critical strong matches, where an underscore would hide a real match behind the FR-9a threshold filter (the costliest failure). Expectations are **constraint-based** (exact years read, quote fidelity, gap arithmetic, post-cap score ranges) rather than full-reply snapshots, since model output is non-deterministic. The test suite never calls a model with it; `lib/ai/score.golden.test.ts` pins the file's expectations to `requiredYearsFromQuote`/`gapScoreCap` so the eval set can't drift from the app's enforcement.
- Recommended additionally: a golden expected path for `PathBuilder` given fixed inputs, and a golden reference `.tex` that must compile to exactly one page (asserted via the page-count check).

How golden tests work here: the test runs the transform on the fixture and compares the result against the golden file. **When a change intentionally alters the output, update the golden file deliberately and review the diff in the same change — never auto-overwrite a golden file just to make a test pass.**

## Workflow for a task

1. Read the relevant `PRD.md` requirement(s) and `jobfinder-docs.md` section(s).
2. Confirm the work is justified by them; if not, ask.
3. Write or update the test (and golden fixture) for the behavior.
4. Implement the minimum that satisfies the requirement and passes the tests.
5. Run the full test suite; keep it green.
6. If anything in the docs changed in spirit, update the docs in the same change.

## Definition of done

- Traces to a `PRD.md` requirement and matches `jobfinder-docs.md`.
- Typed, lint-clean, no dead code.
- The module has a colocated test file; deterministic logic and AI-call contracts are covered; golden files updated intentionally if output changed.
- Invariants upheld (one-page, truthful rewrite, reversibility, atomic approval) and security rules followed (server-built paths, sandboxed compile, server-side key).
- The full test suite passes.
