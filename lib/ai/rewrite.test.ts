import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  buildRewriteRequest,
  extractRewrite,
  REWRITE_OUTPUT_OVERRIDE,
  type RewriteInput,
} from './rewrite';
import { REWRITE_MODEL, REWRITE_MAX_TOKENS } from './models';
import { makeTextMessage } from './mock-message';

const INPUT: RewriteInput = {
  systemPrompt: 'TAILORING RULES: minimal touch. Never invent. SOT embedded here.',
  resumeLatex: '\\documentclass{article}\\begin{document}Resume\\end{document}',
  jobDescription: 'Forward Deployed Engineer. High-throughput systems.',
};

describe('buildRewriteRequest', () => {
  it('routes to Sonnet with a generous budget', () => {
    const req = buildRewriteRequest(INPUT);
    expect(req.model).toBe(REWRITE_MODEL);
    expect(req.max_tokens).toBe(REWRITE_MAX_TOKENS);
  });

  it('uses the provided rules as the system prompt and appends the output override', () => {
    const system = buildRewriteRequest(INPUT).system as Anthropic.TextBlockParam[];
    expect(system[0].text).toContain(INPUT.systemPrompt);
    expect(system[0].text).toContain(REWRITE_OUTPUT_OVERRIDE);
    expect(system[0].text).toContain('OUTPUT FORMAT (OVERRIDE');
  });

  it('caches the base resume prefix and puts the job after the breakpoint', () => {
    const req = buildRewriteRequest(INPUT);
    const system = req.system as Anthropic.TextBlockParam[];
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].text).toContain(INPUT.resumeLatex);
    expect(req.messages[0].content).toContain(INPUT.jobDescription);
  });
});

describe('extractRewrite', () => {
  it('returns the LaTeX, not truncated, on a normal stop', () => {
    const r = extractRewrite(makeTextMessage('\\documentclass{article}...\\end{document}'));
    expect(r.truncated).toBe(false);
    expect(r.latex).toContain('\\documentclass');
  });

  it('strips stray markdown fences', () => {
    const r = extractRewrite(makeTextMessage('```latex\n\\documentclass{article}\\end{document}\n```'));
    expect(r.latex).toBe('\\documentclass{article}\\end{document}');
  });

  it('trims anything after \\end{document} (e.g. a chat report that slipped through)', () => {
    const r = extractRewrite(
      makeTextMessage('\\documentclass{article}\\end{document}\n\n---CHAT_REPORT---\nRole type: AI'),
    );
    expect(r.latex).toBe('\\documentclass{article}\\end{document}');
    expect(r.latex).not.toContain('CHAT_REPORT');
  });

  it('flags truncation at max_tokens', () => {
    expect(extractRewrite(makeTextMessage('\\documentclass{art', 'max_tokens')).truncated).toBe(true);
  });
});
// Rewrite telemetry rows land through the metering seam in the /api/rewrite
// route — see the streaming cases in telemetry.test.ts.
