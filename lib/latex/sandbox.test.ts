import { describe, it, expect } from 'vitest';
import {
  buildPdflatexArgs,
  buildSandboxEnv,
  SOURCE_DATE_EPOCH,
} from './sandbox';

describe('buildPdflatexArgs — security hardening', () => {
  const args = buildPdflatexArgs('/tmp/out', 'resume.tex');

  it('disables shell escape', () => {
    expect(args).toContain('-no-shell-escape');
  });

  it('runs non-interactively and halts on error (no hangs)', () => {
    expect(args).toContain('-interaction=nonstopmode');
    expect(args).toContain('-halt-on-error');
  });

  it('directs output to the isolated directory', () => {
    expect(args).toContain('-output-directory=/tmp/out');
  });

  it('passes the tex file last and never an absolute client path', () => {
    expect(args[args.length - 1]).toBe('resume.tex');
  });
});

describe('buildSandboxEnv — file-access restriction and determinism', () => {
  it('sets paranoid file access (blocks \\input of arbitrary local files)', () => {
    const env = buildSandboxEnv({ PATH: '/usr/bin' });
    expect(env.openin_any).toBe('p');
    expect(env.openout_any).toBe('p');
  });

  it('fixes SOURCE_DATE_EPOCH for deterministic output bytes', () => {
    expect(buildSandboxEnv({}).SOURCE_DATE_EPOCH).toBe(SOURCE_DATE_EPOCH);
  });

  it('preserves the base environment (e.g. PATH) so pdflatex can run', () => {
    expect(buildSandboxEnv({ PATH: '/usr/bin' }).PATH).toBe('/usr/bin');
  });
});
