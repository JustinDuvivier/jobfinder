/**
 * Parser for LinkedIn's public guest job-search endpoint
 * (`seeMoreJobPostings/search`), which returns a chunk of job-card HTML — no
 * login, cookies, or browser. This maps each card to a loosely-typed RawJob;
 * the scrape pipeline's field parser then normalizes and drops incomplete ones.
 *
 * Parsing is plain `fetch` + `cheerio` (jQuery-style selectors). The selectors
 * target the stable class names LinkedIn uses on the logged-out cards:
 *   - data-entity-urn="urn:li:jobPosting:{id}"  → job id
 *   - a.base-card__full-link[href]              → view URL (and id fallback)
 *   - .base-search-card__title                  → title
 *   - .base-search-card__subtitle               → company
 *   - .job-search-card__location                → location
 *   - time[datetime]                            → posting date
 *
 * The detail endpoint (`jobPosting/{id}`) additionally carries LinkedIn's
 * structured "job criteria" block (seniority level, employment type, job
 * function, industries), an applicant-count caption, and — when the employer
 * disclosed it — a dedicated salary block. The description body is
 * employer-authored HTML from a limited tag set (p, br, ul/li, b/strong,
 * i/em, u); it is converted to plain text that keeps paragraph and bullet
 * structure so downstream AI calls see distinct sections, not one run-on line.
 *
 * See jobfinder-docs.md "Strategy B — LinkedIn Guest API" and "Endpoints and
 * searches"; PRD FR-1.
 */
import * as cheerio from 'cheerio';
import type { RawJob } from './pipeline';

/** Enrichment fetched from the job-detail endpoint for surviving jobs. */
export interface JobDetail {
  description?: string;
  salary?: string;
  seniorityLevel?: string;
  employmentType?: string;
  jobFunction?: string;
  industries?: string;
  /** Raw applicant caption, e.g. "Over 200 applicants". */
  applicants?: string;
}

/**
 * Extract the LinkedIn job id from an entity URN or a view href. The URN is the
 * authority — its id is the segment after the last colon
 * (urn:li:jobPosting:4012345678 → 4012345678). Falls back to the trailing id in
 * a view href when no URN is present.
 */
export function extractJobId(urn: string | undefined, href: string | undefined): string | undefined {
  const fromUrn = urn?.split(':').pop()?.trim();
  if (fromUrn) return fromUrn;
  // Hrefs look like .../jobs/view/ai-engineer-at-stripe-4012345678?refId=...
  const fromHref = href?.match(/-(\d{6,})(?:[/?]|$)/) ?? href?.match(/(\d{6,})/);
  return fromHref ? fromHref[1] : undefined;
}

function textOf($el: cheerio.Cheerio<any>): string | undefined {
  const t = $el.first().text().replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : undefined;
}

function stripQuery(href: string): string {
  return href.split('?')[0]!;
}

/**
 * Convert LinkedIn's limited description HTML to plain text that preserves the
 * visual structure: <br> and </p> become line/paragraph breaks and <li> items
 * become "- " bullets, while inline tags (strong/em/b/i/u) contribute only
 * their text. Cheerio then decodes entities and strips any remaining markup.
 * Blank-line runs collapse to a single blank line.
 */
export function htmlToStructuredText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<\/(p|h[1-6]|div|section)>/gi, '\n\n');
  const text = cheerio.load(withBreaks).root().text();
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse guest-API search HTML into RawJob records, one per job card. Cards with
 * no recognizable content are skipped here; cards missing required fields
 * (id/title/company) survive as partial RawJobs and are dropped downstream by
 * the field parser, so the "missing field → drop" decision lives in one place.
 */
export function parseJobCards(html: string): RawJob[] {
  const $ = cheerio.load(html);
  const jobs: RawJob[] = [];

  $('li').each((_, li) => {
    const $li = $(li);
    const urn =
      $li.find('[data-entity-urn]').attr('data-entity-urn') ??
      $li.attr('data-entity-urn') ??
      undefined;
    const href = $li.find('a.base-card__full-link').attr('href')?.trim();

    const title = textOf($li.find('.base-search-card__title'));
    const company = textOf($li.find('.base-search-card__subtitle'));

    // Skip list items that are not job cards at all.
    if (!urn && !href && !title && !company) return;

    const jobId = extractJobId(urn, href);
    const location = textOf($li.find('.job-search-card__location'));
    const postedAt = $li.find('time').attr('datetime')?.trim() || undefined;
    const url = href ? stripQuery(href) : undefined;

    jobs.push({ jobId, title, company, location, postedAt, url });
  });

  return jobs;
}

/** Criteria subheaders (lower-cased) → JobDetail fields. */
const CRITERIA_FIELDS: Readonly<Record<string, keyof JobDetail>> = {
  'seniority level': 'seniorityLevel',
  'employment type': 'employmentType',
  'job function': 'jobFunction',
  industries: 'industries',
};

/**
 * Parse the guest job-detail HTML (`jobPosting/{id}`) into the enrichment
 * fields the search cards lack: the structured description, the salary block
 * (when disclosed), the four job-criteria fields, and the applicant caption.
 * Fetched only for jobs that survive the blocklist and deduplicator, so the
 * detail request is never wasted on a job about to be discarded.
 */
export function parseJobDetail(html: string): JobDetail {
  const $ = cheerio.load(html);
  const detail: JobDetail = {};

  // Prefer the inner markup div: the .description__text ancestor also contains
  // the "Show more / Show less" button labels, which are not description text.
  const markup = $('.show-more-less-html__markup').first();
  const container = markup.length > 0 ? markup : $('.description__text').first();
  if (container.length > 0) {
    const description = htmlToStructuredText(container.html() ?? '');
    if (description) detail.description = description;
  }

  const salary = textOf($('.salary, .compensation__salary').first());
  if (salary) detail.salary = salary;

  const applicants = textOf($('.num-applicants__caption').first());
  if (applicants) detail.applicants = applicants;

  $('.description__job-criteria-item').each((_, item) => {
    const $item = $(item);
    const header = textOf($item.find('.description__job-criteria-subheader'))?.toLowerCase();
    const value = textOf($item.find('.description__job-criteria-text'));
    const field = header ? CRITERIA_FIELDS[header] : undefined;
    if (field && value) detail[field] = value;
  });

  return detail;
}
