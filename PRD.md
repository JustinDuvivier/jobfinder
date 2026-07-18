# JobFinder — Product Requirements Document

**Version:** 1.0
**Status:** Active
**Owner:** the single local user
**Companion doc:** Technical design in `jobfinder-docs.md` (the *how*; this PRD is the *what* and *why*)

---

## 1. Summary

JobFinder is a personal, single-user, local web app that streamlines the LinkedIn job-application pipeline end to end. It scrapes fresh postings, scores each against the user's resume, lets the user decide which to pursue, rewrites the resume in LaTeX tailored to a chosen role — with a live side-by-side editor, a rationale for every change, and a hard one-page guarantee — saves an approved PDF to a structured folder on disk, and tracks each application through the hiring pipeline. It runs entirely on one machine for one person. There is no multi-user, hosting, or account requirement.

## 2. Problem & background

Applying to engineering roles at volume has two expensive, repetitive steps: deciding which of many postings are worth the effort, and tailoring a resume to each chosen posting well enough to clear ATS filters and impress a reviewer — without letting it spill past one page or drift from the truth. Done by hand this is slow and inconsistent. Generic "auto-apply" tools spray untailored applications and produce low-quality results. The user wants a tool that keeps a human in the loop for every decision while removing the mechanical toil: gathering postings, judging fit, drafting a tailored resume, and keeping records.

## 3. Goals

- **G1** — Cut the time from "fresh postings exist" to "tailored, one-page resume saved" to a few minutes per job.
- **G2** — Keep the user in control: every pursue/pass and every tracker transition is an explicit, reversible decision.
- **G3** — Produce tailored resumes that are truthful (drawn only from a user-provided source of truth) and always exactly one page.
- **G4** — Make fit triage cheap and fast, so effort goes into rewriting rather than reading every posting.
- **G5** — Keep all data local and fully exportable for the user's own analysis.
- **G6** — Keep running cost near zero (local infrastructure) and AI cost low (cheap model tier for the high-frequency task).

## 4. Non-goals (explicitly out of scope)

- Multi-user accounts, teams, or sharing.
- Cloud hosting or deployment — this is a local tool.
- Authenticated LinkedIn scraping, or anything that requires or risks a LinkedIn account.
- Auto-applying or auto-submitting without explicit user approval.
- Mobile-first UX or cross-device real-time sync.
- A general resume builder — the app tailors an existing LaTeX resume rather than authoring one from scratch.
- Fabricating experience, skills, or metrics.

## 5. Target user

A single technical job seeker ("Alex") who maintains a LaTeX resume, applies primarily through LinkedIn to AI / ML / Software / Forward-Deployed / Solutions Engineering roles, runs the tool on their own machine on demand, and wants to analyze their own outcome data.

## 6. User stories

- I can trigger a scrape of recent LinkedIn postings matching my saved searches, so I have a fresh queue to triage.
- I can see each new job scored for fit against my resume, with a short rationale, so I know where to spend rewrite effort.
- I can pass on or pursue each scored job in a decision queue.
- When I pursue a job, I get an AI-tailored LaTeX resume that streams into a side-by-side editor, a diff of what changed, and an explanation of why.
- I can edit the rewritten LaTeX, preview the compiled PDF, and always see whether it is still one page.
- I can approve a rewrite, which saves a one-page PDF to a dated, per-job folder and records it — and the app refuses to save anything longer than one page.
- I can track each application through stages that distinguish who acted (I passed vs. they rejected vs. I withdrew).
- I can undo decisions and regenerations.
- I can block companies so their postings never enter my queue or cost me scoring.
- I can export all of my data.

## 7. Functional requirements

Each requirement is intended to be individually testable.

### Scraping
- **FR-1** — Scrape LinkedIn's public guest job endpoints (no login, account, or browser) on demand.
- **FR-2** — Searches are the cross-product of configured keywords × locations, with fixed filters (last 24h, full-time, entry + associate).
- **FR-3** — Deduplicate by job ID across all searches; the same posting is fetched and scored exactly once.
- **FR-4** — Drop postings from blocked companies before insert; they are never scored.
- **FR-4a** — Drop postings whose title is over-senior before insert. LinkedIn's experience-level filter is poster-tagged and leaky, so keyword results still surface "Senior/Staff/Lead/…" roles; a configurable, whole-word title-exclusion list (default drops above mid-level, keeping entry/junior/associate/mid) removes them before they are scored. An empty list disables the filter.
- **FR-5** — Scrape progress is visible as it runs; an interrupted scrape is reconciled, never left "in progress" forever.
- **FR-5a** — Optionally pull a second source alongside LinkedIn: Greenhouse-hosted postings from the **fantastic.jobs Active Jobs DB** aggregator (restricted to Greenhouse). It is an orthogonal on/off toggle, not a replacement for the primary strategy — both sources run in **one merged run** through the same pipeline: deduped by job ID across sources (Greenhouse IDs are namespaced `gh:<id>` so they never collide), title-filtered (FR-4a) and blocklist-filtered (FR-4) by the same rules, each with its own per-run job budget, and **counted per source**. Enabled but keyless is surfaced as a warning, not silently skipped; the aggregator key is read **server-side only** (NFR-7).

