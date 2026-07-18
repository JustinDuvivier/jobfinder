/**
 * LaTeX → plain text for the scoring call (FR-7). Fit-scoring does not depend on
 * LaTeX markup (\textbf{}, list environments, braces) — that is pure token
 * overhead for a judgment task — so the resume is sent to Haiku as plain text,
 * not LaTeX source. The LaTeX is reserved for the rewrite, which edits it.
 *
 * This is a deterministic, best-effort stripper: it keeps human-readable content
 * (section headings, body text, list items) and discards markup. It does not aim
 * to be a full TeX interpreter — the scorer tolerates minor noise.
 *
 * See jobfinder-docs.md "Plain-text resume for scoring".
 */

/** Convert LaTeX source to readable plain text. */
export function latexToPlainText(latex: string): string {
  let s = latex;

  // 1. Use only the document body when present (drops the preamble).
  const body = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(s);
  if (body) s = body[1]!;

  // 2. Strip comments: an unescaped % to end of line.
  s = s.replace(/(^|[^\\])%.*$/gm, '$1');

  // 3. Remove environment markers (\begin{itemize}[opts], \begin{tabular}{ll}, \end{...}).
  s = s.replace(/\\(?:begin|end)\{[a-zA-Z*]+\}(?:\[[^\]]*\])?(?:\{[^}]*\})*/g, '');

  // 4. List items become bullets; explicit line breaks become newlines.
  s = s.replace(/\\item\s*/g, '\n- ');
  s = s.replace(/\\\\(?:\[[^\]]*\])?/g, '\n');
  s = s.replace(/\\newline\b/g, '\n');

  // 5. Hyperlinks keep their visible text.
  s = s.replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1');

  // 6. Commands that wrap an argument keep the argument (\textbf{X}, \section*{X}).
  //    Repeat to unwrap nesting from the inside out.
  const argCommand = /\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g;
  let previous: string;
  do {
    previous = s;
    s = s.replace(argCommand, '$1');
  } while (s !== previous);

  // 7. Remaining bare commands (and any leftover optional args) are dropped.
  s = s.replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, '');

  // 8. Unescape specials; non-breaking space becomes a space.
  s = s.replace(/\\([&%$#_{}])/g, '$1');
  s = s.replace(/~/g, ' ');

  // 9. Drop any leftover braces.
  s = s.replace(/[{}]/g, '');

  // 10. Normalize whitespace: collapse horizontal runs per line, trim, and
  //     collapse blank-line runs.
  s = s
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s;
}
