import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  buildSalaryRequest,
  parseSalaryResponse,
  lookupSalary,
  type SalaryInput,
} from './salary';
import { SALARY_MODEL, SALARY_MAX_TOKENS } from './models';
import { makeTextMessage } from './mock-message';

const INPUT: SalaryInput = {
  title: 'AI Engineer',
  company: 'Stripe',
  location: 'New York, NY',
};

describe('buildSalaryRequest', () => {
  it('routes to the salary model with its token budget', () => {
    const req = buildSalaryRequest(INPUT);
    expect(req.model).toBe(SALARY_MODEL);
    expect(req.max_tokens).toBe(SALARY_MAX_TOKENS);
  });

  it('enables the web search tool', () => {
    const tools = (buildSalaryRequest(INPUT).tools ?? []) as Array<{ type: string; name: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('web_search_20250305');
    expect(tools[0].name).toBe('web_search');
  });

  it('includes the role, company, and location in the user message', () => {
    const content = buildSalaryRequest(INPUT).messages[0].content as string;
    expect(content).toContain('AI Engineer');
    expect(content).toContain('Stripe');
    expect(content).toContain('New York, NY');
  });

  it('omits the location clause when absent', () => {
    const content = buildSalaryRequest({ ...INPUT, location: null }).messages[0]
      .content as string;
    expect(content).not.toContain(' in ');
  });
});

describe('parseSalaryResponse', () => {
  it('returns the salary when found', () => {
    const msg = makeTextMessage('{"found": true, "salary": "$120,000 - $150,000/yr"}');
    expect(parseSalaryResponse(msg)).toEqual({ salary: '$120,000 - $150,000/yr', found: true });
  });

  it('returns not-found when the model reports none', () => {
    expect(parseSalaryResponse(makeTextMessage('{"found": false, "salary": null}'))).toEqual({
      salary: null,
      found: false,
    });
  });

  it('treats found:true with an empty salary as not found', () => {
    expect(parseSalaryResponse(makeTextMessage('{"found": true, "salary": ""}'))).toEqual({
      salary: null,
      found: false,
    });
  });

  it('treats a truncated or paused response as not found rather than throwing', () => {
    expect(parseSalaryResponse(makeTextMessage('{"found": true', 'max_tokens'))).toEqual({
      salary: null,
      found: false,
    });
    expect(
      parseSalaryResponse(makeTextMessage('searching...', 'pause_turn' as never)),
    ).toEqual({ salary: null, found: false });
  });

  it('treats unparseable output as not found', () => {
    expect(parseSalaryResponse(makeTextMessage('I could not find anything.'))).toEqual({
      salary: null,
      found: false,
    });
  });
});

describe('lookupSalary', () => {
  // Telemetry rows are the metering seam's job — see telemetry.test.ts.
  it('calls the injected client and parses its response', async () => {
    const create = vi.fn().mockResolvedValue(
      makeTextMessage('{"found": true, "salary": "$130k/yr"}'),
    );
    const client = { messages: { create } } as unknown as Anthropic;
    const result = await lookupSalary(client, INPUT);
    expect(create).toHaveBeenCalledWith(buildSalaryRequest(INPUT));
    expect(result).toEqual({ salary: '$130k/yr', found: true });
  });
});
