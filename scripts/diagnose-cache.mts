/**
 * A/B cost test: old scoring request shape vs new, against the live API.
 *
 * Variant A (old): system = [prompt, profile] with a plain 5m cache breakpoint —
 *   the shape whose prefix straddled Haiku's 4096-token cache floor.
 * Variant B (new): buildScoreRequest as shipped — prompt + SCORING_CONTRACT +
 *   profile, 1h TTL breakpoint.
 *
 * Each variant runs twice with an identical job posting: call 1 shows the cache
 * write, call 2 shows the read (or, if the prefix is under the floor, neither —
 * which is the point). The two variants' prefixes diverge at the second system
 * block, so they occupy separate cache entries and don't contaminate each other.
 *
 * Run: npx tsx scripts/diagnose-cache.mts        (~4 calls, a few cents total)
 * Delete this file once the question is settled.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { buildScoreRequest } from '../lib/ai/score';
import { latexToPlainText } from '../lib/latex/to-plain-text';

// Minimal .env.local loader (no dotenv in deps)
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const dbPath = process.env.JOBFINDER_DB_PATH;
if (!dbPath) throw new Error('JOBFINDER_DB_PATH not set');

const db = new Database(dbPath, { readonly: true });
const cfg = db
  .prepare('SELECT resume_latex, source_of_truth, scoring_prompt FROM user_config LIMIT 1')
  .get() as { resume_latex?: string; source_of_truth?: string; scoring_prompt?: string } | undefined;
db.close();

const asset = (f: string) => fs.readFileSync(path.join('resume', f), 'utf8');
const pick = (v: string | undefined, fallback: string) =>
  v && v.trim().length > 0 ? v : fallback;

const input = {
  systemPrompt: pick(cfg?.scoring_prompt, asset('scoring_prompt.md')),
  sourceOfTruth: pick(cfg?.source_of_truth, asset('source_of_truth.md')),
  resumePlainText: latexToPlainText(pick(cfg?.resume_latex, asset('base_resume.tex'))),
  jobDescription:
    'Title: Software Engineer\nCompany: DiagnosticCo\nLocation: Remote\n\n' +
    'Sample posting used only to compare cache behavior. Requires 3+ years of experience with TypeScript and SQL.',
};

// Variant B: exactly what the app sends today.
const newRequest = buildScoreRequest(input);

// Variant A: the pre-change shape — no contract block, default 5m TTL.
const oldRequest: Anthropic.MessageCreateParamsNonStreaming = {
  model: newRequest.model,
  max_tokens: newRequest.max_tokens,
  system: [
    { type: 'text', text: input.systemPrompt },
    {
      type: 'text',
      text:
        `Candidate professional profile.\n\n` +
        `Source of truth (real accomplishments, metrics, skills):\n${input.sourceOfTruth}\n\n` +
        `Resume (plain text):\n${input.resumePlainText}`,
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: newRequest.messages,
};

// Haiku 4.5 $/MTok: input 1.00, output 5.00, cache read 0.10,
// 5m cache write 1.25, 1h cache write 2.00.
const RATE = { input: 1.0, output: 5.0, read: 0.1 };

interface CallCost {
  label: string;
  input: number;
  write: number;
  read: number;
  output: number;
  usd: number;
}

function price(label: string, u: Anthropic.Usage, writeRate: number): CallCost {
  const input = u.input_tokens;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const output = u.output_tokens;
  const usd =
    (input * RATE.input + write * writeRate + read * RATE.read + output * RATE.output) / 1e6;
  return { label, input, write, read, output, usd };
}

const client = new Anthropic();

async function runVariant(
  name: string,
  request: Anthropic.MessageCreateParamsNonStreaming,
  writeRate: number,
): Promise<CallCost[]> {
  const costs: CallCost[] = [];
  for (const call of [1, 2]) {
    const msg = await client.messages.create(request);
    costs.push(price(`${name} call ${call}`, msg.usage, writeRate));
  }
  return costs;
}

const fmt = (c: CallCost) =>
  `${c.label}: input=${c.input} cache_write=${c.write} cache_read=${c.read} output=${c.output} → $${c.usd.toFixed(5)}`;

try {
  const a = await runVariant('OLD (no contract, 5m)', oldRequest, 1.25);
  const b = await runVariant('NEW (contract, 1h)', newRequest, 2.0);

  console.log('--- raw usage ---');
  [...a, ...b].forEach((c) => console.log(fmt(c)));

  // Steady-state = every call after the first in a warm window (call 2).
  const oldSteady = a[1]!.usd;
  const newSteady = b[1]!.usd;
  console.log('\n--- verdict ---');
  console.log(`OLD caching engaged: ${a[1]!.read > 0 ? 'YES' : 'NO (prefix under the 4096-token floor)'}`);
  console.log(`NEW caching engaged: ${b[1]!.read > 0 ? 'YES' : 'NO — investigate!'}`);
  console.log(`Steady-state cost/job: OLD $${oldSteady.toFixed(5)} vs NEW $${newSteady.toFixed(5)}`);
  console.log(`Per-job saving: ${((1 - newSteady / oldSteady) * 100).toFixed(0)}%`);

  // A representative 10-job scheduled batch: 1 first call + 9 steady.
  const batch = (first: CallCost, steady: CallCost) => first.usd + 9 * steady.usd;
  const oldBatch = batch(a[0]!, a[1]!);
  const newBatch = batch(b[0]!, b[1]!);
  console.log(
    `10-job batch (cold start): OLD $${oldBatch.toFixed(4)} vs NEW $${newBatch.toFixed(4)} ` +
      `(${((1 - newBatch / oldBatch) * 100).toFixed(0)}% saved; warm-cache runs save more — no write, all reads)`,
  );
} catch (err) {
  const msg = (err as Error).message ?? String(err);
  if (msg.includes('credit balance')) {
    console.error('\nAPI credit balance is empty — top up, then re-run: npx tsx scripts/diagnose-cache.mts');
    process.exit(1);
  }
  throw err;
}
