/**
 * Salary resolution — the single owner of the salary precedence chain:
 *
 *   1. explicit field      — a card salary field, the detail page's dedicated
 *                            salary block, or an already-stored value.
 *   2. description prose   — deterministic mining via `extractSalaryFromText`.
 *   3. AI lookup           — an injected, optional async tier (lib/ai/salary),
 *                            consulted only when both deterministic tiers miss.
 *
 * Every consumer — the scrape pipeline's salary stage, the post-detail
 * enrichment in the scrape run, and `POST /api/salary` — resolves through this
 * module, so the precedence is encoded and tested exactly once. The resolver
 * returns the normalized value together with its provenance.
 */

/** Which tier produced the resolved salary; 'none' when every tier missed. */
export type SalarySource = 'field' | 'description' | 'ai' | 'none';

/** The raw material a salary can be resolved from. */
export interface SalaryFacts {
  /** The explicit salary field, when the posting (or the stored row) has one. */
  field: string | null | undefined;
  /** Description prose to mine when the field yields nothing. */
  description: string | null | undefined;
}

export interface ResolvedSalary {
  /** The normalized salary, or null when every tier missed. */
  salary: string | null;
  source: SalarySource;
}

/** The optional AI tier: return a raw salary string (normalized here) or null. */
export type SalaryAiLookup = () => Promise<string | null>;

/**
 * Resolve a salary from the deterministic tiers: the explicit field wins, else
 * the description prose is mined. Synchronous, so the scrape pipeline's salary
 * stage can call it inline.
 */
export function resolveSalary(facts: SalaryFacts): ResolvedSalary {
  const fromField = normalizeSalary(facts.field ?? null);
  if (fromField) return { salary: fromField, source: 'field' };
  const fromProse = normalizeSalary(extractSalaryFromText(facts.description));
  if (fromProse) return { salary: fromProse, source: 'description' };
  return { salary: null, source: 'none' };
}

/**
 * The full chain: the deterministic tiers, then the injected AI tier when both
 * miss. With no `aiLookup`, this is `resolveSalary`. An AI-tier error
 * propagates to the caller — the boundary decides how to surface it.
 */
export async function resolveSalaryWithAi(
  facts: SalaryFacts,
  aiLookup?: SalaryAiLookup,
): Promise<ResolvedSalary> {
  const deterministic = resolveSalary(facts);
  if (deterministic.salary || !aiLookup) return deterministic;
  const fromAi = normalizeSalary(await aiLookup());
  // The normalizer's pass-through of non-monetary text is for human-entered
  // fields ("Competitive pay"); model prose ("unable to verify a range") must
  // not persist as a salary, so the AI tier requires an actual dollar figure.
  if (fromAi && /\$\s*\d/.test(fromAi)) return { salary: fromAi, source: 'ai' };
  return { salary: null, source: 'none' };
}

/**
 * Normalize a salary string into a consistent display format. Requires a `$`
 * so prose numbers ("2 years experience") are not mistaken for pay. Expands a
 * K suffix, renders `$min – $max` (or a single amount), and appends a
 * recognized period (/yr, /hr, /mo). Returns the trimmed original when no
 * dollar amount is found, and null when empty.
 */
export function normalizeSalary(raw: string | null): string | null {
  if (raw == null) return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return null;

  const amounts = [...s.matchAll(/\$\s*([\d,]+(?:\.\d+)?)\s*([kK])?/g)]
    .map((m) => {
      let n = parseFloat(m[1].replace(/,/g, ''));
      if (m[2]) n *= 1000;
      return n;
    })
    .filter((n) => Number.isFinite(n) && n > 0);

  if (amounts.length === 0) return s;

  const fmt = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
  // Annual is the obvious default, so a "/yr" suffix is just noise — show the
  // number alone. Keep "/hr" and "/mo" since those genuinely change the meaning.
  const period = periodSuffix(s) === '/yr' ? '' : periodSuffix(s);
  if (amounts.length === 1) return `${fmt(amounts[0])}${period}`;
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return `${fmt(min)} – ${fmt(max)}${period}`;
}

function periodSuffix(s: string): string {
  if (/(per year|annually|annual|\/\s*yr|\/\s*year|\byr\b|\byear\b)/i.test(s)) return '/yr';
  if (/(per hour|hourly|\/\s*hr|\/\s*hour|\bhr\b|\bhour\b)/i.test(s)) return '/hr';
  if (/(per month|monthly|\/\s*mo|\/\s*month|\bmo\b|\bmonth\b)/i.test(s)) return '/mo';
  return '';
}

// A dollar amount, optionally with a K suffix: $120,000 / $120k / $ 120.5K.
// No whitespace before the K so a trailing space isn't swallowed into the match.
const MONEY = String.raw`\$\s*[\d,]+(?:\.\d+)?[kK]?`;
// A trailing period phrase (/yr, per hour, annually, …) to keep with the amount.
const PERIOD = String.raw`(?:\s*(?:\/\s*|per\s+)?(?:yr|year|annum|annually|hour|hr|month|mo))?`;
const RANGE_RE = new RegExp(`${MONEY}\\s*(?:-|–|—|to)\\s*${MONEY}${PERIOD}`, 'i');
const PAY_KEYWORD_RE =
  /(salary|compensation|base pay|base salary|pay range|salary range|pay:|comp\b|expected pay)/gi;
const MONEY_PERIOD_RE = new RegExp(`${MONEY}${PERIOD}`, 'i');

/**
 * Pull a salary out of free-text prose (a job description). Salary is often not
 * a dedicated field — it sits in the middle or end of the description. To avoid
 * mistaking unrelated figures ("$5M ARR", "$1B valuation") for pay, only two
 * shapes are trusted: an explicit money *range* (a strong pay signal on its
 * own), or a single amount that sits right after a pay keyword. Returns the raw
 * matched snippet (caller normalizes it) or null.
 */
export function extractSalaryFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ');

  const range = s.match(RANGE_RE);
  if (range) return range[0].trim();

  PAY_KEYWORD_RE.lastIndex = 0;
  let kw: RegExpExecArray | null;
  while ((kw = PAY_KEYWORD_RE.exec(s)) !== null) {
    // Look just ahead of the keyword (where the figure usually follows it).
    const window = s.slice(kw.index, kw.index + 80);
    const amount = window.match(MONEY_PERIOD_RE);
    if (amount) return amount[0].trim();
  }
  return null;
}
