# JobFinder

[![CI](https://github.com/JustinDuvivier/jobfinder/actions/workflows/ci.yml/badge.svg)](https://github.com/JustinDuvivier/jobfinder/actions/workflows/ci.yml)
[![Container image](https://img.shields.io/badge/ghcr.io-justinduvivier%2Fjobfinder-blue)](https://github.com/JustinDuvivier/jobfinder/pkgs/container/jobfinder)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A self-hosted, single-user job-application pipeline: **scrape** fresh LinkedIn postings → **score** each against your resume → **decide** which to pursue → **tailor** your LaTeX resume with AI (streaming side-by-side editor, diff, and rationale) → save an approved, **exactly-one-page PDF** to a dated folder → **track** every application through the hiring pipeline.

It runs on your own machine, for one person: one Next.js process, one SQLite file, no accounts. Scoring runs free on a local Ollama model by default; the resume rewrite runs on Claude (an Anthropic API key is the only paid requirement for a typical session — a few cents per tailored resume).

> **Read first:**
>
> - **No login, localhost only.** The app has no authentication. It is only reachable at `http://127.0.0.1:3000` on the machine that runs it — keep it that way. See [Security model](#security-model-no-auth-localhost-only).
> - **LinkedIn terms.** Scraping LinkedIn — even its public, logged-out pages — may violate LinkedIn's Terms of Service. This tool is for **personal use**, uses no LinkedIn account, and keeps request rates modest, but the risk (e.g. your IP being rate-limited or blocked) is **yours**. See [LinkedIn disclaimer](#linkedin-scraping-disclaimer).

## Quick start (Docker Compose)

Prerequisites: [Docker](https://docs.docker.com/get-docker/) with Compose, and an [Anthropic API key](https://console.anthropic.com/).

```sh
git clone https://github.com/JustinDuvivier/jobfinder.git
cd jobfinder
cp .env.example .env       # then edit .env and set ANTHROPIC_API_KEY
docker compose up
```

Then open **http://127.0.0.1:3000**.

The first start is slow, once: Docker pulls the prebuilt app image (it ships a mid-size TeX Live so the whole pipeline — including PDF compilation — runs in the container), and a one-shot init service pulls the ~2.5 GB local scoring model into a persistent volume. Later starts skip both.

What the stack is:

- **app** — the Next.js app + TeX Live, pulled prebuilt from `ghcr.io/justinduvivier/jobfinder` (published by this repo's release workflow). Published on `127.0.0.1:3000` only. Contributors can build from source instead: `docker compose -f docker-compose.yml -f docker-compose.build.yml up --build`.
- **ollama** — the local-scoring sidecar (free, CPU-friendly scoring is the default). Not published on any port.
- **ollama-pull** — a one-shot init that pre-pulls the scoring model, then exits.

Where your data lives:

| Location | Contents |
|----------|----------|
| `jobfinder-data` named volume | The SQLite database (jobs, scores, statuses, config). Survives `docker compose down`; only `down -v` deletes it. |
| `ollama-models` named volume | The downloaded scoring model, so it is pulled once. |
| `./output/` on your machine | Approved resume PDFs, as `YYYYMMDD/Company_Title_xxxxxx/Owner_Resume.pdf`. |
| `./resume/` on your machine (optional) | Your private resume assets, mounted read-only into the app. Gitignored — never committed, never baked into the image. |

On first start the app walks you through a short guided setup: you paste **your** one-page LaTeX resume into an editor prefilled with the committed example (for a generic "Alex Candidate"), and it is accepted once it compiles to exactly one page. The three companion documents — scoring prompt, rewrite rules, source of truth — work as-is out of the box and are optional steps you can customize then or later, in the app. After that you can scrape, score, rewrite, and save a PDF immediately.

## Your resume (the one requirement)

JobFinder **tailors an existing LaTeX resume** — it does not author one from scratch, and the output PDF must compile to exactly one page (the app refuses to save anything longer).

The normal path is the first-run flow above: supply the resume in the app (it is stored in the SQLite database, so it survives restarts), and edit it — or any companion document — any time under **Settings → Documents**, where each document shows where it currently comes from and can be reverted to its default per file.

The documents:

| Document | Purpose |
|------|---------|
| Base resume (`base_resume.tex`) | Your one-page LaTeX resume — the document the AI tailors. |
| Source of truth (`source_of_truth.md`) | Your real accomplishments, metrics, and skills. Rewrites may only draw from this — it is the anti-fabrication boundary. Align it with what your resume actually claims, and keep an explicit years-of-experience figure in it — the scorer's gap logic reads it. |
| Scoring prompt (`scoring_prompt.md`) | The scoring system prompt (works as-is; optional to customize). |
| Rewrite rules (`rewrite_rules.md`) | The tailoring rules for the rewrite (works as-is; optional to customize). |

**Power-user path — mount files instead.** Drop your own files into `./resume/` (create the directory next to `docker-compose.yml`). Every file is optional and resolves per file: anything authored in-app wins, else your `resume/` file, else the committed starter in [`resume-example/`](resume-example/). The first-run flow auto-detects a mounted `resume/base_resume.tex` and confirms it instead of asking you to paste.

Don't have a LaTeX resume? Start from the prefilled example (`resume-example/base_resume.tex`) — it is a deliberately simple, ATS-friendly one-page template using only universally available packages (`geometry`, `hyperref`, `enumitem`, `titlesec`). Keeping the template simple is also what keeps AI rewrites compiling reliably.

## Scoring backends

Scoring (the high-frequency AI call) is configurable in the app's Setup page:

- **Local Ollama — the default, $0.** Runs `qwen3:4b-instruct-2507-q4_K_M` on the compose sidecar: a ~2.5 GB model that runs on CPU-only machines in roughly 5 GB of RAM (budget ~8 GB free for comfort; a GPU makes it faster but is not required). Chosen by a reproducible evaluation against the repo's golden scoring set — method and results in [`docs/scoring-model-eval.md`](docs/scoring-model-eval.md).
- **Higher-accuracy local override.** With a ~16 GB GPU you can run the tuned 27B instead: set `OLLAMA_MODEL=batiai/qwen3.6-27b:iq3` in `.env` before first start (so the init service pre-pulls it — ~11 GB), then enter the same tag in Setup → Ollama model. Eval numbers for both models are in the same doc.
- **Anthropic (Claude Haiku).** Select the Anthropic backend in Setup to score via the API instead — no local model needed, small per-job cost, uses your existing `ANTHROPIC_API_KEY`.

Either way, the resume **rewrite** and change **explanation** always run on Claude (Sonnet), which is why the Anthropic key is required.

## Security model (no auth, localhost only)

The app has **no login and no user accounts** — anyone who can reach the port can read your job data, spend your Anthropic credit, and trigger compiles. The whole security model is that nobody else can reach the port:

- Natively, the server binds `127.0.0.1`.
- In Docker, compose publishes the port as `127.0.0.1:3000` only, so it is invisible to your LAN. The Ollama sidecar publishes no ports at all.

**Do not** change the port mapping to `0.0.0.0`, port-forward it on your router, or put it behind a public reverse proxy. If you want to use it from another device, tunnel into the host machine yourself — a VPN (WireGuard, Tailscale) or an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 <host>`) — so the app itself stays unreachable from any network.

Your API keys live in the untracked `.env` (or `.env.local` natively) and are only ever read server-side.

## LinkedIn scraping disclaimer

JobFinder reads LinkedIn's **public guest endpoints** — the pages behind the logged-out jobs search. It uses no LinkedIn account, no cookies, and no browser automation, and it keeps request rates modest. Even so:

- Automated access to LinkedIn, including public pages, **may violate LinkedIn's Terms of Service**.
- This tool is intended for **personal, single-user job seeking** — not data resale, bulk harvesting, or anything commercial.
- **You use it at your own risk.** The realistic failure mode is IP-based rate-limiting or a temporary block of the guest endpoints (there is no account to suspend); how you weigh the ToS question is your call, not this repo's.

## Extending the TeX image

The image ships a mid-size TeX Live (`texlive-latex-recommended`, `texlive-latex-extra`, `texlive-fonts-recommended`) that covers standard resume templates. If your resume needs packages outside that set, extend the image — Debian's TeX Live has no usable `tlmgr`, so add Debian collections in a derived image:

```dockerfile
FROM ghcr.io/justinduvivier/jobfinder:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-science texlive-fonts-extra && rm -rf /var/lib/apt/lists/*
USER node
```

Build the derived image (`docker build -t jobfinder-extended -f your.Dockerfile .`) and point the `app` service's `image:` at it in a compose override.

## Running natively (without Docker)

The app is one Node process and runs fine outside a container:

1. Install Node.js 18+, a TeX distribution with `pdflatex` on `PATH` (TeX Live / MiKTeX / MacTeX), and — for the default local scoring — [Ollama](https://ollama.com) with the model pulled: `ollama pull qwen3:4b-instruct-2507-q4_K_M` (skip Ollama if you'll select the Anthropic scoring backend in Setup).
2. Create `.env.local` in the repo root with at least:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   JOBFINDER_DB_PATH=./jobfinder.db
   JOBFINDER_OUTPUT_DIR=/absolute/path/for/saved/resumes
   ```
   Optional: `RAPID_API_KEY` (Greenhouse source), `OLLAMA_BASE_URL` (when Ollama is not at `http://127.0.0.1:11434`), `JOBFINDER_PDFLATEX_PATH` (when `pdflatex` is not on `PATH`).
3. `npm install && npm run build && npm start` — the server binds `127.0.0.1:3000`. (`npm run dev` for development.)

Native runs additionally get the two host-OS niceties that are no-ops in the container: "open folder" opens the saved PDF's directory in your file manager, and scheduled runs can fire a desktop toast for strong matches.

## Documentation

- [`PRD.md`](PRD.md) — what the tool does and why (numbered requirements).
- [`jobfinder-docs.md`](jobfinder-docs.md) — the technical design: architecture, data model, API routes, the Docker deployment contract, and the security/one-page invariants.
- [`docs/scoring-model-eval.md`](docs/scoring-model-eval.md) — how the default local scoring model was chosen.

## License

See [LICENSE](LICENSE).