### Scoring
- **FR-6** — Score each new job 0–100 for resume fit with a 3–4 sentence rationale, on the configured scoring backend: a **local Ollama model by default** (`batiai/qwen3.6-27b:iq3` — zero AI cost, ~8s/job, validated against the golden scoring eval set), or Anthropic's cheap tier (Haiku) when selected in Setup. Switching backends or the local model tag is a Settings change, never a code edit. If the local backend is selected but unavailable (server down, model not pulled), the run fails loudly — no silent fallback to Anthropic — and unscored jobs stay `new` for the next run.
- **FR-6a** — An inferred requirement never hides a job: when the model's copied requirement quote contains no readable years figure (no digits that could be years — the posting stated none, so the requirement and the gap are the model's inference) and the experience-gap cap would land below 70, the persisted score is parked at exactly **70** and the rationale carries a review flag, rendered as a "requirement inferred — review" badge wherever the rationale shows. Parked jobs are exempt from the FR-9a auto-filter at any threshold. Stated-years requirements keep the normal cap; inferred requirements with gaps of ≤ 2 years keep their real score. A job parked too high costs one manual look; a genuine match hidden below the FR-9a threshold costs the opportunity.
- **FR-7** — Score against a plain-text resume (not LaTeX), reusing a cached stable prefix across a batch.
- **FR-8** — Scores appear progressively as they complete.

### Decision queue
- **FR-9** — Show only jobs awaiting a decision (`new` / `scored`), newest first, paginated.
- **FR-9a** — Auto-filter low-fit jobs: a job scored below a configurable threshold (default 50; 0 disables) is flagged and excluded from the decision queue so it never reaches triage. The flag is a separate dimension from `status` — flagged jobs are retained in the database (visible to the Companies view and analytics), not deleted, so the action is non-destructive and the data stays whole.
- **FR-10** — The user can pass (I declined) or pursue (continue to rewrite) each job; both actions are reversible.

### Rewrite
- **FR-11** — Pursuing a job opens a side-by-side editor; the AI rewrite streams into it token by token.
- **FR-12** — The rewrite draws only from the user's resume + source of truth and must not fabricate.
- **FR-13** — Compute and display a diff of original vs. rewritten LaTeX (the "what changed").
- **FR-14** — A separate, non-blocking explanation states *why* each change was made, tied to the job (the "why").
- **FR-15** — The user can edit the LaTeX; edits autosave with version history; undo restores exact prior versions.
- **FR-16** — The user can compile and preview the PDF on demand; the preview reports the page count. Opening a job also **auto-compiles and previews the current resume on load** (the rewritten version if one exists, else the original) so the preview is never blank; the manual **Compile** button remains for recompiling hand-edits.
- **FR-16a** — A started rewrite is a **durable, server-owned background job**: it runs to completion regardless of navigation or reload, is **never double-started** for the same job, and its status (rewriting / done / cut off / failed) is visible **from any page** via an always-on indicator that links back to the job. A rewrite that finishes while the user is away is persisted exactly as if watched; a truncated or errored one persists nothing. (In-flight rewrites are process-local, so a full server restart mid-generation loses that generation — the job stays in `rewriting` and can be regenerated; see NFR-8.)

### Approve & save
- **FR-17** — Approving compiles, verifies the PDF is **exactly one page**, and only then writes it to disk; otherwise it refuses and surfaces an error.
- **FR-18** — Saved PDFs go to a deterministic path — `base / YYYYMMDD / Company_Title[_disambiguator] / Owner_Resume.pdf` — collision-free by construction.
- **FR-19** — Approval writes the saved path + status atomically; a failure leaves no half-saved state.
- **FR-20** — Re-approving the same job overwrites that job's PDF at the same path.

### Tracking
- **FR-21** — Approved jobs can be moved into a tracker with stages: applied, interview, offer, accepted, rejected, withdrawn, ghosted.
- **FR-22** — Status distinguishes who acted: `passed` (I declined pre-application) ≠ `rejected` (they declined me) ≠ `withdrawn` (I pulled out).
- **FR-23** — Every tracker transition is explicit and undoable.
- **FR-24** — The user can open the saved folder for any tracked job.
- **FR-24a** — The tracker can be viewed one calendar week at a time, bucketed by the week the job was scraped (Monday-start, local time). It opens on the current week — even when that week is empty — steps ‹ › through every calendar week between the oldest tracked job and today, and offers an all-time reset. The visible jobs and all summary counts (funnel, status chips, column counts) reflect the selected week.

