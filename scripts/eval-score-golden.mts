/**
 * Scoring-model eval: run the golden/score.golden.json case set against one or
 * more scoring models and grade each raw reply with the constraint-based
 * expectations the golden file defines (see its "grading" block — every check
 * except parsed-score grades the RAW reply, before the app's quote re-derive +
 * gap-cap corrections would mask model failures).
 *
 * Models:
 *   haiku  — the shipped Anthropic scorer: buildScoreRequest via the SDK.
 *   sonnet — the same request on the quality tier (REWRITE_MODEL), as a probe.
 *   qwen   — a local Ollama model (same system+user text, temperature 0).
 *
 * Run:  npx tsx scripts/eval-score-golden.mts [haiku] [sonnet] [qwen]   (default: haiku qwen)
 * Env:  ANTHROPIC_API_KEY via .env.local; Ollama at localhost:11434.
 *
 * Prompts come from the resume/ asset files. The app itself scores with the
 * *effective* config — a non-empty stored user_config row overrides the assets
 * (lib/config/effective.ts) — so before trusting a comparison, make sure the
 * stored scoring prompt / source of truth match the assets (or are cleared),
 * or this eval grades a prompt the app no longer sends.
 *
 * Prints a per-case scorecard per model plus a head-to-head summary, and
 * writes the full raw replies + grades to eval-score-results.json next to
 * this script's cwd for inspection. One-shot comparison tool, not part of the
 * test suite — the suite never calls a live model (CLAUDE.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildScoreRequest,
  requiredYearsFromQuote,
  gapScoreCap,
  PARKED_REVIEW_SCORE,
  SCORING_CONTRACT,
} from '../lib/ai/score';
import { extractText } from '../lib/ai/parse';
import {
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_NUM_CTX,
  REWRITE_MODEL,
  SCORING_MAX_TOKENS,
} from '../lib/ai/models';
import { latexToPlainText } from '../lib/latex/to-plain-text';
import { describeJob } from '../lib/jobs/describe';
import { resolveSalary } from '../lib/salary';
import type { Job } from '../lib/types';

// Minimal .env.local loader (no dotenv in deps).
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

/** Override with e.g. $env:OLLAMA_SCORE_MODEL='qwen3.5:9b' to eval another local model. */
const OLLAMA_MODEL = process.env.OLLAMA_SCORE_MODEL ?? DEFAULT_OLLAMA_MODEL;
/**
 * Thinking control. Default false: thinking burned the whole output budget
 * before any JSON appeared, and Haiku scores without extended thinking too.
 * Models that can't switch thinking off (gpt-oss) take an effort level
 * instead: $env:OLLAMA_SCORE_THINK='low'|'medium'|'high'.
 */
const OLLAMA_THINK: boolean | string =
  process.env.OLLAMA_SCORE_THINK !== undefined ? process.env.OLLAMA_SCORE_THINK : false;
const OLLAMA_URL = 'http://localhost:11434/api/chat';

type Range = [number, number];

interface EvalCase {
  id: string;
  source: { type: 'job-detail-golden' | 'inline'; jobId?: string };
  jobDescription?: string;
  expected: {
    requiredQuote: { equals?: string; contains?: string };
    requiredYears: { exact?: number; range?: Range };
    gapYearsRange: Range;
    scoreRange: Range;
    yearsRowVerdicts?: string[];
    concernsMustMentionShortfall: boolean;
    recallCritical?: boolean;
  };
}

interface ScoreGolden {
  candidateYearsRange: Range;
  cases: EvalCase[];
}

interface DetailFixture {
  description: string;
  salary?: string;
  applicants?: string;
  seniorityLevel?: string;
  employmentType?: string;
  jobFunction?: string;
  industries?: string;
}

interface CardFixture {
  jobId: string;
  title: string;
  company: string;
  url: string;
  location: string | null;
  postedAt: string | null;
}

const golden = readJson<ScoreGolden>('golden/score.golden.json');
const details = readJson<Record<string, DetailFixture>>('golden/job-detail.golden.json');
const cards = readJson<CardFixture[]>('golden/jobs.parse.golden.json');

function readJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), rel), 'utf8')) as T;
}

const asset = (f: string) => fs.readFileSync(path.join('resume', f), 'utf8');
const systemPrompt = asset('scoring_prompt.md');
const sourceOfTruth = asset('source_of_truth.md');
const resumePlainText = latexToPlainText(asset('base_resume.tex'));
const profileBlock =
  `Candidate professional profile.\n\n` +
  `Source of truth (real accomplishments, metrics, skills):\n${sourceOfTruth}\n\n` +
  `Resume (plain text):\n${resumePlainText}`;

/** Rebuild the exact describeJob() text the app would score, from the fixtures. */
function jobDescriptionFor(c: EvalCase): string {
  if (c.source.type === 'inline') {
    if (!c.jobDescription) throw new Error(`${c.id}: inline case without jobDescription`);
    return c.jobDescription;
  }
  const jobId = c.source.jobId ?? '';
  const card = cards.find((j) => j.jobId === jobId);
  const detail = details[jobId];
  if (!card || !detail) throw new Error(`${c.id}: fixture ${jobId} missing from goldens`);
  const job: Job = {
    id: 0,
    jobId,
    company: card.company,
    title: card.title,
    location: card.location,
    // Mirror the scrape pipeline (lib/scrape/run.ts): the salary line the app
    // scores is the *resolved* one, not the raw detail field.
    salary: resolveSalary({ field: detail.salary || null, description: detail.description }).salary,
    description: detail.description,
    url: card.url,
    postedAt: card.postedAt,
    seniorityLevel: detail.seniorityLevel ?? null,
    employmentType: detail.employmentType ?? null,
    jobFunction: detail.jobFunction ?? null,
    industries: detail.industries ?? null,
    applicants: detail.applicants ?? null,
    status: 'new',
    score: null,
    scoreReason: null,
    belowThreshold: false,
    rewrittenLatex: null,
    explanation: null,
    approvedPdfPath: null,
    latexHash: null,
    createdAt: '',
    updatedAt: '',
  };
  return describeJob(job);
}

const userMessage = (jobDescription: string) =>
  `Score this job against the candidate above.\n\nJob description:\n${jobDescription}`;

// ---------------------------------------------------------------------------
// Model callers — each returns the visible reply text.
// ---------------------------------------------------------------------------

const anthropic = new Anthropic();

/** The shipped Anthropic request; `model` overrides the scoring tier so other
 *  Anthropic models (e.g. Sonnet 5) can be probed with an identical prompt. */
function callAnthropicWith(model?: string) {
  return async (jobDescription: string): Promise<CallOutcome> => {
    const request = buildScoreRequest({ systemPrompt, sourceOfTruth, resumePlainText, jobDescription });
    if (model) request.model = model;
    const message = await anthropic.messages.create(request);
    return {
      reply: extractText(message),
      doneReason: message.stop_reason ?? undefined,
      promptTokens: message.usage.input_tokens,
      evalTokens: message.usage.output_tokens,
    };
  };
}

const callHaiku = callAnthropicWith();

