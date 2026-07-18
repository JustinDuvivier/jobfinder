# JobFinder — Documentation

**Version:** 3.1  
**Stack:** Next.js (App Router) · React · TypeScript · SQLite (better-sqlite3) · Anthropic API (Streaming) · LaTeX · PDF

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Architecture](#architecture)
4. [Design Patterns](#design-patterns)
5. [Module Reference](#module-reference)
   - [Setup](#setup-module)
   - [Jobs (Scrape & Score)](#jobs-module)
   - [Rewrite](#rewrite-module)
   - [Tracker](#tracker-module)
6. [AI Prompt Design](#ai-prompt-design)
7. [LinkedIn Scraping — Backend Integration](#linkedin-scraping--backend-integration)
8. [LaTeX + PDF Pipeline](#latex--pdf-pipeline)
9. [File System & Path Builder](#file-system--path-builder)
10. [Database Schema](#database-schema)
11. [API Reference](#api-reference)
12. [Status State Machine](#status-state-machine)
13. [Extending the App](#extending-the-app)
14. [Known Limitations](#known-limitations)
15. [Cost & Token Optimization](#cost--token-optimization)
16. [Deployment (Docker)](#deployment-docker)
17. [Local Dev Setup](#local-dev-setup)

---

## Overview

JobFinder is a six-stage job application pipeline. It lets you:

1. **Scrape** LinkedIn job listings for a given search query — dispatched as a background task, never blocking the UI
2. **Score** each job against your resume — on a local Ollama model by default, or Claude when selected — with scores arriving progressively as a concurrent batch finishes
3. **Decide** — decline or continue with each job
4. **Rewrite** your LaTeX resume for the specific role using Claude with streaming output — the rewritten LaTeX appears in the editor token by token; the change log (*what* changed) is computed server-side from the diff once the stream completes and persisted with the rewrite, and a separate asynchronous call produces an explanation of *why* each change was made
5. **Approve** the rewrite — the server compiles the PDF, confirms it is one page, saves it to disk under the configured output base directory (`JOBFINDER_OUTPUT_DIR`) as `{YYYYMMDD}/{Company}_{Job_Title}_{disambiguator}/{Owner}_Resume.pdf`, and writes the final status to SQLite in one operation
6. **Track** applications through the hiring pipeline (Applied → Interview → Offer / Rejected)

The AI work is routed for cost: scoring — a classification task — runs on the configured scoring backend, the local Ollama model by default (zero marginal cost) or Claude Haiku 4.5 when Anthropic is selected, while rewriting and explaining run on Claude Sonnet 5, where output quality matters more. The rewrite uses Anthropic's streaming API so output appears immediately rather than after a ten-to-twenty-second wait. The change log that populates the diff panel is computed server-side by the rewrite route, which diffs the original and rewritten LaTeX strings using a local library once the stream completes — Claude only needs to return the rewritten LaTeX itself, which keeps output token usage low and reduces the risk of mid-document truncation. (It does not eliminate it: the rewrite is still bounded by the `max_tokens` parameter, and that value must be set high enough for a full resume — see Known Limitations.)

A few lightweight patterns underpin the code — a status transition table, a scraper Strategy interface, an ordered scrape pipeline, and undoable Commands. Each solves a concrete problem (scattered conditionals, swappable scrapers, scraping that would otherwise time out the request, and lost work when an undo discards unsaved edits) rather than being added for ceremony. The Design Patterns section explains each.

---

## Tech Stack

### Frontend & server — Next.js (App Router)

The whole app is one Next.js application using the App Router — there is no separate backend service. Pages live under the `app/` directory with each major view — Jobs, Rewrite, Tracker, Setup — as its own route segment. React Server Components handle initial data fetching so the browser receives rendered HTML rather than an empty shell. Client Components handle interactivity: the streaming LaTeX editor, score updates, the approve button, and the command history.

Route handlers under `app/api/` are the entire backend. They own everything server-side: scraping, all Anthropic calls, LaTeX compilation, file writes, and every database write — the API key never leaves the server. Three routes stream to the browser as Server-Sent Events: `/api/rewrite` (LaTeX tokens), `/api/score` (each score as it lands during a batch), and `/api/scrape` (scrape progress). Everything else is a normal request that the UI re-fetches after the action it triggered. Everything runs in one Node process — no Python, no second service, no cross-process boundary to coordinate.

### Scraping & LaTeX — Node, not Python

Both jobs that once justified a Python service are plain Node work. Scraping the LinkedIn guest API is HTTP plus HTML parsing — `fetch` for the requests, `cheerio` (jQuery-style selectors) for the job cards — with no browser involved. Compiling LaTeX means shelling out to the locally installed `pdflatex` (TeX Live) via `child_process`, then reading the resulting PDF to confirm it is one page (`pdf-lib`, or parsing pdflatex's log). The compile itself is done by the pdflatex binary, so the runtime language is irrelevant to it. Neither task needs Python or a headless browser.

Because route handlers are request/response-shaped, the long-running scrape runs inside the `/api/scrape` handler and streams progress over SSE rather than as a detached background task — you trigger it and watch it finish. Concurrency where it matters — firing the per-job scoring calls in parallel — is a bounded `Promise` pool (for example `p-limit`), sized to Anthropic rate limits on that backend (the local Ollama server simply queues what it can't run).

### Database — SQLite (better-sqlite3)

A single local SQLite file is the entire persistence layer, accessed through `better-sqlite3` — a synchronous, in-process driver that is an excellent fit for a single-user local tool: no server, no connection pool, no network hop. The Next.js server is the only writer, so there is no second client and no write-authority split to reconcile, and the row/domain types are defined once in TypeScript.

Because there is a single local user and a single writer, the database needs no server, no auth layer, and no network access — the entire persistence story is one file. Keeping the UI live is handled two ways: the streaming routes push over SSE, and any view re-fetches after an action it performed. The cost is that two browser tabs or two devices will not auto-sync — a non-issue for one person running this locally. Exporting your data for your own analysis is just the SQLite file, or `sqlite3 jobs.db .dump`.

---

## Architecture

```
                    ┌─────────────────────────────────┐
                    │   Browser (React, one app)       │
                    │   /setup /jobs /rewrite /tracker  │
                    └────────────────┬─────────────────┘
                                     │  fetch / SSE
                    ┌────────────────▼─────────────────┐
                    │   Next.js server (Node)           │
                    │   route handlers = the backend    │
                    │                                   │
                    │   /api/scrape   fetch + cheerio   │
                    │   /api/score    p-limit → Ollama  │
                    │                 (or Haiku)        │
                    │   /api/rewrite  Sonnet (SSE)      │
                    │   /api/explain  Sonnet            │
                    │   /api/compile  spawn pdflatex    │
                    │   /api/save     path + write      │
                    │   /api/open-folder                │
                    └───┬───────────┬───────────┬───────┘
                        │           │           │
              ┌─────────▼──┐  ┌─────▼─────┐  ┌──▼──────────────┐
              │ Ollama /   │  │ pdflatex  │  │ SQLite (1 file) │
              │ Anthropic  │  │ TeX Live  │  │ better-sqlite3  │
              │ (score) +  │  │ child_proc│  │ 7 tables        │
              │ Sonnet     │  │           │  │                 │
              └────────────┘  └───────────┘  └─────────────────┘
```

**Anthropic API calls — three distinct contracts:**

| Call | Route | Output | Delivery |
|------|-------|--------|----------|
| Score job | `/api/score` | JSON `{score, reason}` | Synchronous response (or SSE per-score in a batch) |
| Rewrite resume | `/api/rewrite` (streaming) | Raw LaTeX tokens | Server-Sent Events to browser — the generation is a durable background job owned by the rewrite registry, not the request (see Rewrite Module) |
| Explain changes | `/api/explain` | JSON `{summary, bullets}` (or `{noChanges: true}` when the persisted diff records no edits — no model call) | Synchronous response, fired after the diff is computed |

The rewrite call streams LaTeX directly to the browser editor. Claude only returns LaTeX — no JSON change log. When the stream completes, the server computes the diff and persists it (as `resume_changes` rows) in the same transaction as the rewrite; the diff panel is populated from those persisted rows, and every subsequent autosave recomputes them in its own transaction so the persisted diff always describes the current document. A separate, non-blocking explanation call then takes the persisted diff blocks (the same rows the Changes panel renders) and the job description and returns a short bulleted rationale for *why* the changes were made; it renders in its own tab and never blocks editing.

**State flow:**

```
Scrape (/api/scrape) → fetch + cheerio → written to SQLite as NEW
              SSE streams each new job to the browser as it is inserted
  │
  ├─[Score] → /api/score (bounded p-limit pool over Ollama or Haiku)
  │            status NEW → SCORED; scores written as each call completes
  │            SSE delivers each score to the browser progressively
  │
  ├─[I pass] → PassJobCommand → status: SCORED → PASSED in SQLite
  │
  └─[I pursue] → ContinueCommand → status: SCORED → REWRITING; Rewrite view opens
                      │
                      ├─[AI Rewrite] → /api/rewrite streams LaTeX via SSE
                      │                client receives full LaTeX on stream end
                      │                on stream end the route diffs original vs new
                      │                (diff-match-patch, server-side)
                      │                rewritten_latex + diff + new version row in
                      │                rewritten_latex_versions — one transaction
                      │
                      ├─[Edit] → keystrokes autosaved to SQLite
                      │          each autosave writes new rewritten_latex_versions row
                      │          and recomputes resume_changes in the same transaction
                      │          undo points to version IDs, not field values
                      │
                      └─[Approve] → ApproveRewriteCommand → POST /api/save
                              │
                              ├─ handler builds path (YYYYMMDD format)
                              ├─ compiles LaTeX (cache-checked); confirms page count = 1
                              ├─ writes PDF to disk
                              ├─ writes approved_pdf_path + APPROVED to SQLite atomically
                              │  (single transaction — one writer)
                              │
                              └─[Enter Tracker] → status: APPLIED in SQLite
                                    │
                                    └─[Tracker status change]
                                          → INTERVIEW → OFFER → ACCEPTED
                                          → REJECTED | WITHDRAWN | GHOSTED
```

---

## Design Patterns

Four lightweight patterns are used, in the order they appear in the execution path — from the moment the scraper runs to the moment a user undoes a decision. None is heavier than the problem it solves: a status transition table, a swappable scraper interface, an ordered scrape pipeline, and undoable commands.

### Status transitions — Job lifecycle

The most important piece of the model. Every job moves through a granular set of statuses (see the Status State Machine): `new → scored → passed`, or `new → scored → rewriting → approved → applied →` one of `interview / rejected / withdrawn / ghosted`, with `interview → offer → accepted`. The model deliberately records who acted — `passed` (I declined the job) versus `rejected` (they declined me) versus `withdrawn` (I pulled out) — and keeps `new`, `scored`, and `rewriting` distinct rather than collapsing them into one undifferentiated state. Without a single source of truth for this, the logic leaks everywhere: the Jobs view checks whether a job is scored before showing Continue, the Tracker decides which statuses it displays, the score badge owns its own color rules, and every new status means hunting those branches down.

Rather than a class per status — the textbook State pattern, which is overkill here — the status is a TypeScript union type, and a single `transitions` table maps each status to the statuses it may move to and the actions available from it. The UI asks the table's guards ("can this job continue? can it be passed?") instead of hard-coding rules, and the status module also exports the named status sets — `DECISION_QUEUE_STATUSES` (triage) and `TRACKER_STATUSES` (approved and downstream) — from which the repo builds its SQL status predicates, so each set is spelled out exactly once. Adding a status later (say `on_hold` for a paused application) is one new entry in the union plus its row in the table and, if it belongs on the queue or the board, its named set — all in the one status module; the queries and views pick it up from there. Detailed statuses and a simple implementation are not in tension — the detail lives in data, not in a class hierarchy.

`approved` is a distinct status rather than jumping straight to `applied`, because approval does real work — it compiles the LaTeX, confirms one page, writes the PDF to disk, and records the saved path — and that has to be representable so it can be undone cleanly. An `approved` job is known to have a saved PDF on disk; an `applied` job reached through approval carries that same path but is now in the hiring pipeline. Collapsing them would mean the Tracker could not tell whether an applied job has a saved PDF or was moved there by hand.

There is no `saving` transient status. The `/api/save` handler owns the whole approval — disk write and database update — in one transaction. The status moves from `rewriting` straight to `approved` in a single write; if either the disk write or the database write fails, the handler returns a 500, the UI surfaces it, and nothing is left half-saved. The `scored` state allows passing and continuing (continuing only once a score exists; before that a job sits in `new` and offers neither); `rewriting` is where the resume is edited, with the status unchanged while editing; `approved` allows re-opening the rewrite or entering the tracker; `applied` and later allow neither scoring nor approving but keep the rewrite reopenable for reference. The `transitions` table enforces all of this.

### Strategy — Scraping

The scraper has two selectable implementations: static demo data and an HTTP client against LinkedIn's public guest job API (the default). These are not configuration options over the same code — they have genuinely different dependencies, different failure modes, and different setup requirements. The Strategy interface itself is the extension point for a future paid fallback if the guest endpoints ever stop being viable.

The Strategy pattern means each implementation satisfies the same interface: given the saved searches and a maximum count, yield job records. The active strategy name comes from Setup, and the `/api/scrape` handler instantiates the matching one. Swapping from demo to the live LinkedIn API is a configuration change, not a code change. The handler runs the strategy and streams progress over SSE, so the browser sees results arrive rather than waiting for the whole scrape to finish.

The interface also admits one orthogonal source that is *not* selectable in Setup: the Greenhouse aggregator (`StrategyName = ScraperStrategyName | 'greenhouse'`). It satisfies the same `ScraperStrategy` interface but runs **alongside** the Setup-selected primary strategy rather than replacing it — an on/off toggle, not a choice from the same list — so it is intentionally absent from the `createStrategy` factory and is constructed directly by the scrape run. See "Strategy D — Greenhouse (aggregator)" below.

### Chain of Responsibility — Scrape pipeline

Once raw job data comes back from the scraper strategy, it passes through a six-handler pipeline before being written to SQLite. The handlers are ordered to fail fast and avoid unnecessary work.

The field parser runs first, mapping raw scraped data to the Job schema. If it cannot extract a title or company, the job is dropped and logged — no subsequent handler runs. The title filter runs second (FR-4a): LinkedIn's experience-level filter (`f_E`) is poster-tagged and leaky, so a keyword search for "Software Engineer" still returns "Senior Software Engineer" postings; this handler drops any title that whole-word matches the configurable exclusion list (default: senior, sr, staff, principal, lead, manager, director, head of, vp, chief, scientist — keeping entry/junior/associate/mid). Matching is in-memory and case-insensitive, so it discards over-senior roles before any database round-trip; an empty list disables it. The blocklist filter runs third, immediately after the company is known: if the company is on the blocklist the job is dropped right there, before any database round-trip and long before scoring, which is the cheapest possible place to discard it. The deduplicator runs fourth, checking whether a job already exists in SQLite — placed after the in-memory title and blocklist checks so the database is never queried for a job already being discarded. The required-field validator runs fifth. The salary normalizer runs last, resolving the salary through the salary resolver (`lib/salary`) into a consistent display format. Only jobs that pass the title filter and blocklist, are new to the database, and are fully valid reach the normalizer.

The salary resolver (`lib/salary`) is the single owner of the salary precedence — explicit salary field, else deterministic mining of the description prose, else the optional AI lookup — and returns the normalized value with its provenance. The pipeline's salary stage, the post-detail enrichment in the scrape run, and `POST /api/salary` all resolve through it; only the salary route injects the AI tier (`lib/ai/salary`), so the scrape path stays deterministic and free.

### Command — User decisions

Any user action that changes a job's status should be undoable: passing on a job you meant to continue, changing a tracker status by accident, regenerating a rewrite you preferred the previous version of. The Command pattern wraps each action as an object with execute and undo methods. A `command_history` table in SQLite holds every executed command — action type, affected job ID, previous status, new status, and the version ID of `rewritten_latex_versions` the command operated on.

The version ID reference is what resolves the autosave-versus-undo conflict that a timestamp comparison cannot safely solve. A debounced autosave and an undo command can race over a timestamp comparison — the autosave fires milliseconds after the undo check reads the timestamp, but before the undo commits, meaning the check sees no conflict but the autosave then overwrites the restored state. A version ID reference has no race: undo restores by reading the specific version row it recorded when it executed, regardless of what autosave has written since. Autosave appends new version rows; undo reads a specific existing row by ID. The two operations no longer compete over the same data.

Approval is wrapped as `ApproveRewriteCommand`. Its execute method calls the `/api/save` route, which handles the entire approval atomically — disk write and database update in one transaction. Its undo method clears `approved_pdf_path` and sets status back to `rewriting` in SQLite — the rewrite draft is still there, so undo drops you back into the Rewrite view rather than the decision queue. The file on disk is left intact, which is intentional: deleting files on undo is a destructive action that requires separate, explicit confirmation.

The structural benefit of Command beyond undo is that every state-changing operation is a named, self-contained record. The command_history table tells you exactly what happened and in what order across sessions.

### Keeping the UI in sync

With a single writer and a single process, there is no cross-process change feed to subscribe to. Two mechanisms keep the UI current. While long work is in progress, the streaming routes (`/api/scrape`, `/api/score`, `/api/rewrite`) push events over SSE, so new jobs and scores appear as they are produced. For ordinary mutations, the view re-fetches — or the server re-renders via `revalidatePath` — after the action it performed. A user action also applies an optimistic update (passing a job dims the row immediately) and the subsequent refetch reconciles the canonical state.

The trade-off is that two browser tabs, or two devices, will not auto-update from each other — there is no shared channel pushing changes between them. For one person running this locally that situation never comes up.

---

## Module Reference

### Setup Module

**Route:** `/setup`

The Setup module is server-rendered. Initial values are loaded from SQLite on the server before the page is sent to the browser, so there is no loading flash. It has two modes:

**Guided first-run onboarding (FR-33).** Until onboarding is finished, `/setup` *is* the guided flow, and every pipeline page is gated behind it: all pipeline pages live in the `app/(pipeline)` route group (the group segment is invisible in URLs), whose layout is the **single gate boundary** — it redirects to `/setup` while `needsOnboarding` (`lib/resume/onboarding.ts`) holds: onboarding never finished AND no user base resume anywhere (neither a `resume_assets` row nor a `resume/base_resume(.old).tex` file). The flow is one required step — the user's own base LaTeX resume, in an editor prefilled with the effective content (the committed starter on a fresh install), where saving is explicit and PUT-gated by a sandboxed compile that must produce exactly one page — followed by three optional steps (source of truth, scoring prompt, rewrite rules), each prefilled with its effective content and labeled "works as-is out of the box — customize only if needed". The source-of-truth step instructs the user to align it with what their base resume actually claims (including an explicitly stated years-of-experience figure — the experience-gap logic reads it); the scoring-prompt step warns that the parsed JSON output contract must stay intact. When a `resume/` base-resume file is already mounted, the resume step shows "found your resume file — using it" and confirms instead of demanding a paste. Finishing POSTs `/api/onboarding`, which sets `user_config.onboarding_complete`.

**Documents (always editable after onboarding).** The four resume assets resolve **per file** through `resolveResumeAssets` (`lib/resume/load.ts`): an **in-app-authored asset** (the `resume_assets` table, written via `/api/resume-assets`) wins; else the user's private, gitignored `resume/` directory; else the committed generic starter in `resume-example/` (FR-32/FR-33). A fresh clone therefore runs end to end with zero configuration, as "Alex Candidate". The Documents card on `/setup` shows each asset's effective content with a provenance badge (`in-app` / `file` / `example`), saves an asset in-app (the base resume compile-gated to one page), and reverts an in-app asset to its fallback per file. `effectiveConfig` (`lib/config/effective.ts`) is the thin camelCase adapter the AI paths read the same resolution through.

**Inputs (the settings form):**

| Field | Description |
|-------|-------------|
| Search keywords & locations | The saved-search inputs (FR-2/FR-25). The LinkedIn guest strategy runs the **cross product** of keywords × locations with fixed filters. Stored as JSON arrays in `user_config` (`keywords`, `locations`), defaulting to the documented set. |
| Scraper Strategy | Which scraping implementation the scraper should use: Demo (static sample jobs, for trying the app out) or the LinkedIn guest API (the default). Stored in user config and sent as a parameter when scraping is triggered. |
| Also scrape Greenhouse | An orthogonal on/off toggle (FR-5a): when on, the Greenhouse aggregator source runs **alongside** whichever primary strategy is selected. Persisted as `user_config.greenhouse_enabled` (0/1). See "Strategy D — Greenhouse (aggregator)". |
| RapidAPI key: set/missing | A read-only presence indicator for the aggregator key (`RAPID_API_KEY`) the Greenhouse source needs. It reflects **environment presence only** (a boolean) — the key value is read server-side and never reaches the client, so Setup can flag "enabled but keyless" without exposing the secret. |
| Scoring model (curated dropdown) | Which model scores jobs (FR-6/FR-6b), as one selector with four options: the small default `qwen3:4b-instruct-2507-q4_K_M` (recommended — ~2.5 GB, CPU-friendly), the tuned `batiai/qwen3.6-27b:iq3` (higher accuracy — labeled with its ~11 GB download and ~16 GB-GPU / slow-on-CPU guidance; both from `CURATED_OLLAMA_MODELS` in `lib/ai/models.ts`, evaluated in `docs/scoring-model-eval.md`), Claude (the Anthropic Haiku backend), and a custom-Ollama-tag option that reveals a free-text input and preserves the any-tag capability. The dropdown is presentation only: it persists the same two fields (`user_config.scoring_backend` + `user_config.ollama_model`, mapped losslessly both ways by `app/setup/scoring-choice.ts`), so existing installs land on the right option unchanged. Each local option shows its installed / not-installed status against the connected Ollama, with an in-app **Download** for absent models (below). |
| Owner name | Your name as it appears in the saved PDF filename. Defaults to `Alex_Candidate`. Stored in SQLite and read by PathBuilder. |
| Blocked companies | A list of company names to exclude. Stored in the `blocked_companies` table and applied by the scrape pipeline before jobs are inserted, so blocked companies never reach the database and are never scored. Managed (add/remove) like other user config. |

**In-app model download (FR-6b).** The scoring dropdown reads `GET /api/ollama/models` for per-tag installed status (every curated tag plus the stored custom tag, probed with the same `/api/show` check scoring preflights with) and offers **Download** on an uninstalled local selection. Download `POST`s the tag; the server runs `ollama pull` against `OLLAMA_BASE_URL` (compose sidecar or native), consuming Ollama's NDJSON progress stream into an in-memory record (`lib/ai/ollama-pull.ts`, one pull at a time). Progress reaches the client by **polling the same GET** on a short interval — deliberately *not* SSE, which stays reserved for the three streaming routes (`/api/scrape`, `/api/score`, `/api/rewrite`); a model pull is a minutes-long background transfer where 1–2s polling granularity is plenty. A finished pull (success or failure) is reported by exactly one poll and then cleared, so failures (Ollama down, disk full, bad tag) surface once as a clear error without ever blocking the rest of Settings. Known limitation: the progress record is process-local, so a server restart mid-pull forgets it — the download continues inside the Ollama daemon, and the next status poll simply reflects the actual installed state. Downloading is a convenience only; scoring with a still-absent model fails loudly exactly as before (`ensureOllamaModel`).

The output base directory lives in the server's environment config rather than in `user_config`, since the server resolves the final path. The more specific the Source of Truth, the better the rewrites — include quantified metrics, technologies, team sizes, and business impact.

---

### Jobs Module

**Route:** `/jobs`

The Jobs page is the decision queue, so it loads only the jobs that need a decision — `status IN ('new', 'scored') AND below_threshold = 0` — never the whole table. The server-side query is decisive: it filters on status and the auto-filter flag, selects only the columns the table renders (company, title, location, salary, score, score rationale, status, `created_at` — never the heavy `rewritten_latex` or explanation columns), orders by `created_at` descending, and pages the results. It does not `select *` and filter in React. (`new` rows are still being scored and show a "scoring…" state; `scored` rows are the ones awaiting your decline/continue decision.) Passed, rewriting, approved, and later-stage jobs are excluded by the `WHERE` clause, not hidden client-side; they remain in the table as retained data, queried by the Tracker (approved and later) or by separate aggregate queries for analytics. A composite index on `(status, created_at desc)` keeps the query fast as history grows.

**Auto-filter (FR-9a).** `below_threshold` is a boolean *flag* on the `jobs` row, deliberately orthogonal to `status` — it records "scored under the cutoff," not a lifecycle state, so it composes with any status without bloating the union. It is written in the same statement as the score: `/api/score` reads the configured `score_threshold` (a `user_config` column, default 50; 0 disables) and passes `score < threshold` into `setScore`, which sets the flag alongside the score and the `new → scored` transition. The split between operational and analytical reads is the whole point: the decision-queue query adds `AND below_threshold = 0` so flagged jobs never reach triage, while data reads — `listAllJobs` (Companies), the dashboard's score distribution — intentionally omit the predicate and count every scored job. Because the row is retained, not deleted, the filter is non-destructive and reversible by lowering the threshold for future scores; nothing is lost. Live, the `/api/score` SSE event carries a `filtered` boolean so the client drops a flagged row from the queue the instant its score lands rather than flashing it and reconciling on refetch.

Pagination is keyset (cursor on `created_at`), newest first, with a fixed page size rather than an unbounded list. While a scrape or scoring run is active, an SSE stream keeps the page live — new jobs appear as they are inserted (`new`) and the `new → scored` transition arrives as each score lands. Outside a run, the page is static until you act on it or navigate. Removals from the queue are user-initiated — passing or continuing transitions a row out of triage — and the optimistic update on that action removes the row immediately, with a refetch reconciling the rest.

Workflow:

1. Clicking "Scrape LinkedIn" opens an SSE stream from `/api/scrape`. The handler runs the guest-API scrape, writing a `scrape_sessions` row when it starts and updating it when it finishes, and inserts jobs into SQLite as it parses them. Each insert is pushed over the SSE stream, so the Jobs view fills in progressively and shows "Scraping in progress…" until the stream closes — no polling, no manual refresh.
2. Score individual jobs or use "Score All" for batch scoring. Both paths call Claude Haiku 4.5 against a plain-text extraction of your resume (not the LaTeX source), with the stable prefix prompt-cached — see *Cost & Token Optimization*. Individual scoring is a single request to `/api/score`; "Score All" sends all job IDs to the same route, which fires the per-job calls through a bounded `p-limit` pool — sized to your tier's rate limits, not unbounded. Because that bounds *concurrency* rather than tokens-per-minute, `429` responses are caught and the affected job is retried after the `Retry-After` delay so the requests-per-minute and tokens-per-minute ceilings are respected. Each score is written to SQLite as it completes and pushed to the browser over SSE — for a batch of twenty jobs, scores populate one by one over a few seconds rather than all arriving after a long wait.
3. Expand any job row to read the AI scoring rationale.
4. Pass or Continue. Pass executes a `PassJobCommand` — I'm declining the job; its status changes from `scored` to `passed` in SQLite, the command is written to the history table, and the row leaves the queue (dimmed/removed). Continue executes a `ContinueCommand` — status changes to `rewriting` and the Rewrite view opens for that job. (Passing is *me* declining the job; it is a different status from `rejected`, which is the company declining me later.)

**Score interpretation:**

| Range | Meaning |
|-------|---------|
| 75–100 | Strong match — your background directly fits the role |
| 50–74 | Moderate match — worth applying with a targeted rewrite |
| 0–49 | Weak match — significant gaps; consider declining |

---

### Rewrite Module

**Route:** `/rewrite/[jobId]`

The Rewrite page is a dynamic route parameterized by job ID. The job record — including any previously generated rewritten LaTeX — is loaded from SQLite on the server. If a rewrite already exists for this job, the page opens with it already populated. The persisted diff lives in `resume_changes` (not on the job row, so the jobs list stays lightweight) and is read alongside the job in the same server render to feed the Changes panel.

Workflow:

1. The job's title, company, description, your original resume, and any existing rewritten LaTeX are loaded into a side-by-side view. The left pane shows the LaTeX editor. The right pane shows the PDF preview iframe, the changes panel (the diff), and a "Why these changes" tab for the rewrite rationale.

2. Clicking AI Rewrite opens a Server-Sent Events stream from Next.js's `/api/rewrite` route. The generation itself is **a durable, server-owned background job**, not something bound to this request: the route calls `registry.start(jobId, () => runRewrite(…))` on the process-local **rewrite registry** (`lib/rewrite/registry`) and then streams by `subscribe`-ing to it. The registry runs the injected runner — the rewrite execution `lib/rewrite/run`, which builds the prompt, opens the Anthropic streaming response, and persists on completion — **detached from any HTTP response**, so the generation survives the user navigating to another job or reloading the page (Path B). It accumulates the streamed tokens so a connected or reconnecting client's `subscribe` receives the accumulated-so-far text followed by subsequent tokens, and it records the terminal kind (`done | truncated | error`). `start` is **idempotent per job**: a second call for a job already running *attaches* to the in-flight generation rather than starting a second one, so re-opening the stream (e.g. on reconnect) can never double-pay or race two results into the same job. The registry is *not* a second datastore — it holds transient lifecycle state only; the durable result still lives in SQLite via the runner's `RecordRewrite` command — and it has no Anthropic dependency (the runner is injected; tests pass a fake). The route stays a thin edge: it keeps its pre-stream guards and maps the registry's terminal outcome to the same SSE event types the client already handles. The LaTeX editor populates token by token in real time — the first content appears within one to two seconds. The prompt instructs Claude to return only the rewritten LaTeX document, no change log. A job that is not editable (not in `rewriting`) is refused with a **409 before the stream opens** — the same error shape `/api/autosave` returns for the same rule — so the client's ordinary request-error path handles it; the execution's own not-editable check survives only as a race fallback, surfaced as an SSE `error` event. Both paths share one message, defined once in the command layer (`rewriteNotEditableMessage`, `lib/commands`).

   **Cross-page status and reconnection.** Because the generation is decoupled from the page that started it, the operator can move freely between jobs while rewrites run. A read-only `GET /api/rewrite/status` returns `registry.snapshot()` — a coarse per-job state (`running | done | truncated | error`, with company/title to render and link), where terminal states linger briefly so a returning page can see "just finished" before they clear. A small always-visible indicator, mounted once in the root layout so it renders on every page, polls that route on a short interval and lists jobs currently rewriting and recently finished/failed, each linking to its rewrite page — so the operator always knows a background rewrite is working, done, or failed without staring at a blank page, and never re-triggers a rewrite they already paid for. This coarse poll is deliberately chosen over an app-wide second SSE channel; the live token stream stays scoped to the rewrite page via `subscribe`. On load, `/rewrite/[jobId]` hydrates the persisted result from SQLite as before and then makes one **attach-only reconnect** request (`POST /api/rewrite` with `reconnect: true`). Attach-only means it *never* starts a generation — so it can neither double-pay nor clobber a result that finished while away, closing the reconnect/finish race by construction. If the registry reports the job `running`, the route streams the in-flight generation and the registry replays the accumulated-so-far text, so the editor fills in real time — matching the experience of never having left. If nothing is running, the route answers with a single `idle` event and the client instead auto-compiles the already-hydrated resume (below). Streaming state is entered eagerly on a button click but only once tokens actually arrive on reconnect, so a normal load with nothing running never flashes "Generating…". When the SSE consumer disconnects (navigation, reload), the route releases its subscription via the sink's `onCancel`; the generation itself lives on in the registry, and the registry fans out to each subscriber in isolation so one disconnected client's closed stream can never abort the shared generation or starve the others.

3. Once streaming completes, the rewrite execution runs a local diff between the original LaTeX and the new LaTeX using `diff-match-patch` — on the server, not in the browser. The diff is computed synchronously in under a hundred milliseconds regardless of resume length. The rewritten LaTeX, the computed diff (as `resume_changes` rows), a new `rewritten_latex_versions` row labelled as an AI generation, and the command_history record are all written to SQLite in a single transaction by the record-rewrite command, which derives the first-generation-vs-regeneration distinction from whether the job has an active rewrite (the denormalized `rewritten_latex`) — deliberately not from bare version-row existence, because an undone first generation leaves its `ai_generation` row behind and recording that orphan as the undo target would resurrect content the user discarded. A first generation records a null prior-version pointer, so undoing it restores the no-rewrite state — no LaTeX, no diff, and no stored explanation. The Changes panel renders the persisted diff: each changed block shows the removed text in red strikethrough and the added text in green. This is what the user sees as the "change log" — it is derived from the actual text delta, not from Claude's self-description of what it changed. In parallel, a non-blocking explanation call is fired (the just-persisted diff blocks and the job description as inputs); when it returns, the "Why these changes" tab populates with a bulleted rationale. Editing remains fully available while this call is in flight.

4. The LaTeX editor is fully writable after a rewrite. Each keystroke batch is autosaved to SQLite via debounced autosave and also written as a new row in `rewritten_latex_versions`, stamped with a timestamp and labelled as a manual edit. The same autosave transaction recomputes the persisted `resume_changes` rows against the effective base resume — the recorded diff is **live with the document**, not scoped to the last AI generation, so the Changes panel (FR-13) and the explanation call's input always describe the LaTeX as it stands now rather than edits the user has since removed. Undo operations reference specific version row IDs rather than timestamps, which eliminates the race condition between a concurrent autosave and an undo commit.

5. Compile PDF is available two ways. Opening a job **auto-compiles the current resume on load** — the rewritten LaTeX if a rewrite exists, otherwise the original — so the PDF preview shows a compiled page immediately rather than a blank pane until the operator clicks Compile (FR-16). The manual **Compile** button remains for recompiling hand-edits, and a completed foreground rewrite still auto-compiles its result. Auto-compiling on every open is cheap because `/api/compile`'s SHA-256 hash cache returns the bytes for unchanged LaTeX without re-invoking `pdflatex`. Compile is otherwise button-triggered — it does not fire on every keystroke. (If a live-updating preview is added later, the `/api/compile` call must be debounced by 2–3 seconds so active typing does not spawn a `pdflatex` process per character.) Pressing it sends the current rewritten LaTeX to the `/api/compile` route. The handler hashes the LaTeX with SHA-256 and checks a bounded in-memory LRU cache before invoking `pdflatex`. On a cache hit, PDF bytes are returned immediately. On a miss, `pdflatex` runs with `SOURCE_DATE_EPOCH` set to a fixed value so the output is byte-for-byte deterministic for identical input — which is required for the hash-based cache to be reliable. The cache hits where it matters most: re-compiling unchanged source on the preview-then-approve path, on undo/redo to a previously compiled version, and on re-approval. The browser renders the bytes in the iframe, and the preview reports the compiled page count so you can see at a glance whether the resume is still one page. Nothing is written to disk. The cache is bounded (LRU with a fixed maximum entry count) so it cannot grow without limit, and it is process-local — empty after a restart.

6. Regenerate calls `/api/rewrite` again with the same inputs. The stream opens, the editor repopulates, and once complete the diff is recomputed. The same record-rewrite command runs, this time recording the version ID of the row that was active before the regeneration (a `RegenerateRewrite` entry in command_history). Undoing a Regenerate restores by reading that specific version row by ID — it does not compare timestamps and does not need to warn about concurrent autosaves, because the version pointer unambiguously identifies the target state. The undo also recomputes the persisted diff for the restored LaTeX and clears the stored explanation: the rationale justified the discarded generation, and unlike the diff it cannot be recomputed deterministically (explanations are not versioned), so the Why tab empties until explain is re-run for the restored document.

7. Approve executes `ApproveRewriteCommand`. The browser sends `job_id`, `company_name`, `job_title`, and `owner_name` to the `/api/save` route — no path string. The handler constructs the output path internally, checks the compile cache, and **confirms the compiled PDF is exactly one page** — if it is not, it refuses to save and surfaces an error so you can trim the resume first. On a valid one-page PDF it writes the file to disk, then writes `approved_pdf_path` and status `APPROVED` to SQLite in a single transaction. If the disk write fails, the database write never happens; if the database write fails after a successful disk write, the transaction rolls back and an error is returned. The UI surfaces the error and the status remains unchanged. On success, a confirmation banner displays the saved path relative to the base directory.

8. From Approved, clicking "Send to Tracker" updates the status to Applied via a `ChangeTrackerStatusCommand`.

The Approve step is intentionally separate from the preview compile. You may compile and view the PDF many times while editing before committing.

---

### Tracker Module

**Route:** `/tracker`

The Tracker page loads all jobs in Approved or later status from SQLite, ordered by last status change descending. The page is server-rendered with fresh data on every navigation; after you change a status, the page re-fetches so the counts update.

Jobs enter the Tracker when approved in the Rewrite view and then explicitly moved to Applied. The Approved status is a staging area — the resume is saved to disk but the job is not yet considered actively in the hiring pipeline.

Every status change in the Tracker is a `ChangeTrackerStatusCommand` written to the history table. Each change is undoable from a dedicated undo button.

**Weekly view (FR-24a).** A week stepper in the control card filters both the board and the table to one Monday-start calendar week, bucketed by the job's `created_at` (the week it was scraped, converted from SQLite's UTC timestamp to local time). The page opens on the current week — an empty week renders an explicit "no jobs scraped this week" card rather than falling back — and ‹ › walk every calendar week between the oldest tracked job and today; an **All** button clears the filter. The funnel bar, status chips, and column counts recompute over the selected week so the whole page describes that week's jobs. The filtering is pure client-side state in `TrackerClient` over the already-loaded rows (no extra query or route); the week math lives in `lib/week.ts`. A row whose `created_at` fails to parse stays visible in every week rather than silently vanishing.

**Statuses visible in the Tracker:**

| Status | Meaning |
|--------|---------|
| Approved | Resume saved to disk. Staging state before entering the pipeline as Applied. |
| Applied | I submitted the application. |
| Interview | At least one interview scheduled or completed. |
| Offer | Offer received. |
| Accepted | I accepted the offer. |
| Rejected | They declined me after I applied. |
| Withdrawn | I pulled out after applying (including declining an offer). |
| Ghosted | Applied, no response after a long silence. |

Each row with an `approved_pdf_path` shows two affordances. **View PDF** (FR-35) is a plain link to `GET /api/jobs/pdf?jobId=…`, which streams the saved PDF inline so the browser renders it in a new tab — available natively and in the container alike. The folder icon calls the `/api/open-folder` route with the row's `job_id`; the handler resolves the saved path from SQLite (never from the request) and opens the containing directory in the OS file manager (`explorer.exe`, `open`, or `xdg-open`). In container mode (`JOBFINDER_CONTAINER=1`, FR-30) there is no host file manager to spawn: the route returns `{ opened: false, dir, relativeDir }` with the still-containment-verified path, and the UI copies `relativeDir` — the `./output/...` form relative to the user's docker-compose folder, computed server-side (`composeRelativeDir`), not a raw container path — to the clipboard with a hint saying so. Metric cards at the top are SQLite counts by status, refreshed when a status changes.

---

## AI Prompt Design

### Scoring prompt

The scoring call is handled by the `/api/score` route through a **backend seam** (`ScoringBackend`, resolved once per run in `lib/scoring/warm-first.ts` from the Setup config): by default it runs on the **local Ollama model** (`qwen3:4b-instruct-2507-q4_K_M`, `lib/ai/ollama.ts` — zero marginal cost, a ~2.5GB pull sized for CPU-only machines, thinking disabled, temperature 0, context sized for the longest captured postings via `OLLAMA_NUM_CTX`; the tuned 27B override for capable GPUs is documented in `docs/scoring-model-eval.md`), and on **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) when the Anthropic backend is selected. Scoring resume-job fit and returning a number plus a few sentences is a classification task a small model handles — the accuracy-critical work (years read, gap cap, park) is deterministic code either way, and the golden scoring eval set (`golden/score.golden.json` + `scripts/eval-score-golden.mts`) is how backends are compared before a default changes. Both backends send the **identical prompt text** — the Ollama body is built from `buildScoreRequest`'s own blocks — and both replies flow through the same `parseScoreText` pipeline, so quote re-derivation, the gap cap, and the FR-6a park hold regardless of backend. The local backend fails loudly (unreachable server / unpulled model → the run errors before any job is attempted; jobs stay `new`) rather than falling back to Anthropic. The system prompt positions the model as a career coach evaluating fit and constrains it to return only JSON.

The user message provides a **plain-text extraction of the resume** — not the LaTeX source — and the job posting, and specifies the exact output shape: a numeric score from zero to one hundred and a rationale string of three to four sentences covering strengths and gaps. Fit-scoring does not depend on LaTeX markup (`\textbf{}`, environments, braces), which is pure token overhead here; the LaTeX source is reserved for the rewrite, which actually edits it.

The request is structured for **prompt caching**: the stable prefix — system prompt, the code-owned parsing contract (below), Source of Truth, and the plain-text resume — sits before the cache breakpoint, and only the job posting (which varies per job) comes after it. Across a run's batch of jobs scored within the cache window, the first call writes the cache and the rest read it at a fraction of the input cost. See *Cost & Token Optimization* for the economics, including why the prefix must clear Haiku's minimum cacheable size.

JSON-only output makes parsing deterministic. An explicit format example prevents the model from hallucinating key names. Score and rationale in a single call avoids a second round-trip. The zero-to-one-hundred range maps cleanly to the green/amber/red score badge.

**The parsing contract (`SCORING_CONTRACT`).** The scoring prompt is user-editable in Settings, so the output shape the parser depends on cannot live only there. `buildScoreRequest` appends a code-owned contract block after the user's prompt (the same pattern as the rewrite's `REWRITE_OUTPUT_OVERRIDE` — later wins on conflict) restating exactly what `validateScore` enforces: the JSON shape, the verdict enum and coercion, the quote-and-cap mechanics, and a compact reference reply. It doubles as the guarantee that the cached prefix clears Haiku's 4096-token cache floor — see *Prompt caching* under Cost & Token Optimization.

**Keeping Haiku honest on the experience gap.** The one place a cheap model reliably failed was the years-of-experience read — it would shrink "10+ years required" to "1-3" and call an underqualified candidate a strong match, which poisons both the score and the tale of the tape. Rather than pay for Sonnet on every scoring call, the brittle work is moved out of the model: the prompt makes Haiku **copy the requirement phrase verbatim** into an `experience` block and estimate its own years, and `lib/ai/score.ts` then (1) re-derives the required years from that quote in code (`requiredYearsFromQuote` — the floor of any range, never shrunk), (2) recomputes the gap, and (3) caps the final score by the gap (`gapScoreCap`: 1–2 yrs → 70, 3–4 → 50, 5+ → 30). Copying a phrase is reliable for a small model; the number-reading and subtraction are deterministic TypeScript. The prompt also carries two worked examples (a large gap that must score ~30, and a clean match) to anchor the read. Net effect: Haiku's price with a gap read the score can trust.

One exception guards recall (FR-6a). When the copied quote carries **no readable years figure** (`requiredYearsFromQuote` yields null — "none stated", but also quotes whose digits aren't years, like "99.99% availability"), the requirement — and therefore the gap — is the model's *inference*, not the posting's statement, and a bad inference once let the cap crush a genuine match below the FR-9a auto-filter (a local quant read "Senior ≈ 6 years" into an unmarked AI-engineer role). So a sub-70 cap on such a quote is not applied: `validateScore` parks the persisted score at exactly **70** (`PARKED_REVIEW_SCORE`) and sets `parkedForReview` in the stored rationale, which `ScoreReason` renders as a "requirement inferred — review" badge. The same parking covers a years-free quote whose experience numbers fail to parse (no gap is computable, and a low raw score may be the model's self-applied cap), and `persistScore` exempts parked results from the FR-9a threshold filter, so the job reaches the decision queue at any threshold and the user decides. Stated-years quotes keep the full cap behavior; inferred requirements with gaps of ≤ 2 years keep their real score.

### Rewrite prompt

The rewrite call uses Anthropic's streaming API, proxied as Server-Sent Events from the Next.js `/api/rewrite` route. The prompt instructs Claude to return only the rewritten LaTeX document — no JSON wrapper, no change log array. This is the most important design decision in the prompt: by removing the change log from the AI's responsibilities, the output token requirement drops by roughly half, the risk of mid-document truncation drops accordingly, and the streaming implementation is straightforward because the model is outputting a single document rather than a JSON structure with embedded LaTeX.

The fabrication guardrail — "only incorporate true information from the source of truth" — is in the system prompt as a standing constraint, not a polite request in the user message. The Source of Truth is passed alongside the original resume so the AI can draw on accomplishments not yet formally written up. The rewrite request is also structured for prompt caching: the system prompt, Source of Truth, and original resume LaTeX form the stable cached prefix, with the specific job description after the breakpoint, so rewriting several jobs in one session re-reads the prefix cheaply rather than re-billing it each time.

Once the stream closes, the record-rewrite command computes the character-level diff between the original and rewritten LaTeX with `diff-match-patch` synchronously on the server, then runs `diff_cleanupSemantic()` on the result so the rendered diff coalesces character-level churn into human-meaningful chunks rather than highlighting fragments of LaTeX commands. The result is persisted as `resume_changes` rows in the same transaction as the rewrite and displayed in the Changes panel. This diff is more accurate than a model-described change log because it reflects exactly what changed in the text, not a summary the model wrote about what it intended to change.

Note that the diff is computed over LaTeX *source*, so it shows markup changes (`\textbf{}`, braces) rather than rendered content. The diff answers *what* changed; the explanation call below answers *why*.

### Explanation prompt

The diff alone cannot say why a change was made — a character delta has no access to the strategic reason behind an edit. To satisfy the requirement that the Rewrite view explain *why* a change was made, a third Anthropic call runs after the diff is computed. It is deliberately separate from the rewrite stream so it never blocks editing.

The call is handled by the `/api/explain` route and returns a synchronous JSON response — `{summary, bullets}` — because the explanation is short and streaming buys nothing here. The prompt is given two inputs: the job's persisted diff blocks (the same `resume_changes` rows the Changes panel renders, formatted as the resume with edits marked inline in `<removed>`/`<added>` tags and long unchanged runs elided to context) and the job description. Feeding the recorded diff rather than a plain-text rendering of the two resumes keeps the *why* tied to the recorded *what*: the diff is over LaTeX source, so markup-only edits (e.g. bolding a metric) reach the explainer — the plain-text stripper (which unwraps `\textbf{X}` to `X`) would erase them and let the two panels disagree. It also cuts prompt tokens, since unchanged text is elided instead of sent twice. Passing the job description is essential: without it the model can only describe the edits ("added a metric"), not justify them ("added the p99-latency metric because the posting emphasizes high-throughput systems"). The system prompt positions the model as explaining the edits a career coach made, and constrains it to concise, non-generic bullets tied to specific job requirements. The result renders in its own tab in the Rewrite view alongside the diff. The result is stored on the job row (`explanation`), not wrapped as a Command — the stored rationale describes the last *explained* state, and re-running the call simply overwrites it (manual edits and regenerations leave it in place until then; the Rewrite view re-fires the call after each generation). Undoing a rewrite generation clears it (both the restore-prior-version and restore-no-rewrite branches), so the recorded "why" is never left describing a discarded "what" (invariant #3); explanations are not versioned, so the defined post-undo state is empty until explain is re-run. When the persisted diff records no edits at all (the document is identical to the base resume), the route skips the model call and returns a benign `200 {noChanges: true}` instead of an error, clearing any explanation left over from an earlier state so the "why" can never describe changes the Changes panel no longer shows; the Rewrite view renders this as an intentional empty state in the Why tab rather than an error banner.

---

## LinkedIn Scraping — Backend Integration

The scraper runs inside the `/api/scrape` route handler. The handler opens an SSE stream, writes a `scrape_sessions` row to SQLite with status `running`, and starts the scrape. It runs the active strategy, passes results through the scrape pipeline, writes new jobs to SQLite, and pushes each insert down the SSE stream so the Jobs view fills in as it goes. When the run finishes it updates the session row to `completed` with a timestamp and closes the stream. Because the work happens inside the request, there is no separate background-worker process to run or coordinate — you trigger the scrape and watch it complete.

The scrape runs in-process, so a hard process death (crash, `Ctrl-C`, power loss) kills an in-flight scrape without running its cleanup — which would otherwise leave the `scrape_sessions` row stuck in `running` and the Jobs view showing "Scraping in progress…" indefinitely. Two mechanisms close this:

- **Startup reconciliation.** On boot, the server marks any session still in `running` as `failed` with an "interrupted by restart" error. Any session that was live when the process last died is cleaned up automatically.
- **Heartbeat / staleness.** The running scrape periodically touches the session's `updated_at`. A `running` session with no update for N minutes is treated as stale by the UI, which also covers a wedged-but-not-dead process.

For a single-user local tool this is sufficient and adds no dependency. If you later add the scheduled scrape (see *Extending the App*) and want runs to survive restarts and retry automatically, move the scrape out of the request into a small Node job runner — a script started by the OS scheduler (cron on macOS/Linux, Task Scheduler on Windows) that writes to the same SQLite file, or a lightweight in-process scheduler such as `node-cron` paired with the reconciliation above. A heavyweight job queue is unnecessary at this scale.

The scrape pipeline is a Chain of Responsibility with six handlers, ordered to fail fast. The field parser runs first — if it cannot extract a job id, title, or company, the job is dropped and nothing else runs. The title filter runs second, dropping over-seniority titles (FR-4a) before any DB hit. The blocklist filter runs third: if the parsed company is on the blocklist, the job is dropped immediately, before any SQLite round-trip and before it could ever be scored — this is what keeps blocked companies from costing scoring tokens. The deduplicator runs fourth, checking the job id against existing SQLite records; jobs that already exist are dropped before the last two handlers run. The required-field validator runs fifth. The salary normalizer runs last, resolving through the salary resolver (`lib/salary`) and applied only to jobs that pass the filters, are new, and are valid.

### Endpoints and searches

The live scraper uses LinkedIn's public **guest** job endpoints — the ones that back the logged-out jobs browse experience — so it needs no account, no cookies, and no browser:

- **Search:** `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` with query params for keywords, location, the filters below, and a `start` offset. It returns a chunk of job-card HTML, which the field parser maps to job IDs, titles, companies, locations, and posting times.
- **Posting detail:** `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}` returns, for one job: the full description, LinkedIn's structured job-criteria block (seniority level, employment type, job function, industries), an applicant-count caption ("Over 200 applicants"), and — only when the employer disclosed one — a dedicated salary block. The description body is employer-authored HTML from a limited tag set (`p`, `br`, `ul`/`li`, bold/italic); the parser converts it to plain text that **preserves paragraph breaks and `- ` bullets**, so the scoring and rewrite prompts see distinct sections rather than one run-on line. When no salary block exists, the salary is mined from the description prose — the detail enrichment resolves through the salary resolver (`lib/salary`), with the dedicated salary block as the field tier. Detail is fetched only for jobs that survive the blocklist and deduplicator, so detail requests are not wasted on jobs about to be discarded.
- **View link:** `https://www.linkedin.com/jobs/view/{job_id}` is the human-facing URL stored on the job row (and written into the output) so a row is clickable.

The scraper runs a fixed set of saved searches — the cross product of the configured keywords and locations:

- **Keywords:** AI Engineer · Machine Learning Engineer · ML Engineer · Software Engineer · Forward Deployed Engineer · Solutions Engineer
- **Locations:** New York · New Jersey
- **Filters applied to every search:** last 24 hours (`f_TPR=r86400`), full-time (`f_JT=F`), and entry-level + associate (`f_E=2,3`).

Each search is paginated by incrementing `start` (in steps of 25) until a page returns empty or a per-search cap is reached. The same job often appears under more than one keyword (an "ML Engineer" role matches both "ML Engineer" and "Machine Learning Engineer"), so deduplication is by `job_id` and runs *across* all searches — each unique posting is fetched in detail and scored exactly once, no matter how many searches surfaced it.

### Strategy A — Demo

Returns a static list of sample jobs without any backend dependencies. The returned jobs still pass through the scrape pipeline before being written to SQLite.

### Strategy B — LinkedIn Guest API (default)

The production strategy. Issues plain HTTP requests (`fetch`) to the guest endpoints above and parses the returned HTML (`cheerio`) — no browser, no login, no session cookies, so there is no account to get banned. It walks each saved search's pages via `start`, parses the cards, and fetches `jobPosting/{job_id}` detail only for new, non-blocked jobs. Because it is unauthenticated, rate limiting is **IP-based**: keep delays modest between requests, set a realistic `User-Agent`, and handle `429`/empty responses by backing off. It can still be throttled or temporarily IP-blocked, but it cannot get a LinkedIn account suspended, because it uses none.

### Strategy C — removed (was Proxycurl)

A paid Proxycurl fallback was documented here but never implemented, and has been removed as a selectable strategy. The `ScraperStrategy` interface is the extension point: if the guest endpoints ever stop being viable, a paid fallback is one new class satisfying the interface plus its `createStrategy` case. Databases that stored `'proxycurl'` are migrated to `'linkedin'` on open, and the old `user_config.search_url` column it reserved is left in place as a vestigial column (see Database Schema).

### Strategy D — Greenhouse (aggregator)

An **orthogonal second source**, not an alternative to A/B/C: when enabled it runs **alongside** whichever primary strategy is selected (FR-5a), pulling Greenhouse-hosted postings from the **fantastic.jobs "Active Jobs DB"** aggregator restricted to Greenhouse. It is gated on `greenhouseEnabled && RAPID_API_KEY present`; an enabled-but-keyless configuration is surfaced as a run **warning** rather than silently skipped. It satisfies the same `ScraperStrategy` interface as the LinkedIn strategy, so it flows through the identical Chain-of-Responsibility pipeline into the same merged decision queue.

It calls `GET https://data.fantastic.jobs/v1/active-ats` with `Authorization: Bearer <key>`. The query params are: `title` (the keyword), `location`, `time_frame` (the aggregator's fixed bucket — `1h`/`24h`/`7d`/`6m` — chosen as the smallest bucket that still covers `searchLookbackHours`), `source=greenhouse` (the ATS restrictor), `description_format=text`, `limit` (page size), and `offset` (pagination). It shares the same saved-search config as LinkedIn — keywords × locations enumeration and `searchLookbackHours` — walking each keyword×location search, paginating by `offset`, deduping by aggregator job ID within the run, and backing off on `429`.

*Auth reconciliation:* the same vendor exposes this product both as a RapidAPI-marketplace API (proxy host + `X-RapidAPI-Key`/`X-RapidAPI-Host` headers) and as a direct fantastic.jobs data API (Zuplo-gated at `data.fantastic.jobs`). The provisioned key is a **direct** data-API key (a `zpka_…` value), which is *not* subscribed on the RapidAPI marketplace and returns `403 "not subscribed"` through the proxy — so the strategy uses the direct endpoint with Bearer auth. Despite the environment variable's name (`RAPID_API_KEY`), the ATS restrictor is `source=greenhouse` (not `ats=`) and the auth is Bearer (not the RapidAPI headers). The RapidAPI proxy variant is documented but unused for this reason.

The search response is **already complete** — each item carries the description (requested as text), salary when the employer disclosed one, and the real posting URL — so the response→job mapping populates a `RawJob` directly: the aggregator id is namespaced `gh:<id>` (collision-free against LinkedIn ids for cross-source dedup), and the record's `url` is always set from the response's real `*.greenhouse.io` posting link, so the pipeline's LinkedIn-URL fallback never applies. `fetchDetail` is therefore a **no-op** (there is nothing to enrich). Salary is passed through **only when natively present** and is never synthesized — the truthfulness invariant means the strategy adds no salary the aggregator did not supply.

Operationally the source is a first-class peer of the primary strategy: it gets its own per-run `MAX_JOBS` budget, opens its own `scrape_sessions` row (tagged `greenhouse`), and contributes its own found/blocked/inserted counts to the scrape summary's per-source breakdown. Inserted rows carry `source = 'greenhouse'` provenance, which the decision queue renders as a source badge.

**Recommendation:** Use the guest API as the primary source (the default). Run it on demand (or on an interval while the app is open). Greenhouse is **additive**, not an alternative to the guest API: turn it on to widen coverage with aggregator-sourced Greenhouse postings running in the same run, and leave it off to run LinkedIn alone.

---

## LaTeX + PDF Pipeline

### Why LaTeX?

LaTeX gives you precise typographic control, a plain-text format the AI can edit directly (and stream back token by token), version-controllable source, and professional PDF output. The rewrite AI streams a LaTeX document — not a PDF — so the PDF is generated on demand. You can edit the LaTeX after a rewrite and compile a fresh PDF without going back through the AI.

### Two compile operations

**Preview compile** (`POST /api/compile`): the handler receives the LaTeX source, hashes it with SHA-256, and checks an in-memory cache. On a hit, cached PDF bytes are returned immediately without invoking `pdflatex`. On a miss, `pdflatex` runs with `SOURCE_DATE_EPOCH` set to a fixed epoch value. This suppresses the compilation timestamp that `pdflatex` normally embeds in the PDF metadata, making the output byte-for-byte identical for identical input — a prerequisite for the cache to be reliable. The handler also reads the resulting PDF's page count (via `pdf-lib`, or by parsing the pdflatex log) and returns it alongside the bytes, so the preview can flag a resume that has spilled onto a second page. The temp directory is cleaned up after each compile. Nothing is written to the output directory, and the route touches no database state.

**Approve compile** (`POST /api/save`): the handler receives only a `job_id` — never a path string (or any name segment) from the browser; the company, title, and owner name are read from SQLite. The saga itself — compile → one-page gate → path build → disk write → atomic DB commit — lives in the approval orchestrator (`lib/approval/orchestrator.ts`) with the compiler and filesystem as injected dependencies, so every failure ordering is unit-tested; the route is a thin mapper from the orchestrator's discriminated result to HTTP responses. It builds the output path internally from the server's own environment config. The compile cache is checked first; on a miss, `pdflatex` runs. **The PDF's page count is then verified to be exactly one** — if it is not, the handler refuses to save and returns an error, so an over-length resume can never be written to disk. On a valid one-page PDF, the file is written at the computed path (creating the directory tree if needed), and then `approved_pdf_path`, status `APPROVED`, and the LaTeX source hash are written to SQLite in a single transaction. If the disk write fails, the transaction never opens. If the transaction fails after the disk write, it rolls back. In either case the error is surfaced in the UI and the status is unchanged. The approve route is not idempotent by design — re-approving the same job overwrites the existing PDF at the same path, which is the intended behavior.

### Compile sandboxing

Both compile endpoints run `pdflatex` on LaTeX that is LLM-generated and then user-edited — an untrusted input class. The compile invocation is hardened on three axes:

- **No shell escape.** `pdflatex` is invoked with `-no-shell-escape`. Modern TeX Live and MiKTeX already default to *restricted* shell-escape (a small command whitelist), but passing the flag explicitly closes even that whitelist and removes any dependence on the local configuration, so `\write18` cannot execute commands regardless of environment.
- **A hard timeout.** The `pdflatex` subprocess is wrapped in a timeout (a few seconds is generous for a one-page resume) and killed on expiry. This defends against a "LaTeX bomb" — deeply nested or self-referential macros that otherwise spin the compiler forever.
- **Restricted file reads.** `-no-shell-escape` does not stop `\input{/etc/passwd}` or `\openin` from pulling local files into the PDF. Set `openin_any`/`openout_any` to a restricted/paranoid value, or run the compile inside an isolated temp directory with no access to sensitive paths. The temp directory is cleaned up after each compile.

Both `/api/compile` and `/api/save` apply all three, since both run the same untrusted source.

### LaTeX template guidance

The AI rewrite works most reliably with a simple, standard template using only `geometry`, `hyperref`, `enumitem`, and `titlesec`. These are universally available in TeX Live and produce clean, ATS-readable output. Exotic packages or custom fonts increase the chance that the AI produces LaTeX that fails to compile. A failed compile on the approve route surfaces an error, the database transaction never commits, and the job's status remains unchanged — a clean failure, but an annoying one. Keeping the template simple prevents it.

---

## File System & Path Builder

### Why path construction lives on the server

The full output path must never travel from the browser to the server as a string in the request body. If it did, the server would have to trust it — a malformed company name could traverse directories before sanitization runs. Building the path server-side also keeps it correct regardless of what the client is.

The correct boundary is: the browser sends a single identifier (`job_id`); the `/api/save` handler reads the job's company, title, and the owner name from SQLite and constructs the absolute path internally using PathBuilder, which reads the base directory from the server's own environment variables. The constructed path is returned in the response so the UI can display it in the confirmation banner, but it flows out of the server, not into it.

The same rule applies to `/api/open-folder`. It does **not** accept a path string from the client; it receives a `job_id`, reads `approved_pdf_path` for that job from SQLite, verifies the path resolves inside the configured base directory, and opens that directory. An "open folder" action is an OS shell operation, so a client-supplied path here would be a worse trust violation than a file write — the identifier-in, path-out boundary is enforced for it just as it is for `/api/save`.

`GET /api/jobs/pdf` (FR-35) holds the same boundary for a file *read*: a `jobId` query parameter in, the SQLite-stored `approved_pdf_path` containment-verified against the base directory, and only then the PDF bytes streamed out. A stored path that escapes the base is refused before a single byte is read — the client can view the PDF the server chose to serve, never name a file to fetch.

### PathBuilder

PathBuilder is a pure utility on the server — no side effects, no I/O — that assembles the output path from four segments in order: the base directory from environment config (`JOBFINDER_OUTPUT_DIR`), a date folder in ISO 8601 `YYYYMMDD` format using today's date at the moment of approval, a company-plus-title folder, and the filename. Segments are joined with the **platform separator** (`node:path`'s `sep` — backslash on native Windows, forward slash on macOS, Linux, and in the Docker container), while segment *names* are always held to the stricter Windows sanitization rules below, so an output tree written on any OS remains valid when copied to any other.

The `YYYYMMDD` format is used rather than `DDMMYYYY` so that folders sort chronologically in Windows Explorer and every other file system browser without any configuration. `20260618` sorts before `20260625`; `18062026` and `25062026` sort in the wrong order.

The company-plus-title folder combines the sanitized company name and the sanitized job title — for example, `Stripe_AI_Engineer`. Sanitization strips Windows-illegal characters (`< > : " / \ | ? *`), trailing dots and spaces, and avoids reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`); spaces become underscores. Using company-plus-title as the default (rather than company alone) prevents the silent overwrite that would occur when approving two distinct roles at the same company on the same day. `Stripe_AI_Engineer` and `Stripe_Backend_Engineer` are separate folders; both PDFs are preserved without any manual intervention.

Company-plus-title still collides in one narrow case: two genuinely distinct postings that share both company and title on the same day (common at large employers with multiple identical reqs). To make the path collision-free by construction, the folder is suffixed with a short disambiguator derived from the job — a hash slice of the stable `job_id`, e.g. `Stripe_AI_Engineer_a1b2c3`. Because the suffix is derived from the stable `job_id`, re-approving the *same* job still maps to the same folder (so re-approval remains an intentional overwrite). PathBuilder also guards against the Windows `MAX_PATH` limit of 260 characters on every platform (portability again): an unusually long company-plus-title is truncated — always preserving the disambiguator suffix, which is what keeps the path collision-free — so the full path stays within the limit even under a long base directory.

### Expected output structure

A native Windows run with `JOBFINDER_OUTPUT_DIR=C:\Users\Alex\Resumes\Jobs` (any OS works; this is just an example):

```
C:\Users\Alex\Resumes\Jobs\
  └── 20260618\
        ├── Stripe_AI_Engineer_a1b2c3\
        │     └── Alex_Candidate_Resume.pdf
        ├── Stripe_Backend_Engineer_d4e5f6\
        │     └── Alex_Candidate_Resume.pdf
        └── Anthropic_Research_Engineer_7a8b9c\
              └── Alex_Candidate_Resume.pdf
```

In the Docker container the base is `/output` (bind-mounted to `./output` on the host — see Deployment), so the same approval lands at `./output/20260618/Stripe_AI_Engineer_a1b2c3/Alex_Candidate_Resume.pdf` on the host.

Re-approving the same job (same `job_id`, hence the same disambiguated folder) overwrites the existing PDF — the most recently approved version wins. This is the intended behavior when you edit and re-approve the same application.

---

## Database Schema

A single SQLite file stores all persistent application state. The schema has nine tables.

**user_config** holds the settings from the Setup module: the saved-search inputs (`keywords` and `locations`, JSON arrays — the cross product the LinkedIn guest strategy runs, FR-2/FR-25), the active scraper strategy name (`'linkedin'` default / `'demo'`), the `greenhouse_enabled` flag (INTEGER 0/1, default 0 — the orthogonal Greenhouse-source toggle, FR-5a, that runs the aggregator source alongside the primary strategy), the owner name, the auto-filter cutoff `score_threshold` (INTEGER, default 50; 0 disables — see FR-9a), the scoring backend (`scoring_backend`, `'ollama'` default / `'anthropic'`) with its local model tag (`ollama_model`, default `qwen3:4b-instruct-2507-q4_K_M` — FR-6), and the `onboarding_complete` flag (INTEGER 0/1, default 0 — set when the FR-33 guided flow finishes; the migration grandfathers databases that predate the column to 1, since their owner already ran the app). The output base directory lives in the server's environment config. One row per user. Databases created before FR-33 carry vestigial `resume_latex` / `source_of_truth` / `scoring_prompt` / `rewrite_rules` columns; the migration copies any non-empty value into `resume_assets` once and blanks the column, so a later per-file revert is never resurrected on restart. Databases that predate the removal of the never-implemented Proxycurl strategy likewise carry a vestigial `search_url` column (unused, left in place — nothing reads or writes it), and a stored `'proxycurl'` strategy value is coerced to `'linkedin'` by the same migration pass.

**resume_assets** holds the in-app-authored resume assets (FR-33) — the top layer of the per-file resolution in-app → `resume/` file → `resume-example/` starter (see the Setup module). One row per authored asset: `name` (TEXT primary key, CHECK-constrained to `base_resume` / `source_of_truth` / `scoring_prompt` / `rewrite_rules`, mirroring `RESUME_ASSET_NAMES` in `lib/types.ts`), `content`, and `updated_at`. A row exists only for an asset the user authored in the app; deleting it (the per-file revert in `/api/resume-assets` DELETE) makes that asset resolve to its file/example fallback again. Because rows live in the SQLite file (the `/data` volume in Docker), in-app assets survive restarts even though the `./resume` bind mount stays read-only.

**jobs** is the primary table. Each row carries: company, title, location, salary, description, posting URL, posting date, a `source` provenance column (`TEXT`, `'linkedin'` | `'greenhouse'`, default `'linkedin'`, `CHECK`-constrained and mirroring the `JobSource` union in `lib/types.ts`; assigned at insert time and used for cross-source dedup safety, the queue's source badge, and the per-source scrape counts), the detail-page enrichment fields (`seniority_level`, `employment_type`, `job_function`, `industries` — LinkedIn's structured job-criteria block — plus the raw `applicants` caption), current status, AI score, score rationale, a `below_threshold` boolean flag (the FR-9a auto-filter marker, orthogonal to `status` — set when the score lands under the configured cutoff, and excluded from the decision-queue query while retained for analytics), the current rewritten LaTeX source, the change explanation (the bulleted *why* rationale, as JSON `{summary, bullets}`), the approved PDF path, a `latex_hash` column for the SHA-256 hash of the most recently compiled LaTeX, and creation and update timestamps. The computed diff is **not** stored here — it lives only in `resume_changes` (see below) so the jobs list stays lightweight. The current rewritten LaTeX source on this row is a denormalized cache of the latest `rewritten_latex_versions` entry; every write path that appends a version also updates this field, and the two must not be allowed to drift. The `status` column is a `TEXT` value constrained by a `CHECK` to a granular set that records who acted at each stage: `new` (scraped, unscored), `scored` (scored, awaiting my decision), `passed` (I declined the job), `rewriting` (I'm pursuing it; rewrite in progress), `approved` (rewrite approved, PDF saved), `applied`, `interview`, `offer`, `accepted` (I took the offer), `rejected` (they declined me after I applied), `withdrawn` (I pulled out after applying, including declining an offer), and `ghosted` (applied, no response after a long silence). The distinctions are deliberate: `passed` (I declined the job, pre-application) is separate from `rejected` (they declined me, post-application) and from `withdrawn` (I pulled out); and `new`, `scored`, and `rewriting` are distinct so an untouched job, a job awaiting my decision, and a job I am actively rewriting are never confused. There is no `saving` value — the approval operation is atomic within the `/api/save` handler and does not require a transient database state.

**resume_changes** is the single home for the computed diff from the server-side `diff-match-patch` run the record-rewrite command performs, inside the same transaction that persists the rewrite, after each AI generation. Undoing a regenerate rewrites these rows in the same way — the diff is recomputed against the restored LaTeX inside the undo transaction — and manual editor autosaves recompute them too, in the same transaction that updates `rewritten_latex` (all three paths share one helper), so the stored diff always describes the current document rather than a discarded generation or hand edits the user has since removed. Each row belongs to a job and carries the diff block type (insert, delete, equal), the text content, and a sequence number for ordering. The diff is stored here and nowhere else (it is not duplicated onto the jobs row), because the diff payload can be large and the jobs list should be fetchable without it.

**rewritten_latex_versions** is the version history for the rewritten LaTeX. Every autosave writes a new row (type `autosave`), and every AI generation writes a new row (type `ai_generation`). Each row carries: the job ID, the full LaTeX content, the source type, and a timestamp. The `command_history` table references specific version row IDs — undo restores by reading a version row by ID, not by comparing timestamps. This eliminates the race condition between a concurrent autosave and an undo commit.

**command_history** is the undo stack. Each row records: command type (Decline, Approve, ChangeTrackerStatus, RegenerateRewrite), the affected job ID, the previous status, the new status, the `rewritten_latex_versions` row ID that was active when the command executed, and a timestamp. Every AI generation lands here, including the first for a job — recorded as a RegenerateRewrite with a null version pointer, so undoing it restores the no-rewrite state. Undo reads the most recent command for a given job and reverses the recorded transition, restoring `rewritten_latex` from the referenced version row if applicable and recomputing the persisted `resume_changes` diff to match the restored LaTeX (or clearing both when the restored state predates any generation).

**scrape_sessions** tracks scrape runs. Each row records: the strategy used, the number of jobs found, the number dropped by the blocklist, the number inserted (after the blocklist filter and deduplication), a status (`running`, `completed`, `failed`), and start and end timestamps. The `/api/scrape` handler creates the row when a run starts and updates it when the run finishes or errors; the Jobs view reflects progress from the SSE stream, and the row is what startup reconciliation inspects to clear a run interrupted by a restart.

**blocked_companies** is the company blocklist. Each row carries a normalized company name (lower-cased, trimmed) and the timestamp it was added; an index on the normalized name makes the scrape pipeline's blocklist lookup a fast indexed check rather than a scan. Rows are added and removed as user-driven config writes. The scrape pipeline reads this table (or a cached copy refreshed each run) to drop matching jobs before insert; when a company is newly blocked, an optional one-time delete removes any existing jobs from that company that are still in `new` or `scored` so they do not linger in the decision queue.

**ai_calls** is the per-request AI telemetry ledger (FR-27) — one row per AI call, Anthropic or local. Each row records: the call type (`score`, `score_batch`, `rewrite`, `explain`, `salary`), the model id that served the call (an Ollama tag for local scoring), the job it belongs to (nullable, `ON DELETE SET NULL` so trace rows outlive deleted jobs), the four usage token counts (`input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`), an estimated `cost_usd` snapshot computed at write time (prices change, so the estimate is never recomputed later), latency, the stop reason, an `error` message when the call failed, and a timestamp. Indexed on `job_id` (per-job trace-back: `SELECT sum(cost_usd) FROM ai_calls WHERE job_id = ?`) and `created_at` (the dashboard's time-window rollups). Writes are best-effort via `lib/ai/telemetry.ts` — a failed insert is logged and swallowed, never failing the scoring/rewrite/lookup it observes. See *AI call telemetry* under Cost & Token Optimization.

---

## API Reference

All routes are Next.js route handlers under `app/api/`. The browser calls them; together they are the entire backend.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/scrape` | Opens an SSE stream; runs the guest-API scrape in-process; writes a `scrape_sessions` row; streams each inserted job and a final `completed` event |
| POST | `/api/score` | Bounded `p-limit` pool (sized to tier rate limits, with `429`/`Retry-After` retry) over the configured scoring backend — the **local Ollama model** by default, **Haiku 4.5** with the stable prefix cached when Anthropic is selected — scoring the plain-text resume; writes each score to SQLite and streams it over SSE. See *Cost & Token Optimization*. |
| POST | `/api/rewrite` | Starts (or attaches to) a **durable background rewrite** on the rewrite registry — an idempotent-per-job **Sonnet 5** generation that runs detached from this request — and streams its LaTeX tokens to the browser as Server-Sent Events; a non-editable job (not `rewriting`) is refused with a 409 before the stream opens, matching `/api/autosave`. With `reconnect: true` it is **attach-only** (never starts a generation): it streams an in-flight one or emits a single `idle` event so the page auto-compiles the persisted resume instead |
| GET | `/api/rewrite/status` | Read-only; returns `registry.snapshot()` — a coarse per-job state (`running / done / truncated / error`, with company/title) for the always-visible cross-page rewrite indicator to poll |
| POST | `/api/explain` | Synchronous **Sonnet 5** call returning `{summary, bullets}`, fired after the diff is computed. When the persisted diff records no edits it makes no model call and returns a benign `200 {noChanges: true}` (clearing any stored explanation) — a no-change generation is a valid outcome, not an error. |
| POST | `/api/compile` | SHA-256 cache check; `pdflatex` with `SOURCE_DATE_EPOCH` on miss; returns PDF bytes **and page count** — no disk write |
| POST | `/api/save` | Receives identifiers only; builds path; compile (cache-checked); **verifies exactly one page**; disk write; atomic SQLite commit of `approved_pdf_path` + `APPROVED` |
| POST | `/api/open-folder` | Receives a `job_id`; reads `approved_pdf_path` from SQLite; verifies it is inside the base directory; opens that folder in the OS file manager. Never accepts a path string. Returns `{ opened, dir }`; in container mode (FR-30) it skips the spawn and returns `opened: false` plus `relativeDir` — the directory as `./output/...` relative to the compose folder — so the UI offers copy-path (in the form that exists on the host) instead. |
| GET | `/api/jobs/pdf` | Streams a job's approved PDF to the browser (FR-35). Receives a `jobId` query parameter only; reads `approved_pdf_path` from SQLite; verifies it is inside the base directory before streaming (`application/pdf`, `Content-Disposition: inline` so the tab renders it). 404 for a job without an approved PDF; never accepts a path string. |
| POST | `/api/salary` | Finds a missing salary through the salary resolver (`lib/salary`): explicit field → description prose → AI web-search lookup on **Haiku** (the injected tier). Persists a newly found value; returns `{ salary, source }`. |
| POST | `/api/jobs/salary` | Manually sets (or clears) a job's salary — the user typing in a value they found; no AI involved. |
| GET/POST | `/api/schedule` | The backend auto-run scheduler (PRD §12). **GET** returns status — `intervalMinutes`, `nextRunAt` (epoch ms the Jobs view counts down to), `running`, `lastRunAt`, `lastSummary`. **POST** is "Run now": triggers a server-side scrape+score immediately (non-blocking) and the post-run reschedule resets the countdown. See *Scheduled scraping*. |
| GET/PUT/DELETE | `/api/resume-assets` | In-app authoring of the four resume assets (FR-33). **GET** returns each asset's effective content plus provenance (`in-app` / `file` / `example`). **PUT** `{name, content}` saves one asset to `resume_assets` — the base resume only after a sandboxed compile proves an exactly-one-page PDF, else **422** with the compiler log or page count surfaced. **DELETE** `{name}` reverts one asset to its file/example fallback and returns the now-effective content. |
| GET/POST | `/api/ollama/models` | The Settings scoring selector's model status and in-app download (FR-6b). **GET** returns `{ reachable, models: [{tag, installed}], pulling }` — installed status for every curated tag plus the stored custom tag, and the active pull's progress record (`{tag, status, completed, total, done, error}`); an unreachable Ollama is a `200` with `reachable: false`, never a Settings-blocking error. The client polls this while a pull runs (start-then-poll refetch; SSE stays reserved for the three streaming routes). **POST** `{tag}` starts a server-side `ollama pull` — only a curated tag or the stored `user_config.ollama_model` passes validation (after a tag-format check), `409` while another pull runs, `202` on start. A finished pull is reported by exactly one GET, then cleared; the record is process-local (a restart mid-pull forgets it — the next GET reflects actual installed state). |
| POST | `/api/onboarding` | Marks the FR-33 guided first-run flow finished (`user_config.onboarding_complete = 1`); the `(pipeline)` route-group gate stops redirecting to `/setup`. |

Reads for the Jobs and Tracker pages are issued directly from React Server Components as SQLite queries, not through these routes. User-driven status changes (Pass, Continue, tracker transitions) are small writes the server performs, after which the page re-fetches. The Next.js server is the only writer, so reads and writes never have to be reconciled across processes.

---

## Status State Machine

Each status maps to an entry in the `transitions` table that defines which actions are available and which transitions are valid. The set is granular on purpose: it records who acted at every stage, so the data you later export distinguishes a job you passed on from one that rejected you, and an untouched job from one you are mid-rewrite on.

| Status | Stage | Who acted / meaning |
|--------|-------|---------------------|
| `new` | Triage | Scraped, not yet scored. The scorer picks these up. |
| `scored` | Triage | Scored, in the decision queue, awaiting my decline/continue decision. |
| `passed` | Pre-application (terminal) | **I declined the job** — chose not to apply. |
| `rewriting` | Pursuing | I'm continuing with it; resume rewrite in progress, not yet approved. |
| `approved` | Pursuing | Rewrite approved, PDF saved to disk, staged before applying. |
| `applied` | Pipeline | I submitted the application. |
| `interview` | Pipeline | At least one interview scheduled or completed. |
| `offer` | Pipeline | Offer received. |
| `accepted` | Terminal | **I accepted the offer.** |
| `rejected` | Terminal | **They declined me** after I applied. |
| `withdrawn` | Terminal | **I pulled out** after applying (includes declining an offer). |
| `ghosted` | Terminal | Applied, no response after a long silence. |

The three distinctions that matter most: `passed` (I declined the job, before applying) is not `rejected` (they declined me, after applying) or `withdrawn` (I pulled out); and `new` / `scored` / `rewriting` are distinct so no single state has to stand in for an untouched job, a scored-but-undecided job, and a job mid-rewrite all at once.

```
  [scraped] ─► new ─[score-batch]─► scored
                                      │
                        ┌─────────────┴─────────────┐
                [PassJobCommand]            [ContinueCommand]
                I decline the job            I pursue it
                        ▼                           ▼
                     passed ◄─[PassJobCommand:  rewriting ─[ApproveRewriteCommand:
                   (terminal)   not a match]──┘ (status unchanged  compile + save PDF, atomic]
                                        while editing)                 │
                                                                       ▼
                                                    approved ─[undo]─► rewriting
                                                                       │
                                                              [Send to Tracker]
                                                                       ▼
                                                                    applied
                                                                       │
                ┌──────────────────┬───────────────────┬──────────────┴───────┐
                ▼                   ▼                   ▼                       ▼
            interview            rejected           withdrawn               ghosted
          (they invited me)  (they declined me)   (I pulled out)         (no response)
                │
          ┌─────┴─────┐
          ▼           ▼
        offer    rejected / withdrawn
          │
    ┌─────┴─────┐
    ▼           ▼
 accepted     withdrawn
(I took it)  (I declined the offer)
```

The Rewrite view does not change the job's status — it stays `rewriting` while you edit. The status only moves to `approved` when you click Approve and the `/api/save` handler atomically completes the disk write and database update.

`approved` is a holding state between the Rewrite view and the hiring pipeline. It records that a PDF has been saved and where. Moving to `applied` requires an explicit action in the Tracker — it does not happen automatically — because you may approve a resume days before you actually submit.

The triage transitions (`scored → passed`, `scored → rewriting`) are user commands (`PassJobCommand`, `ContinueCommand`), and every transition from `applied` onward is a `ChangeTrackerStatusCommand` written to the command_history table — so each terminal outcome (`accepted`, `rejected`, `withdrawn`, `ghosted`) is an explicit, undoable choice. `passed` jobs are retained as data but sit outside the active Tracker pipeline.

---

## Extending the App

### Cover letter generator

Add a `/api/cover-letter` route (or a `draftCoverLetter` helper alongside the other Anthropic calls). It takes the same inputs as the rewrite — resume, Source of Truth, job — and instructs the model to write a concise, non-generic cover letter in three paragraphs with no filler language. Unlike the rewrite, the cover letter is short enough that streaming is less critical; it can be returned as a synchronous JSON response. The result is stored in a new `cover_letter` column on the jobs table and rendered in a third panel in the Rewrite view. Generation is wrapped as a Command in the history table.

### ATS keyword analysis

Since the diff is computed from the actual text delta rather than from Claude's self-description, ATS keyword tracking becomes straightforward deterministic work over the persisted `resume_changes` rows (read back via the same path the Changes panel uses). Extract the words in the inserted (green) segments and compare them against the job description's most frequent terms. Display the overlap as a checklist in the Rewrite view with coverage percentage. No additional AI call needed.

### Follow-up email drafting

Add a `draftFollowUp` helper (or a `/api/follow-up` route) alongside the other Anthropic calls. Trigger it from the Tracker when a job has been in Applied status for more than seven days. It takes the job's title and company and returns a brief professional follow-up email body. Store the draft on the job record and show a "Draft ready" indicator in the Tracker row.

### Scheduled scraping

Scraping always runs on demand, but it also repeats on a cadence set in Setup (`run_interval_minutes`; `0` = manual only). The schedule lives in the **backend**, not the browser: a process-wide scheduler singleton in the Node server (`lib/schedule/`) owns the timing, so the next-run time is authoritative and runs continue even with no tab open. The countdown the Jobs view shows is just a render of the server's `nextRunAt`, polled from `GET /api/schedule`.

The scheduler reschedules with a fresh `setTimeout` *after* each run resolves rather than on a fixed interval — the `node-cron`/`max_instances: 1` idea, implemented in-process. That gives the overlap guard the design calls for (a `running` lock plus reschedule-on-finish means a slow scrape+score can never start before the previous one finishes) and makes "Run now" reset the countdown (`POST /api/schedule` runs immediately and the post-run reschedule pushes `nextRunAt` a full interval out). The execution itself is the shared `runScrape` (`lib/scrape/run`) followed by `runScheduledScoring` (`lib/scoring/scheduled`), which routes by the configured scoring backend: on the **local backend** (the default) it runs the same sequential warm-first loop the interactive path shares — one job in flight, the GPU sets the pace, no Anthropic endpoints touched — while on the **Anthropic backend** scheduled scoring goes through the Message Batches API (`runScoringBatch`, `lib/scoring/batch`) at half price because no one is watching its latency. The interactive `/api/score` SSE route keeps the real-time `runScoring` fan-out (`lib/scoring/run`) either way. Both scoring executions run through the shared warm-first loop (`runWarmFirstScoring`, `lib/scoring/warm-first`), which owns preparation, the cache-warming first call, persistence, and the run summary — each path's module owns only its transport — so filters and thresholds behave identically. After a run inserts new jobs (status `new`), scoring runs over just the `new` rows and transitions them to `scored`; the deduplicator keeps re-scrapes from re-inserting, so the same job is never scored twice.

Because a backend run has no SSE stream attached, the Jobs view learns about its results by **refetch**, not streaming: it polls `GET /api/schedule` and calls `router.refresh()` when `lastRunAt` advances (matching the documented "SSE for the three streaming routes, refetch elsewhere" split). The scheduler is armed lazily on the first `/api/schedule` request after boot and re-armed whenever Setup saves a new cadence (`POST /api/config`). Arming is **anchored to the actual last run**: the runner reads the most recent `scrape_sessions.ended_at` and the next run is `lastRun + interval` (clamped to now — an overdue run fires immediately), so a server restart or dev-mode recompile never resets the countdown to a full interval. The scheduler singleton itself is stashed on `globalThis` for the same reason: Next.js dev recompiles module scope, and a module-scoped singleton would be silently replaced mid-countdown. For the throughput and cost characteristics of scoring — concurrency, rate limits, caching, and whether the Batch API is worth it — see *Cost & Token Optimization*.

The user still hears about a headless run's notable results without a tab open (FR-28): the run job fires **at most one native desktop toast** per run, calling the shared server-side notifier (`fireNotifier`, `lib/notify/notifier` → `scripts/notify.py`) directly — no HTTP self-request to `/api/notify`. What the toast says is pure, testable composition (`lib/notify/run-toast`): the shared warm-first loop tallies each settled score into `ScoringSummary.notables` — strong matches (at/above the FR-9a threshold, best match tracked) and FR-6a parks (counted separately; a park is a review request, so it notifies at any threshold and never inflates the strong count) — and `composeRunToast` turns the tally into one `{title, message}` or `null` (silent) when nothing notable scored. Because the tally lives in the loop's single settle funnel, both scheduled backends feed it identically — the sequential local loop and batch-settled Anthropic results alike — and only the jobs *this run* scored are counted, so earlier runs never re-notify. The composer also bounds the strings to the `/api/notify` reference limits (title ≤ 200, message ≤ 500 — the shared notifier itself never truncates), and the runner wraps the fire in try/catch: `fireNotifier` can throw synchronously, and a missed toast must never fail the run. The interactive flows are untouched — the browser-side alert toggle keeps governing only them, while the scheduled toast's opt-in is the run interval itself. **Operational note:** coverage is only as good as the machine's uptime — the scheduler needs the process running and, on the default backend, Ollama serving, so "don't sleep while plugged in" is a power setting the user makes in their OS, overnight gaps are accepted, and an overdue run simply fires on wake (the clamped anchor above). In container mode the runs proceed as normal but the toast itself is a silent no-op (FR-30) — results are simply waiting in the queue.

### Multi-role support

If you apply across very different domains, add a `profiles` table. Each profile carries its own resume LaTeX and Source of Truth. Setup selects the active profile, and the scoring and rewrite routes read from the active profile rather than a single global config.

---

## Known Limitations

### LinkedIn scraping detection

LinkedIn actively detects and rate-limits automated access. The guest API is unauthenticated, so the exposure is **IP-based** throttling or temporary blocking, not an account suspension (there is no account). Keep request rates modest, set a realistic `User-Agent`, back off on `429`, and expect occasional empty or blocked responses. Failures surface in the `scrape_sessions` table as `failed` status with an error message. The Chain of Responsibility means a scraping failure is a clean boundary error rather than silent database corruption. If the guest endpoints get IP-blocked, wait it out at a lower request rate — or implement a paid source against the `ScraperStrategy` interface, which is the designed extension point for exactly that case.

### TeX Live required for PDF operations

Preview and approval both shell out to `pdflatex`, so a working TeX distribution (TeX Live on Linux, MiKTeX on Windows, MacTeX on macOS) must be available to the Node server — the Docker image ships one (see Deployment), so this concerns native runs. There is no separate backend to keep alive anymore — if the app is running, the compile path is available — but if `pdflatex` is not on `PATH`, compiles fail and the error surfaces in the UI with the status unchanged. Scoring and the rewrite stream do not depend on LaTeX and work regardless.

### Approval errors are surfaced but the file may exist on disk

If the server writes the PDF to disk but then the database transaction fails and rolls back, the next approval attempt will overwrite the orphaned file on disk — which is safe and the right behavior. Still, the file exists on disk in a state that no database record points to. This is a cosmetic issue for personal use and not worth handling automatically; if it bothers you, add a periodic task that scans the output directory and cross-references `approved_pdf_path` values in SQLite.

### Streaming rewrite requires a persistent Next.js connection

The Server-Sent Events stream for the rewrite must stay open for the duration of generation — ten to twenty seconds. If the browser tab is backgrounded aggressively on mobile, the SSE connection may be dropped mid-stream. The partial LaTeX up to the drop point is displayed in the editor. Regenerate re-runs the full stream from the beginning.

### Token limits apply to both scoring and rewriting

`max_tokens` is a required parameter on the Messages API and it bounds the output whether or not the response is streamed. Streaming changes how tokens are *delivered* (incrementally, as server-sent events), not the token *budget*: if the model reaches `max_tokens` mid-generation, the stream simply ends with `stop_reason: "max_tokens"` — possibly in the middle of a LaTeX command — and the document is truncated exactly as a non-streaming call would be. So the rewrite call must set `max_tokens` generously (e.g. 8192), comfortably above the worst-case resume length, and after the stream closes it must check `stop_reason`: if it is `max_tokens`, surface a "rewrite was cut off — regenerate" warning rather than silently writing a truncated, possibly non-compiling document to SQLite. Dropping the change-log array from the model's output (see AI Prompt Design) lowers the token count and therefore the truncation risk, but it does not remove the limit. The scoring call's `max_tokens` should be set to around two hundred to cover the score value and three to four sentences of rationale comfortably.

### Command history is append-only

The command_history table grows unboundedly. For a personal tool this is not a practical concern, but if you want to cap it, add a periodic task that prunes commands and version rows older than a configurable window — ninety days is a reasonable default.

### Approval undo does not delete the disk file

Undoing an approval reverts the job's status and clears `approved_pdf_path` in SQLite, but the PDF on disk is left intact. If you want undo to also clean up the file, add a "Delete saved PDF" confirmation dialog that calls a dedicated route for file deletion as a deliberate, separate action from undo.

---

## Cost & Token Optimization

Everything runs locally, so infrastructure cost is effectively zero — the only recurring cost is the Anthropic API. Under the default local scoring backend, the highest-frequency call costs nothing and the rewrite/explain calls dominate spend; when scoring runs on Anthropic instead, the scrape-and-score loop makes scoring the dominant cost, and the design pulls five levers on it — four on the call itself and one upstream.

### Company blocklist — don't score what you'll discard

The cheapest token is the one you never spend. The scrape pipeline drops jobs from blocked companies before they are inserted (see the Chain of Responsibility), so those jobs are never scored at all. For anyone who repeatedly sees roles from staffing agencies or companies they will never apply to, this removes whole batches from each scoring run rather than scoring-then-declining them.

### Model routing

Scoring — the highest-frequency call — runs on the configured backend: the **local Ollama model** by default (`qwen3:4b-instruct-2507-q4_K_M`, zero marginal cost) or **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) when Anthropic is selected in Setup. Scoring is classification — a number plus three sentences — which a small model handles because the accuracy-critical arithmetic lives in code (quote-and-cap, the FR-6a park), and the score is advisory (you still decide). The rewrite and the change-explanation run on **Claude Sonnet 5** (`claude-sonnet-5`): the rewrite is the quality-critical creative task and stays on Sonnet; the explanation can run on Haiku too if you want to trade a little richness for cost.

### Plain-text resume for scoring

Fit-scoring does not depend on LaTeX markup, so the scoring call is sent a plain-text extraction of the resume rather than the LaTeX source. The markup (`\textbf{}`, list environments, braces) is pure token overhead for a judgment task. The LaTeX source is kept only for the rewrite, which edits it directly.

### Prompt caching

Prompt caching is an **Anthropic-backend** economics lever — the local Ollama backend has no billed tokens to save (its own KV prefix cache is a speed detail, not a cost one), so everything in this section applies when scoring runs on Haiku (and always to the rewrite/explain calls).

The expensive redundancy in scoring is that the resume, Source of Truth, and system prompt are identical for every job — re-sending them per job means paying for the resume dozens of times in a single run. Prompt caching fixes this: the stable prefix (system prompt + parsing contract + Source of Truth + plain-text resume) is placed before the cache breakpoint and only the job posting varies after it. Within a batch scored inside the cache window, the first call writes the cache and the rest read it at roughly a tenth of the input rate.

Two subtleties make this actually work:

- **The cache floor.** Haiku 4.5 silently refuses to cache prefixes under **4096 tokens** — no error, just `cache_creation_input_tokens: 0` and full price on every call. The user-configurable parts of the prefix (prompt + Source of Truth + resume) measure ~3.4–4.2k tokens, straddling that floor, so caching could silently never engage. The code-owned `SCORING_CONTRACT` block (see *Scoring prompt*) is sized so the total prefix reliably clears the floor; a size guard in `score.test.ts` keeps it that way. To verify against the live API, run `npx tsx scripts/diagnose-cache.mts --live` — it counts the exact prefix tokens and fires two identical calls to show the `cache_write` / `cache_read` split.
- **The TTL.** Scoring runs on the backend scheduler's interval, so the cache should survive *between* runs, not just within one. The breakpoint uses the **1-hour TTL** (`SCORING_CACHE_TTL`): the write costs 2× (vs 1.25× for the 5-minute default), but every scheduled run within the hour that scores at least one job re-reads — and refreshes — the same entry, so the write is paid roughly once rather than once per run. When runs are further than an hour apart the downside is only the extra 0.75× write on a ~4k-token Haiku prefix — fractions of a cent.

The same pattern applies to the rewrite: caching the system prompt + Source of Truth + original resume means rewriting several jobs in one session re-reads the prefix cheaply (the rewrite prefix is far above any cache floor, and rewrites are user-paced, so it keeps the 5-minute default).

### Scoring throughput — concurrency vs. the Batch API

Each execution path batches the scoring the way that fits it — concurrency when you're watching, the Batch API or a sequential loop when you're not. All of them run through the shared warm-first loop (`runWarmFirstScoring`, `lib/scoring/warm-first.ts`), which resolves the backend and the eligible jobs, scores the first alone with a regular call (warming the Anthropic prefix cache when that backend is selected), and hands the rest to the path's executor — so the modules below own only their transport:

- **Interactive runs — real-time async concurrency (`runScoring`, `lib/scoring/run.ts`).** `/api/score` fires the per-job calls — to the configured backend — concurrently through a bounded `p-limit` pool sized to Anthropic's account-tier rate limits (the local Ollama server just queues requests beyond what fits its parallelism) — not unbounded; "as parallel as is safe" means as parallel as the limits allow. Because the pool caps in-flight requests rather than tokens-per-minute, `429` responses are caught and the affected job is retried after the `Retry-After` delay, which is what actually keeps you under the RPM/TPM ceilings on the Anthropic backend. Scores land within seconds (Anthropic) or ~8s/job (local) and stream into the UI progressively — the right trade when you clicked the button and are watching.
- **Scheduled headless runs — the Message Batches API (`runScoringBatch`, `lib/scoring/batch.ts`), Anthropic backend only.** Nobody watches a scheduler run, so its latency is free — and the Batch API is 50% cheaper on *all* token usage, cache reads and writes included. The scheduler's run job scores through one batch per run: the first eligible job is scored with a regular call (the shared loop's warm-first call — it writes/refreshes the shared 1-hour cache entry, which matters doubly here because cache hits *inside* a batch are best-effort, while hits against a pre-existing warm entry are near-certain), and the rest are submitted as one batch with `custom_id`s carrying the job row ids. Results are matched by `custom_id`, never by position, and a truncated or errored result fails that job rather than persisting a bad score. Most batches complete within minutes at this size (the API caps processing at 24 hours), and the scheduler's overlap guard means a slow batch only delays the next run. If the process dies mid-batch, the affected jobs simply stay `new` and the next run re-submits them — no batch state survives restarts, by design.
- **Scheduled headless runs — the sequential local loop (`runScheduledScoring`, `lib/scoring/scheduled.ts`), local backend (the default).** The Batch API doesn't exist on Ollama and a 50% discount on $0 is meaningless, so with the local backend configured the scheduler's run job routes to the same warm-first loop with a strictly sequential executor: one job in flight at a time, ~8s/job at whatever pace the GPU allows — nobody is watching. One-at-a-time also keeps the Ollama queue empty, so a crash mid-run wastes at most one call; the unscored jobs stay `new` and the next scheduled run picks them up, exactly like the batch path's restart semantics. Every call ledgers through the same `meterOllamaCall` telemetry the interactive path uses. (`runScoringBatch` itself still refuses a non-Anthropic backend loudly, before any scoring work, as a guard against being called directly.)

Combined with caching, a scheduled scoring call costs roughly a quarter of the pre-optimization price: the prefix reads at 0.1× and the whole request bills at 50%.

To make either path safe end to end: keep the scrape pipeline's deduplicator in front of scoring so re-scrapes never re-score the same job, score only the `new` rows each run, and rely on the scheduler's overlap guard so a slow run cannot start before the previous one finishes.

### AI call telemetry

None of the levers above can be *verified* without measurement, so every AI call — Anthropic or local — records one row in the `ai_calls` table (FR-27; see Database Schema): call type, model, job id, the four usage token counts the API returns (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), an estimated cost, latency, stop reason, and the error message when the call failed. The capture lives in `lib/ai/telemetry.ts`, which is also the single **metering seam** every call type goes through: `scoreJob` / `lookupSalary` / `explainChanges` run their built requests through `meteredCreate` (they take an optional `{db, jobId}` telemetry context and pass it along), the local backend's `scoreJobOllama` runs through `meterOllamaCall` (same timing/error-row/success-row protocol; `ollamaEntry` maps Ollama's `prompt_eval_count`/`eval_count` to the token columns, records the cost as a flat **$0** — zero cost is a property of the backend, not a price lookup — leaves the cache columns `null`, and maps a `length` finish to `max_tokens` so the truncation guard and ledger badge behave identically), the `/api/rewrite` route wraps its stream in `meterCall` (the row is captured from the accumulated final message), and `runScoringBatch`'s results loop ledgers each item through `meterBatchItem`. The meter owns the whole recording protocol — timing, the error row when a call throws, the success row priced with the call type's cost flags — and its private `CALL_COST_OPTIONS` map is the one place that knows which call types write the scoring prefix on the 1-hour cache TTL (`score`, `score_batch`) and which bill at the Message Batches discount (`score_batch`). The call modules themselves only build requests and parse responses.

Two read surfaces render the ledger, both as direct SQLite reads from React Server Components (no API route, consistent with the other pages): the dashboard's *AI usage* card (today/7-day totals per call type, cache hit rate, cold-cache warning) and the **`/usage` page**, which lists each recorded call individually — time, call type, job, the four token counts, estimated cost, latency, and outcome (ok / truncated / error) — newest first via `listAiCalls` in `lib/db/repo.ts`.

What the ledger buys:

- **Per-job trace-back.** "What did job X cost end-to-end?" is `SELECT sum(cost_usd) FROM ai_calls WHERE job_id = ?` — score, rewrite, and explanation included.
- **Cache verification.** Scoring cost on the Anthropic backend depends on the cached stable prefix staying warm. The dashboard computes `sum(cache_read_tokens) / sum(input_tokens + cache_read_tokens)` over the last 7 days — **scoped to Anthropic model ids** (`model LIKE 'claude-%'`), since local rows carry no billed cache and would dilute the rate into a permanent false alarm — and shows a warning when it is near zero while Anthropic scoring calls exist: the signature of a silent prefix invalidator that would otherwise multiply costs unnoticed.
- **Truncation audit.** `stop_reason` is recorded on every row, so `max_tokens` events are queryable history rather than only handled in the moment.

Cost is a snapshot computed at write time by `estimateCostUsd` — a pure function with a price map keyed by the model ids in `lib/ai/models.ts` (Haiku 4.5 at $1/$5 per MTok; Sonnet 5 at the $3/$15 list price — the $2/$10 introductory rate through 2026-08-31 is deliberately not used so estimates don't silently drop when it lapses). Multipliers mirror Anthropic's pricing: cache reads at 0.1× the input rate; cache writes at 1.25× for the 5-minute TTL and 2× for the 1-hour TTL (the scoring prefix uses 1h — see *Prompt caching*); batch items at 0.5× on everything. An unknown model records its tokens with a `null` cost. Telemetry is best-effort by design: `recordAiCall` never throws, so the ledger can never break a scrape, score, or rewrite.

---

## Deployment (Docker)

The self-hosted distribution (FR-29) is a single app image plus a compose file that brings up the whole stack in one command. Nothing about the architecture changes — it is still one Next.js process and one SQLite file — the container simply packages the runtime dependencies (Node, TeX Live) and wires up the Ollama sidecar. Native runs (see Local Dev Setup) remain fully supported.

### Image contents

`Dockerfile` is a two-stage build on `node:22-bookworm-slim`:

- **Stage 1 (build)** installs the `better-sqlite3` native-module toolchain (`python3 make g++` for node-gyp, in case no prebuilt binary matches), runs `npm ci` and `next build`, then prunes to production dependencies.
- **Stage 2 (runtime)** installs a **mid-size TeX Live** (~1.7 GB installed: `texlive-latex-recommended` + `texlive-latex-extra` + `texlive-fonts-recommended` — covers real-world resume templates without the ~6 GB `texlive-full`) and copies in the built app: `.next`, production `node_modules` (native binding included), `next.config.mjs`, and the committed `resume-example/` starters (the zero-config fallback for `lib/resume/load`, FR-32). The user's private `resume/` is gitignored *and* `.dockerignore`d, so personal assets are never baked into an image — they are bind-mounted at run time.

The container runs as the non-root `node` user. Inside the image the server starts with `next start -H 0.0.0.0` — the host reaches it through Docker's port mapping, so the in-container bind must be open; the localhost-only invariant (NFR-10) moves to the compose port publication below. (The repo's plain `npm start` keeps `-H 127.0.0.1` for native runs.)

**Extending the TeX image** for exotic packages: Debian's TeX Live has no usable `tlmgr`, so add further Debian collections in a derived image:

```dockerfile
FROM jobfinder
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-science texlive-fonts-extra && rm -rf /var/lib/apt/lists/*
USER node
```

### Environment-variable contract

Baked into the image (the in-container filesystem layout; override only if you know why):

| Variable | Baked value | Meaning |
|----------|-------------|---------|
| `JOBFINDER_CONTAINER` | `1` | Container mode (`lib/env/container.ts`): host-OS integrations degrade gracefully (FR-30, below). |
| `JOBFINDER_DB_PATH` | `/data/jobfinder.db` | The SQLite file (`lib/db`). Mount `/data` to persist. |
| `JOBFINDER_OUTPUT_DIR` | `/output` | Base directory for approved resume packages (`lib/http/guards`, PathBuilder). Mount `/output` to receive them. |

Not needed in-container: `JOBFINDER_PDFLATEX_PATH` (`lib/latex/sandbox` defaults to `pdflatex`, which the image puts on `PATH`).

Provided at run time — via `.env` on the host (`cp .env.example .env`), never baked into an image layer:

| Variable | Required | Meaning |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | yes | Rewrite + explanation (Sonnet), and scoring only when the Anthropic backend is selected. Server-side only (NFR-7); compose fails fast with a clear message when unset. |
| `RAPID_API_KEY` | no | The Greenhouse aggregator key (FR-5a). Blank disables that source. |
| `OLLAMA_MODEL` | no | The model tag the one-shot pull init fetches (default `qwen3:4b-instruct-2507-q4_K_M`; the higher-accuracy override is `batiai/qwen3.6-27b:iq3` — see `docs/scoring-model-eval.md`). |
| `COMPOSE_PROFILES` | no* | Which compose profiles are active. `.env.example` sets `local-scoring` — the profile holding the `ollama` + `ollama-pull` services — so the default stack is all three services. Empty disables the sidecar (host-Ollama topology, below). *Read by compose itself, not by the app; a pre-profile `.env` without the line starts the app alone. |
| `OLLAMA_BASE_URL` | no | Where the app finds Ollama. Unset, the compose file defaults it to the sidecar (`http://ollama:11434`) by service name on the compose network — the FR-31 endpoint resolver (`lib/env/ollama.ts`, single resolution point, native default `http://127.0.0.1:11434`) pointed at the sidecar. Set (typically `http://host.docker.internal:11434`, with `COMPOSE_PROFILES=` empty), scoring targets an Ollama outside the stack instead. |

### Sidecar topology and volumes

`docker-compose.yml` defines three services and three mounts:

- **`app`** — the image above, built from the repo (`build: .`). Publishes exactly one port, **`127.0.0.1:3000:3000`**: the app has no auth, so the "not reachable beyond the host" invariant (NFR-10) lives in this mapping — the port is invisible to the LAN, and remote access is the user's own VPN/SSH tunnel.
- **`ollama`** — the local-scoring sidecar (`ollama/ollama`). Publishes **no ports at all**; only the app and the pull init reach it over the compose-internal network.
- **`ollama-pull`** — a one-shot init service: waits for the sidecar, then pulls `OLLAMA_MODEL` into the model volume unless it is already present (`ollama show` succeeding), so the multi-GB download happens exactly once.

Both Ollama services carry the **`local-scoring` compose profile**, activated by `COMPOSE_PROFILES=local-scoring` in `.env` (the `.env.example` default — the quick-start stack is unchanged). The `app` service deliberately has **no `depends_on`**: compose refuses to start a service whose `depends_on` names a profile-disabled one, and ordering is unnecessary — the pull init has its own wait loop, and the app probes Ollama reachability per request (`/api/ollama/models` reports `reachable: false`; scoring fails loudly per job) so a sidecar that arrives late, or never, degrades exactly as a down native daemon does.

Two supported variations on the default topology (user-facing recipes in README "GPU acceleration & host Ollama"):

- **Host-Ollama mode** — `COMPOSE_PROFILES=` (empty) plus `OLLAMA_BASE_URL=http://host.docker.internal:11434` in `.env`: only `app` starts, and scoring, the Settings model status, and the in-app download all target a natively installed Ollama on the Docker host. This is the GPU path for machines Docker can't hand a GPU to (all Macs — Metal via the native app — and AMD on Windows), and it avoids a second multi-GB model store when a host Ollama already exists.
- **NVIDIA GPU override** — the committed `docker-compose.gpu.yml` (`docker compose -f docker-compose.yml -f docker-compose.gpu.yml up`) grants the sidecar every host GPU via `deploy.resources.reservations.devices` (`driver: nvidia`, `count: all`, `capabilities: [gpu]`). Same stack, same profile; scoring just runs on the GPU. (AMD-on-Linux users substitute the `ollama/ollama:rocm` image + `/dev/kfd`/`/dev/dri` devices in an uncommitted override — documented inline in the README, not shipped, since ROCm device mapping varies by card.)

| Mount | Type | Purpose |
|-------|------|---------|
| `jobfinder-data:/data` | named volume | The SQLite file. Survives `docker compose down`; only `down -v` deletes it. |
| `ollama-models:/root/.ollama` | named volume | The Ollama model store — the ~2.5 GB pull persists across restarts. |
| `./output:/output` | host bind | Approved resume packages land directly on the host. |
| `./resume:/app/resume` (read-only, optional) | host bind | The user's private resume assets; each file missing there falls back to the committed `resume-example/` (FR-32). Deliberately read-only: in-app-authored assets (FR-33) go to the `resume_assets` table in the SQLite file on `/data`, never to this mount. |

### Container-mode behavior (FR-30)

`JOBFINDER_CONTAINER=1` degrades the two host-OS integrations, one boundary check per module (`isContainerMode()`):

- **Open folder** (`/api/open-folder`, FR-24): no file manager exists in the container, so the route skips the spawn and returns `{ opened: false, dir, relativeDir }` — the path still read from SQLite and containment-verified, with `relativeDir` presenting it as `./output/...` relative to the compose folder — and the Tracker UI copies that host-relative form to the clipboard instead of opening it. The in-browser **View PDF** link (`GET /api/jobs/pdf`, FR-35) needs no degradation and is the primary "where's my PDF?" answer in the container.
- **Desktop toasts** (`fireNotifier`, FR-28): the notifier returns silently before any spawn, covering both the `/api/notify` route and the scheduler runner. Scheduled runs themselves are unaffected — results wait in the queue.

Everything else — scraping, scoring against the sidecar, the rewrite stream, compile/save with the one-page gate, the scheduler — behaves identically to a native run. With the flag unset, native behavior is unchanged.

---

## Local Dev Setup

### Prerequisites

This section is the **native** (non-Docker) run — for the one-command containerized stack see Deployment (Docker) above, which packages all of these prerequisites. Install the following before starting: Node.js 18 or later (which runs the whole app), a TeX distribution (TeX Live on Linux, MiKTeX on Windows, MacTeX on macOS) with `pdflatex` on `PATH`, and — for the default local scoring backend — [Ollama](https://ollama.com) with the scoring model pulled (`ollama pull qwen3:4b-instruct-2507-q4_K_M`, or whatever tag Setup names); skip Ollama entirely if you select the Anthropic backend in Setup. The npm dependencies do the rest: `better-sqlite3` (the database — no separate server to install or run), `cheerio` (HTML parsing for the scraper), `pdf-lib` (the PDF page-count check), and `p-limit` (the scoring concurrency pool). No browser or headless-Chromium binary is required — the guest-API scraper is plain `fetch` + `cheerio`.

### The single process

One process runs the whole app. The Next.js server runs on port 3000 (`next dev` in development, `next start` in production) and serves the UI, every `app/api/` route handler, and the streaming `/api/rewrite`, `/api/score`, and `/api/scrape` routes. It performs the scraping, scoring, PDF compilation, file saving, and all database access in-process. The Anthropic API key lives in `.env.local` and never leaves the server.

The app has no authentication, so it must not be reachable beyond the host (NFR-10): nothing else on the network may reach the routes that run `pdflatex` on untrusted input or touch the local file system. Natively that means binding the server to `127.0.0.1` — which `npm start` does (`next start -H 127.0.0.1`); in Docker the equivalent is the compose port mapping publishing `127.0.0.1:3000` only (see Deployment). Because the whole app is one process, there is no second port to open and no inter-service trust boundary to defend.

### Environment variables

All native-run configuration lives in one `.env.local`: `ANTHROPIC_API_KEY` (required for rewrite/explain/salary, and for scoring only when the Anthropic backend is selected), `JOBFINDER_DB_PATH` (the SQLite database file), `JOBFINDER_OUTPUT_DIR` (the output base directory for saved PDFs), optionally `JOBFINDER_PDFLATEX_PATH` (only when `pdflatex` is not on `PATH`), `OLLAMA_BASE_URL` (only when Ollama is not at the `http://127.0.0.1:11434` default — FR-31), and `RAPID_API_KEY` (the fantastic.jobs Active Jobs DB aggregator key, required only when the Greenhouse source is enabled — FR-5a). `RAPID_API_KEY` is read **server-side only** and never sent to the client; the browser sees at most a boolean "present" indicator. Despite the name, this is a **direct fantastic.jobs / Zuplo data-API key** used with `Authorization: Bearer` against `data.fantastic.jobs`, not a RapidAPI marketplace key (see "Strategy D — Greenhouse (aggregator)"). The local scoring backend needs no key — it talks to the Ollama daemon at `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`).

### Database setup

The schema is a single SQL file (or a small set of ordered migration files) applied to the SQLite database on first run — for example by having `better-sqlite3` execute the DDL when the database file does not yet exist, or via a tiny migration runner. It creates all eight tables — `user_config`, `jobs`, `resume_changes`, `rewritten_latex_versions`, `command_history`, `scrape_sessions`, `blocked_companies`, `ai_calls` — with the `status` `CHECK` constraint and indexes on `jobs.status`, a composite `jobs (status, created_at desc)` for the decision-queue query, `rewritten_latex_versions.job_id`, `command_history.job_id`, the normalized name on `blocked_companies`, and `ai_calls (job_id)` plus `ai_calls (created_at)` for the telemetry ledger's per-job trace-back and time-window rollups.

There is no separate type-generation step: the row and domain types are written once in TypeScript and shared by every query, since there is only one database client.

### Cost at runtime

Scoring each job on the default local backend: ~5-8.5k prompt tokens and a few hundred output tokens at **$0** — the ~8s/job of GPU time is the whole cost. On the Anthropic backend it is the same prompt on Haiku 4.5, and with the resume / Source-of-Truth prefix cached, the *effective* per-job cost after the first call in a batch is a small fraction of the list rate, since cache reads are billed at a tenth of the input rate. Rewriting a resume: roughly two thousand to four thousand input tokens (prefix-cached across a session) with streaming output of variable length (typically one thousand five hundred to three thousand tokens) on Sonnet 5. Explaining the changes adds one more Sonnet call per rewrite — the two resumes plus the job description as input and a short bulleted rationale as output. Approval makes no AI calls — only compile and disk write. A typical session of ten scored jobs and three rewrites costs nothing for the scoring (local default) and a few cents for the rewrites — well under ten cents total. When scoring runs on Anthropic instead, it becomes the dominant per-run cost, which is exactly why it is on Haiku, cached, and (optionally) eligible for the Batch API's further 50% discount if you can tolerate asynchronous results.

---

*JobFinder v3.1 — Next.js · TypeScript · SQLite · Claude Sonnet 5 + Haiku 4.5 · LaTeX*