### Config & data
- **FR-25** — Setup stores: resume LaTeX, source of truth, saved-search inputs, scraper strategy, the Greenhouse on/off toggle (`greenhouseEnabled`, FR-5a — orthogonal to the primary strategy), owner name, blocked companies, the auto-filter score threshold (FR-9a), and the scoring backend plus local model tag (FR-6). The aggregator key that FR-5a needs is not stored here — it is read server-side only from the environment (NFR-7 / Environment variables), and Setup surfaces at most a "set/missing" presence indicator.
- **FR-26** — All data lives in a single local file and is exportable (the file itself, or a dump).

### Observability
- **FR-27** — Every AI call (score — local or Anthropic, batch score, rewrite, explain, salary lookup) records its per-request token usage — including cache reads/writes on Anthropic calls; local scoring calls record their real prompt/output token counts at a cost of exactly $0 — plus an estimated cost snapshot, latency, stop reason, and any error in SQLite, traceable per job. The dashboard surfaces tokens and estimated cost (today / last 7 days, split by call type) and the cache hit rate, with a visible warning when the scoring cache prefix stops being read; a dedicated Usage page lists each recorded call individually (time, type, job, tokens, cost, latency, outcome). Telemetry is best-effort: a failed write never fails the user-facing operation.

### Notifications
- **FR-28** — After each headless scheduled run (§12), at most **one** native desktop toast summarizes that run's notable results — no browser tab required: jobs scored at or above the FR-9a threshold ("strong matches" — a single match is named in full; several are counted, with the best match's company and score headlined) and jobs parked at 70 under FR-6a ("needs review" — counted separately and never presented as earned scores). Parks notify independently of the threshold in both directions: they toast even when the threshold is above 70, and they are never folded into the strong-match count when it is below 70. A run that scores nothing notable stays silent, and only the run's newly scored jobs count — jobs scored in earlier runs never re-notify. There is no separate on/off toggle: a configured run interval (`runIntervalMinutes > 0`) is the opt-in, and interval 0 disables both the runs and the toasts; the browser-side alert toggle continues to govern only the interactive flows. A notification failure never fails the run.

## 8. Non-functional requirements

- **NFR-1 — Local & self-contained.** One Next.js process; no remote services required to run. The default scoring backend talks to a local Ollama daemon on the same machine — still fully local, but a separate process the user runs.
- **NFR-2 — Cost.** Near-zero infrastructure; scoring — the highest-frequency AI call — runs on the local model at zero marginal cost by default. When the Anthropic backend is selected, AI cost is minimized via the cheap tier for scoring, prompt caching, the blocklist filtering before scoring, and the Batch API's 50% discount for scheduled (headless) scoring runs where latency is free.
- **NFR-3 — One-page guarantee.** A hard invariant enforced at save time, not advisory.
- **NFR-4 — Truthfulness.** Rewrites are constrained to user-provided material.
- **NFR-5 — Reversibility.** Every status-changing action is undoable.
- **NFR-6 — Determinism where feasible.** Identical LaTeX compiles to identical bytes; path building is deterministic.
- **NFR-7 — Security.** LaTeX compiles in a hardened sandbox; file paths are built server-side from identifiers and never trusted from the client; the API key stays server-side.
- **NFR-8 — Resilience.** Interrupted background work is reconciled on restart.
- **NFR-9 — Latency.** Rewrite output begins streaming within ~1–2s; scores land within seconds of a scrape.

## 9. Success metrics

- Time per tailored application (scrape → saved PDF) under ~5 minutes.
- 100% of saved resumes are exactly one page.
- Zero fabricated claims in spot checks — every rewrite traces to the source of truth.
- AI cost for a typical session (~10 scores + 3 rewrites) well under 10 cents.
- The user can answer their own outcome questions from exported data (e.g., pass→interview rates) without code changes.

## 10. Constraints & assumptions

- LinkedIn guest endpoints remain accessible at cautious request rates; Proxycurl is a fallback. Rate limiting is IP-based and no account is at risk.
- The user maintains a compile-clean LaTeX resume using a simple, standard template.
- TeX Live is installed locally.
- A single user on a single machine; no concurrent writers.

## 11. Key flow (reference)

Scrape → Score → Decide (pass / pursue) → Rewrite (stream + diff + why + edit + preview) → Approve (one-page gate + save) → Track. Detailed mechanics live in `jobfinder-docs.md`.

## 12. Open questions / future

- Scheduled scraping is implemented: a backend scheduler (one Node-process singleton) runs scrape+score on the `run_interval_minutes` cadence set in Setup, with an overlap guard; the Jobs view shows a live countdown to the next run and a "Run now" that resets it. A run's notable scores fire one native desktop toast (FR-28). See "Scheduled scraping" in `jobfinder-docs.md`.
- Cover-letter generation, ATS keyword-coverage checking, follow-up email drafting, and multi-profile support (see "Extending the App" in `jobfinder-docs.md`).