interface OllamaChatResponse {
  message?: { content?: string; thinking?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** What a model call yields: the reply text plus the transport evidence the
 *  results file keeps (truncation signal, token counts). */
interface CallOutcome {
  reply: string;
  doneReason?: string;
  promptTokens?: number;
  evalTokens?: number;
}

async function callQwen(jobDescription: string): Promise<CallOutcome> {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: OLLAMA_THINK,
      // Anthropic system blocks are adjacent text; join them the same way.
      messages: [
        { role: 'system', content: `${systemPrompt}\n\n${SCORING_CONTRACT}\n\n${profileBlock}` },
        { role: 'user', content: userMessage(jobDescription) },
      ],
      // Mirror the app's local transport (lib/ai/ollama.ts): the shared
      // constants size the window for the longest captured real postings.
      options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX, num_predict: SCORING_MAX_TOKENS },
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as OllamaChatResponse;
  if (data.error) throw new Error(`Ollama: ${data.error}`);
  return {
    // Grade the visible answer: drop any inline <think> block (Ollama usually
    // separates thinking into message.thinking already).
    reply: (data.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
    doneReason: data.done_reason,
    promptTokens: data.prompt_eval_count,
    evalTokens: data.eval_count,
  };
}

// ---------------------------------------------------------------------------
// Grader — mirrors the golden file's grading block.
// ---------------------------------------------------------------------------

interface Check {
  id: string;
  pass: boolean;
  detail: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: number, [min, max]: Range) => v >= min && v <= max;

/** The persisted score the app would derive from this raw reply, or null when
 *  the app would reject the reply outright and persist nothing (mirrors
 *  validateScore + experienceFromModelReply in lib/ai/score.ts, including the
 *  FR-6a park rule for inferred big-gap requirements). */
function parsedScoreOf(raw: Record<string, unknown>): { score: number; parked: boolean } | null {
  if (!isNum(raw.score)) return null;
  // validateScore throws on empty reasoning (tolerating a "reason" alias);
  // the job stays unscored, so there is no persisted score to grade.
  const reasoning =
    typeof raw.reasoning === 'string' ? raw.reasoning : typeof raw.reason === 'string' ? raw.reason : '';
  if (reasoning.trim().length === 0) return null;
  let score = Math.max(0, Math.min(100, Math.round(raw.score)));
  let parked = false;
  const exp = raw.experience as Record<string, unknown> | undefined;
  if (exp && typeof exp === 'object') {
    // A missing/non-string quote coerces to '' and required years fall back to
    // the model's own number, exactly as experienceFromModelReply does.
    const quote = typeof exp.required_quote === 'string' ? exp.required_quote.trim() : '';
    const quoteYears = requiredYearsFromQuote(quote);
    const req = quoteYears ?? (isNum(exp.required_years) ? exp.required_years : null);
    if (req !== null && isNum(exp.candidate_years)) {
      const cap = gapScoreCap(req - exp.candidate_years);
      if (quoteYears === null && cap < PARKED_REVIEW_SCORE) {
        // No readable years figure in the quote: the requirement was inferred,
        // so a sub-70 cap is superseded — the app parks at exactly 70 and
        // flags for review.
        score = PARKED_REVIEW_SCORE;
        parked = true;
      } else {
        score = Math.min(score, cap);
      }
    } else if (quoteYears === null && score < PARKED_REVIEW_SCORE) {
      // Unusable numbers on an inferred requirement: no gap is computable, so
      // a low raw score may be a self-applied cap — the app parks it too.
      score = PARKED_REVIEW_SCORE;
      parked = true;
    }
  }
  return { score, parked };
}

function gradeCase(c: EvalCase, replyText: string): Check[] {
  const checks: Check[] = [];
  const add = (id: string, pass: boolean, detail: string) => checks.push({ id, pass, detail });

  const trimmed = replyText.trim();
  add(
    'json-only',
    trimmed.startsWith('{') && trimmed.endsWith('}') && !trimmed.includes('```'),
    `reply starts "${trimmed.slice(0, 20)}…"`,
  );

  let raw: Record<string, unknown>;
  try {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    raw = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch (err) {
    add('parses', false, `unparseable: ${(err as Error).message}`);
    return checks;
  }

  const exp = (raw.experience ?? {}) as Record<string, unknown>;
  const quote = typeof exp.required_quote === 'string' ? exp.required_quote.trim() : null;
  const cand = isNum(exp.candidate_years) ? exp.candidate_years : null;
  const req = isNum(exp.required_years) ? exp.required_years : null;
  const gap = isNum(exp.gap_years) ? exp.gap_years : null;

  add(
    'exp-shape',
    quote !== null && cand !== null && req !== null && gap !== null,
    `quote=${JSON.stringify(quote)} cand=${cand} req=${req} gap=${gap}`,
  );
  if (cand !== null && req !== null && gap !== null) {
    add('gap-math', Math.abs(gap - (req - cand)) <= 0.6, `gap ${gap} vs ${req}-${cand}`);
  }
  if (cand !== null) {
    add('cand-years', inRange(cand, golden.candidateYearsRange), `candidate_years=${cand}`);
  }

  const rawScore = isNum(raw.score) ? raw.score : null;
  add(
    'score-consistent',
    rawScore !== null &&
      rawScore >= 0 &&
      rawScore <= 100 &&
      (gap === null || rawScore <= gapScoreCap(gap) + 5),
    `raw score=${rawScore}, own-gap cap=${gap === null ? 'n/a' : gapScoreCap(gap)}`,
  );

  const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.trim() : '';
  const words = reasoning.split(/\s+/).filter(Boolean).length;
  add('reasoning', reasoning.length > 0 && words <= 60, `${words} words`);

  const rows = Array.isArray(raw.comparison) ? (raw.comparison as Record<string, unknown>[]) : [];
  const firstDim = typeof rows[0]?.dimension === 'string' ? (rows[0]!.dimension as string) : '';
  const verdictsOk = rows.every((r) => ['match', 'partial', 'gap'].includes(String(r.verdict)));
  // Every row needs a dimension and at least one side, or asTapeRows drops it.
  const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  const rowsComplete = rows.every((r) => hasText(r.dimension) && (hasText(r.you) || hasText(r.them)));
  add(
    'comparison',
    rows.length >= 4 && rows.length <= 6 && firstDim === 'Years of experience' && verdictsOk && rowsComplete,
    `${rows.length} rows, first="${firstDim}"${rowsComplete ? '' : ', has row(s) asTapeRows would drop'}`,
  );

  const keyMatches = Array.isArray(raw.key_matches) ? raw.key_matches : [];
  const concerns = Array.isArray(raw.concerns) ? raw.concerns : [];
  const allStrings = (a: unknown[]) => a.every((v) => typeof v === 'string');
  add(
    'chips',
    keyMatches.length >= 2 && keyMatches.length <= 4 && concerns.length >= 1 && concerns.length <= 3 &&
      allStrings(keyMatches) && allStrings(concerns),
    `key_matches=${keyMatches.length} concerns=${concerns.length}`,
  );

  const { requiredQuote, requiredYears, gapYearsRange, scoreRange, yearsRowVerdicts, concernsMustMentionShortfall } =
    c.expected;
  add(
    'quote',
    quote !== null &&
      (requiredQuote.equals !== undefined
        ? quote.toLowerCase() === requiredQuote.equals.toLowerCase()
        : quote.includes(requiredQuote.contains ?? '')),
    `quote=${JSON.stringify(quote)} expected ${JSON.stringify(requiredQuote)}`,
  );
  add(
    'req-years',
    req !== null &&
      (requiredYears.exact !== undefined ? req === requiredYears.exact : inRange(req, requiredYears.range!)),
    `required_years=${req} expected ${JSON.stringify(requiredYears)}`,
  );
  add('gap-range', gap !== null && inRange(gap, gapYearsRange), `gap_years=${gap} expected ${JSON.stringify(gapYearsRange)}`);

  if (yearsRowVerdicts) {
    const v = String(rows[0]?.verdict ?? '');
    add('years-verdict', yearsRowVerdicts.includes(v), `first-row verdict="${v}" allowed ${JSON.stringify(yearsRowVerdicts)}`);
  }
  if (concernsMustMentionShortfall) {
    add(
      'concerns-shortfall',
      concerns.some((s) => typeof s === 'string' && /(yrs?|years?|experience)/i.test(s)),
      `concerns=${JSON.stringify(concerns)}`,
    );
  }

  // Asymmetric severity: an underscore on a *recall-critical* case (a genuine
  // match) is hidden behind the FR-9a threshold filter — a recall miss. On the
  // trap cases a below-floor score is still a miss, but the job deserved to be
  // hidden; an overscore anywhere is only queue noise.
  const parsed = parsedScoreOf(raw);
  const miss =
    parsed === null
      ? ' — reply rejected: nothing persisted, job re-scores'
      : parsed.score < scoreRange[0]
        ? c.expected.recallCritical
          ? ' — UNDERSCORE (recall miss: job would be hidden)'
          : ' — below expected floor (not a recall-critical case)'
        : parsed.score > scoreRange[1]
          ? ' — overscore (queue noise)'
          : '';
  add(
    'parsed-score',
    parsed !== null && inRange(parsed.score, scoreRange),
    `parsed=${parsed === null ? 'none' : parsed.score}${parsed?.parked ? ' (parked for review)' : ''} (raw ${rawScore}) expected ${JSON.stringify(scoreRange)}${miss}`,
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface CaseResult {
  caseId: string;
  ms: number;
  reply: string;
  doneReason?: string;
  promptTokens?: number;
  evalTokens?: number;
  error?: string;
  checks: Check[];
}

async function runModel(
  name: string,
  call: (jobDescription: string) => Promise<CallOutcome>,
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of golden.cases) {
    const started = Date.now();
    try {
      const { reply, doneReason, promptTokens, evalTokens } = await call(jobDescriptionFor(c));
      results.push({
        caseId: c.id,
        ms: Date.now() - started,
        reply,
        doneReason,
        promptTokens,
        evalTokens,
        checks: gradeCase(c, reply),
      });
    } catch (err) {
      results.push({
        caseId: c.id,
        ms: Date.now() - started,
        reply: '',
        error: (err as Error).message,
        checks: [],
      });
    }
    const last = results[results.length - 1]!;
    const passed = last.checks.filter((k) => k.pass).length;
    console.log(
      `[${name}] ${c.id}: ${last.error ? `ERROR ${last.error}` : `${passed}/${last.checks.length} checks`} (${(last.ms / 1000).toFixed(1)}s)`,
    );
  }
  return results;
}

function report(name: string, results: CaseResult[]): void {
  console.log(`\n=== ${name} ===`);
  let totalPass = 0;
  let totalChecks = 0;
  let fullPasses = 0;
  for (const r of results) {
    const failed = r.checks.filter((k) => !k.pass);
    totalPass += r.checks.length - failed.length;
    totalChecks += r.checks.length;
    if (!r.error && failed.length === 0) fullPasses += 1;
    const status = r.error
      ? `ERROR: ${r.error}`
      : failed.length === 0
        ? 'PASS'
        : `FAIL [${failed.map((k) => k.id).join(', ')}]`;
    console.log(`  ${r.caseId.padEnd(34)} ${status}`);
    for (const k of failed) console.log(`      ✗ ${k.id}: ${k.detail}`);
  }
  const scoreMisses = results.flatMap((r) =>
    r.checks.filter((k) => k.id === 'parsed-score' && !k.pass).map((k) => k.detail),
  );
  const under = scoreMisses.filter((d) => d.includes('UNDERSCORE')).length;
  const over = scoreMisses.filter((d) => d.includes('overscore')).length;
  console.log(
    `  → cases ${fullPasses}/${results.length} clean, checks ${totalPass}/${totalChecks}; ` +
      `recall misses (underscored) ${under}, overscores ${over}`,
  );
}

const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['haiku', 'qwen'];

// Merge into the existing results file so runs of different models accumulate
// (each Ollama model gets its own key, e.g. "qwen(qwen3.5:9b)").
const outPath = path.join(process.cwd(), 'scripts', 'eval-score-results.json');
const all: Record<string, CaseResult[]> = fs.existsSync(outPath)
  ? (JSON.parse(fs.readFileSync(outPath, 'utf8').replace(/^﻿/, '')) as Record<string, CaseResult[]>)
  : {};

for (const model of wanted) {
  if (model === 'haiku') all.haiku = await runModel('haiku', callHaiku);
  else if (model === 'sonnet')
    all[`sonnet(${REWRITE_MODEL})`] = await runModel('sonnet', callAnthropicWith(REWRITE_MODEL));
  else if (model === 'qwen') all[`qwen(${OLLAMA_MODEL})`] = await runModel(OLLAMA_MODEL, callQwen);
  else throw new Error(`Unknown model "${model}" (expected haiku, sonnet, and/or qwen)`);
}

for (const [name, results] of Object.entries(all)) report(name, results);

fs.writeFileSync(outPath, JSON.stringify(all, null, 2));
console.log(`\nFull replies + grades written to ${outPath}`);
