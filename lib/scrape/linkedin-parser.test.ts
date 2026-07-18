import { describe, it, expect } from 'vitest';
import {
  parseJobCards,
  extractJobId,
  parseJobDetail,
  htmlToStructuredText,
} from './linkedin-parser';

describe('extractJobId', () => {
  it('reads the id from an entity URN', () => {
    expect(extractJobId('urn:li:jobPosting:4012345678', undefined)).toBe('4012345678');
  });

  it('falls back to the trailing id in a view href', () => {
    expect(
      extractJobId(undefined, 'https://www.linkedin.com/jobs/view/ai-engineer-at-stripe-4012345678?refId=x'),
    ).toBe('4012345678');
  });

  it('returns undefined when neither source has an id', () => {
    expect(extractJobId(undefined, 'https://www.linkedin.com/jobs/view/mystery-role')).toBeUndefined();
    expect(extractJobId(undefined, undefined)).toBeUndefined();
  });

  it('prefers the URN over the href', () => {
    expect(
      extractJobId('urn:li:jobPosting:111111', 'https://www.linkedin.com/jobs/view/x-222222'),
    ).toBe('111111');
  });
});

describe('parseJobCards', () => {
  const html = `
    <li>
      <div class="base-card" data-entity-urn="urn:li:jobPosting:999000111">
        <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/role-999000111?x=1"></a>
        <h3 class="base-search-card__title">ML Engineer</h3>
        <h4 class="base-search-card__subtitle"><a>Acme</a></h4>
        <span class="job-search-card__location">New York, NY</span>
        <time class="job-search-card__listdate" datetime="2026-06-18"></time>
      </div>
    </li>
    <li class="see-more-jobs"><button>See more</button></li>
  `;

  it('extracts one RawJob per real card and skips non-cards', () => {
    const jobs = parseJobCards(html);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      jobId: '999000111',
      title: 'ML Engineer',
      company: 'Acme',
      location: 'New York, NY',
      postedAt: '2026-06-18',
      url: 'https://www.linkedin.com/jobs/view/role-999000111',
    });
  });

  it('yields partial RawJobs for cards missing required fields (dropped downstream)', () => {
    const partial = `
      <li>
        <div class="base-card" data-entity-urn="urn:li:jobPosting:4012999001">
          <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/untitled-4012999001"></a>
          <h4 class="base-search-card__subtitle">Mystery Co</h4>
        </div>
      </li>
    `;
    const jobs = parseJobCards(partial);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe('4012999001');
    expect(jobs[0].title).toBeUndefined();
  });

  it('strips the query string from the view URL', () => {
    const jobs = parseJobCards(html);
    expect(jobs[0].url).not.toContain('?');
  });

  it('returns an empty array for HTML with no cards', () => {
    expect(parseJobCards('<li class="see-more-jobs"><button>x</button></li>')).toEqual([]);
  });
});

describe('htmlToStructuredText', () => {
  it('turns <br> into line breaks and </p> into paragraph breaks', () => {
    expect(htmlToStructuredText('<p>One line.<br>Two line.</p><p>New paragraph.</p>')).toBe(
      'One line.\nTwo line.\n\nNew paragraph.',
    );
  });

  it('turns <li> items into "- " bullets', () => {
    expect(htmlToStructuredText('<p>Requirements:</p><ul><li>Python</li><li>SQL</li></ul>')).toBe(
      'Requirements:\n\n- Python\n- SQL',
    );
  });

  it('keeps inline tag text and decodes entities', () => {
    expect(htmlToStructuredText('<strong>Pay &amp; Perks</strong><br>401(k) &gt; nothing')).toBe(
      'Pay & Perks\n401(k) > nothing',
    );
  });

  it('collapses runs of blank lines and per-line whitespace', () => {
    expect(htmlToStructuredText('<p>a</p><p></p><p>  b   c </p>')).toBe('a\n\nb c');
  });

  it('returns an empty string for empty or tag-only input', () => {
    expect(htmlToStructuredText('')).toBe('');
    expect(htmlToStructuredText('<p> </p>')).toBe('');
  });
});

describe('parseJobDetail', () => {
  it('extracts the description with structure preserved', () => {
    const html =
      '<div class="description__text"><div class="show-more-less-html__markup">' +
      '<strong>About Us<br><br></strong>We build ML systems.<br><br>' +
      '<strong>You will</strong><ul><li>Ship models</li><li>Own pipelines</li></ul>' +
      '</div><button>Show more</button></div>';
    expect(parseJobDetail(html).description).toBe(
      'About Us\n\nWe build ML systems.\n\nYou will\n- Ship models\n- Own pipelines',
    );
  });

  it('prefers the markup div and excludes Show more/less button labels', () => {
    const html =
      '<div class="description__text"><div class="show-more-less-html__markup">Real text.</div>' +
      '<button class="show-more-less-html__button">Show more</button></div>';
    expect(parseJobDetail(html).description).toBe('Real text.');
  });

  it('falls back to .description__text when the markup div is absent', () => {
    const html = '<div class="description__text">Plain description.</div>';
    expect(parseJobDetail(html).description).toBe('Plain description.');
  });

  it('extracts a salary from the dedicated block when present', () => {
    const html = '<div class="salary compensation__salary"> $135,000.00/yr - $175,000.00/yr </div>';
    expect(parseJobDetail(html).salary).toBe('$135,000.00/yr - $175,000.00/yr');
  });

  it('extracts the four job-criteria fields', () => {
    const html = `
      <ul>
        <li class="description__job-criteria-item">
          <h3 class="description__job-criteria-subheader">Seniority level</h3>
          <span class="description__job-criteria-text">Entry level</span>
        </li>
        <li class="description__job-criteria-item">
          <h3 class="description__job-criteria-subheader">Employment type</h3>
          <span class="description__job-criteria-text">Full-time</span>
        </li>
        <li class="description__job-criteria-item">
          <h3 class="description__job-criteria-subheader">Job function</h3>
          <span class="description__job-criteria-text">Engineering and Information Technology</span>
        </li>
        <li class="description__job-criteria-item">
          <h3 class="description__job-criteria-subheader">Industries</h3>
          <span class="description__job-criteria-text">Software Development</span>
        </li>
      </ul>`;
    expect(parseJobDetail(html)).toEqual({
      seniorityLevel: 'Entry level',
      employmentType: 'Full-time',
      jobFunction: 'Engineering and Information Technology',
      industries: 'Software Development',
    });
  });

  it('ignores unknown criteria subheaders', () => {
    const html = `
      <li class="description__job-criteria-item">
        <h3 class="description__job-criteria-subheader">Referrals</h3>
        <span class="description__job-criteria-text">increase your chances</span>
      </li>`;
    expect(parseJobDetail(html)).toEqual({});
  });

  it('extracts the applicant caption', () => {
    const html = '<span class="num-applicants__caption">Over 200 applicants</span>';
    expect(parseJobDetail(html).applicants).toBe('Over 200 applicants');
  });

  it('omits fields that are absent', () => {
    expect(parseJobDetail('<div>nothing useful</div>')).toEqual({});
  });
});
