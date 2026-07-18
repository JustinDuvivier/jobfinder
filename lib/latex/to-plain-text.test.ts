import { describe, it, expect } from 'vitest';
import { latexToPlainText } from './to-plain-text';

describe('latexToPlainText', () => {
  it('extracts the document body and drops the preamble', () => {
    const latex = [
      '\\documentclass[11pt]{article}',
      '\\usepackage[margin=1in]{geometry}',
      '\\begin{document}',
      '\\section*{Experience}',
      'Built systems at scale.',
      '\\end{document}',
    ].join('\n');
    const text = latexToPlainText(latex);
    expect(text).toContain('Experience');
    expect(text).toContain('Built systems at scale.');
    expect(text).not.toContain('documentclass');
    expect(text).not.toContain('usepackage');
    expect(text).not.toContain('geometry');
  });

  it('keeps text inside formatting commands', () => {
    expect(latexToPlainText('\\textbf{Alex} \\emph{Candidate}')).toBe('Alex Candidate');
  });

  it('unwraps nested commands', () => {
    expect(latexToPlainText('\\textbf{\\underline{Senior} Engineer}')).toBe('Senior Engineer');
  });

  it('keeps hyperlink visible text, drops the URL', () => {
    expect(latexToPlainText('See \\href{https://example.com}{my portfolio}.')).toBe(
      'See my portfolio.',
    );
  });

  it('turns list items into bullets', () => {
    const latex = '\\begin{itemize}\\item First\\item Second\\end{itemize}';
    const text = latexToPlainText(latex);
    expect(text).toContain('- First');
    expect(text).toContain('- Second');
  });

  it('strips comments', () => {
    expect(latexToPlainText('Real text % this is a comment')).toBe('Real text');
  });

  it('keeps escaped specials as their literal characters', () => {
    expect(latexToPlainText('R\\&D budget grew 50\\%')).toBe('R&D budget grew 50%');
  });

  it('converts explicit line breaks to newlines', () => {
    expect(latexToPlainText('Line one \\\\ Line two')).toBe('Line one\nLine two');
  });

  it('leaves no LaTeX commands or braces in the output', () => {
    const latex =
      '\\documentclass{article}\\begin{document}\\section{Skills}\\textbf{TypeScript}, Python.\\end{document}';
    const text = latexToPlainText(latex);
    expect(text).not.toMatch(/\\[a-zA-Z]/); // no commands
    expect(text).not.toMatch(/[{}]/); // no braces
    expect(text).toContain('Skills');
    expect(text).toContain('TypeScript, Python.');
  });

  it('handles a snippet with no document environment', () => {
    expect(latexToPlainText('Just \\textbf{plain} text')).toBe('Just plain text');
  });
});
