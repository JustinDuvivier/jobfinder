# JobFinder — single-container image: Node runtime + built Next.js app +
# TeX Live, so the whole pipeline (scrape → score → rewrite → compile → save)
# runs inside one container.
#
# Env/volume contract baked into the image (see lib/db, lib/http/guards,
# lib/latex/sandbox, lib/env/container):
#   JOBFINDER_CONTAINER=1        — container mode: host-OS features (open
#                                   folder, desktop toasts) degrade gracefully
#   JOBFINDER_DB_PATH=/data/jobfinder.db — SQLite file; mount /data to persist
#   JOBFINDER_OUTPUT_DIR=/output — approved resume packages; mount /output
#   pdflatex is on PATH            — no JOBFINDER_PDFLATEX_PATH override needed
# Provide at run time (never baked in): ANTHROPIC_API_KEY, and optionally
# RAPID_API_KEY / OLLAMA_BASE_URL.
#
# Personal resume assets: the app reads ./resume/* (falling back to the
# committed ./resume-example/* starters). resume/ is gitignored and
# .dockerignore'd, so it is never baked in — mount your own at run time:
#   -v /path/to/resume:/app/resume:ro

# ---- Stage 1: build ---------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for better-sqlite3 (native module) in case no prebuilt binary
# matches and node-gyp has to compile from source.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
    && npm prune --omit=dev

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Mid-size TeX Live (~1.7 GB installed): recommended + latex-extra + fonts
# covers real-world resume templates without the ~6 GB texlive-full.
#
# Extending TeX for exotic packages: Debian's TeX Live has no usable tlmgr, so
# add further Debian collections in a derived image, e.g.
#   FROM jobfinder
#   USER root
#   RUN apt-get update && apt-get install -y --no-install-recommends \
#         texlive-science texlive-fonts-extra && rm -rf /var/lib/apt/lists/*
#   USER node
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        texlive-latex-recommended \
        texlive-latex-extra \
        texlive-fonts-recommended \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    JOBFINDER_CONTAINER=1 \
    JOBFINDER_DB_PATH=/data/jobfinder.db \
    JOBFINDER_OUTPUT_DIR=/output

WORKDIR /app

# Runtime needs: the compiled app, prod node_modules (better-sqlite3 native
# binding included), next.config.mjs (read by `next start`), and the committed
# generic resume starters (the zero-config fallback for lib/resume/load).
COPY --from=build /app/package.json /app/next.config.mjs ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/resume-example ./resume-example

RUN mkdir -p /data /output \
    && chown -R node:node /data /output

USER node

EXPOSE 3000
VOLUME ["/data", "/output"]

# Inside the container the server must listen on 0.0.0.0 (the host reaches it
# through Docker's port mapping); the repo's `npm start` binds 127.0.0.1 for
# bare-metal use, so the bind is overridden here instead of in package.json.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0"]
