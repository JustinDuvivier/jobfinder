import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  buildExplainRequest,
  formatChangesForPrompt,
  parseExplainResponse,
  explainChanges,
  type ExplainInput,
} from './explain';
import { EXPLAIN_MODEL, EXPLAIN_MAX_TOKENS } from './models';
import { computeLatexDiff, hasEdits } from '../diff';
import { makeTextMessage } from './mock-message';

const INPUT: ExplainInput = {
  changes: [
    { blockType: 'equal', content: 'Led migration ', seq: 0 },
    { blockType: 'delete', content: 'of services', seq: 1 },
    { blockType: 'insert', content: 'of 40 services to Kubernetes', seq: 2 },
  ],
  jobDescription: 'ML Engineer. Distributed training.',
};

describe('formatChangesForPrompt', () => {
  it('marks deletions and insertions inline and keeps unchanged text as flowing context', () => {
    expect(formatChangesForPrompt(INPUT.changes)).toBe(
      'Led migration <removed>of services</removed><added>of 40 services to Kubernetes</added>',
    );
  });

  it('elides the middle of long equal runs but never touches insert/delete content', () => {
    const long = 'x'.repeat(1000);
    const formatted = formatChangesForPrompt([
      { blockType: 'equal', content: long, seq: 0 },
      { blockType: 'insert', content: 'y'.repeat(1000), seq: 1 },
    ]);
    expect(formatted).toContain('[…]');
    expect(formatted).not.toContain(long);
    expect(formatted).toContain(`<added>${'y'.repeat(1000)}</added>`);
  });
});

describe('buildExplainRequest', () => {
  it('routes to the Sonnet explain model with the explain budget', () => {
    const req = buildExplainRequest(INPUT);
    expect(req.model).toBe(EXPLAIN_MODEL);
    expect(req.max_tokens).toBe(EXPLAIN_MAX_TOKENS);
  });

  it('passes the formatted change log and the job description so edits can be justified', () => {
    const content = buildExplainRequest(INPUT).messages[0].content as string;
    expect(content).toContain(formatChangesForPrompt(INPUT.changes));
    expect(content).toContain(INPUT.jobDescription);
  });

  it('a markup-only edit (bolding a metric) produces a non-empty change signal', () => {
    // The diff is over LaTeX source, so bolding alone is a recorded edit —
    // and because the explainer reads the diff blocks, it sees that edit too.
    // (The old plain-text input unwrapped \textbf{X} to X, erasing it.)
    const original = 'Cut p99 latency by 40% across services.';
    const rewritten = 'Cut p99 latency by \\textbf{40%} across services.';
    const changes = computeLatexDiff(original, rewritten);
    expect(hasEdits(changes)).toBe(true);

    const content = buildExplainRequest({ changes, jobDescription: 'j' })
      .messages[0].content as string;
    expect(content).toContain('<added>');
    expect(content).toContain('\\textbf{');
  });
});

describe('parseExplainResponse', () => {
  it('parses a valid response', () => {
    const result = parseExplainResponse(
      makeTextMessage('{"summary": "Tailored to the role.", "bullets": ["Surfaced p99 metric."]}'),
    );
    expect(result.summary).toBe('Tailored to the role.');
    expect(result.bullets).toEqual(['Surfaced p99 metric.']);
  });

  it('drops empty bullets', () => {
    const result = parseExplainResponse(
      makeTextMessage('{"summary": "x", "bullets": ["keep", "  ", ""]}'),
    );
    expect(result.bullets).toEqual(['keep']);
  });

  it('throws on a missing summary', () => {
    expect(() => parseExplainResponse(makeTextMessage('{"bullets": []}'))).toThrow(/summary/);
  });

  it('throws when bullets is not an array of strings', () => {
    expect(() =>
      parseExplainResponse(makeTextMessage('{"summary": "x", "bullets": "nope"}')),
    ).toThrow(/bullets/);
  });

  it('treats truncation as an error', () => {
    expect(() =>
      parseExplainResponse(makeTextMessage('{"summary": "x", "bullets": ["a', 'max_tokens')),
    ).toThrow(/truncated/);
  });
});

describe('explainChanges', () => {
  // Telemetry rows are the metering seam's job — see telemetry.test.ts.
  it('calls the client with the built request and returns the parsed result', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(makeTextMessage('{"summary": "s", "bullets": ["b"]}'));
    const client = { messages: { create } } as unknown as Anthropic;

    const result = await explainChanges(client, INPUT);

    expect(create).toHaveBeenCalledWith(buildExplainRequest(INPUT));
    expect(result).toEqual({ summary: 's', bullets: ['b'] });
  });
});
