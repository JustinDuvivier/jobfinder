/**
 * POST /api/compile — preview compile. Receives LaTeX, returns the PDF bytes
 * plus the page count (in headers) so the editor can render a preview and flag a
 * spill onto a second page. Nothing is written to disk; no database state is
 * touched. The compile is sandboxed and cache-checked inside compileLatex.
 *
 * See jobfinder-docs.md "Two compile operations".
 */
import { compileLatex, LatexCompileError } from '@/lib/latex/compile';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  let latex: unknown;
  try {
    latex = (await req.json())?.latex;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof latex !== 'string' || latex.trim().length === 0) {
    return Response.json({ error: 'Missing "latex" string' }, { status: 400 });
  }

  try {
    const { pdf, pageCount, hash } = await compileLatex(latex);
    return new Response(Buffer.from(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'X-Page-Count': String(pageCount),
        'X-Latex-Hash': hash,
      },
    });
  } catch (err) {
    if (err instanceof LatexCompileError) {
      return Response.json({ error: 'LaTeX failed to compile', log: err.log }, { status: 400 });
    }
    return Response.json({ error: 'Compile failed' }, { status: 500 });
  }
}
