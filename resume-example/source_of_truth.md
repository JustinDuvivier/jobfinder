# Source of Truth (what you actually did)

> **This is a committed generic example.** Replace it by creating a gitignored
> `resume/source_of_truth.md` with your real history (or paste yours into the
> Setup page, which overrides both). Keep the structure of this file — the
> scoring and rewrite prompts rely on it.
>
> This document is the **only factual basis** for scoring and rewrites. The
> rewrite step may not invent employers, titles, dates, degrees, or tools that
> are not listed here — that is the truthful-rewrite invariant. The more
> specific and quantified this file is, the better the tailored resumes.

**Curation rule.** Not everything here has to appear in the resume.
Implementation-layer details stay here for truth-tracking and only surface in
a resume when the job description asks for them by name.

**Years of experience (as of 2026): ~1.5 years.** Relevant professional
engineering experience, stated once so every consumer uses the same figure.
When a task needs the candidate's years (e.g. scoring `candidate_years`), use
this number as given — do not re-derive it from the dates below. If you change
it, note that the eval set in `golden/score.golden.json` brackets this figure
(`candidateYearsRange`) and must be updated with it.

### Software Engineer, Example Corp | Jan 2025 to Present | Example City, ST

**What it actually is:** Describe the job in plain, honest terms — what the
team does, what you personally build, who uses it.
**Tech I actually use:** Python, TypeScript, PostgreSQL, FastAPI, Docker,
Git, CI/CD. (List only tools you have genuinely used in this role.)
**Real impact:** Quantify: a customer-facing document search service serving
1,000+ daily queries; p95 API latency reduced 40% by profiling and caching.
**Stretchable framing:** Angles this experience can honestly support, e.g.
backend services, search/retrieval, performance work, production monitoring.

### Engineering Intern, Sample Startup | Jun 2024 to Dec 2024 | Remote

**What it actually is:** Automated a manual reporting workflow with scheduled
Python jobs.
**Tech I actually use:** Python, Pandas, scheduled automation.
**Real impact:** Saved the team roughly two hours per day; integration tests
caught three production-bound bugs.
**Stretchable framing:** Internal tooling, data workflows, testing culture.

### Education

- **State University** | B.S. Computer Science | Graduated 2024

### Certifications

- List real certifications only, or delete this section.

### Master skill list (only what is actually true)

- **Languages:** Python, TypeScript, SQL
- **Tools:** Git, Docker, PostgreSQL, FastAPI, React
- **Practices:** testing, CI/CD, code review, profiling
