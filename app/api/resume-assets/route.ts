/**
 * GET/PUT/DELETE /api/resume-assets — in-app authoring of the four resume
 * assets (FR-33). GET returns each asset's effective content plus provenance
 * ('in-app' | 'file' | 'example'). PUT saves one asset to the resume_assets
 * table — for the base resume only after a sandboxed compile proves it builds
 * an exactly-one-page PDF (the FR-17 invariant, applied at authoring time).
 * DELETE reverts one asset to its file/example fallback and returns the
 * now-effective content so the editor can refill.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { resolveResumeAssets } from '@/lib/resume/load';
import { compileLatex, LatexCompileError } from '@/lib/latex/compile';
import { RESUME_ASSET_NAMES } from '@/lib/types';
import type { ResumeAssetName } from '@/lib/types';

export const runtime = 'nodejs';

function isAssetName(value: unknown): value is ResumeAssetName {
  return typeof value === 'string' && (RESUME_ASSET_NAMES as readonly string[]).includes(value);
}

type NameGuard = { ok: true; name: ResumeAssetName; body: Record<string, unknown> } | { ok: false; response: Response };

/** Parse the JSON body and require a valid asset `name` (400 otherwise). */
async function requireAssetName(req: Request): Promise<NameGuard> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !isAssetName(body.name)) {
    return {
      ok: false,
      response: Response.json(
        { error: `Invalid asset "name" — expected one of: ${RESUME_ASSET_NAMES.join(', ')}` },
        { status: 400 },
      ),
    };
  }
  return { ok: true, name: body.name, body };
}

export async function GET(): Promise<Response> {
  try {
    return Response.json({ assets: resolveResumeAssets(getDb()) });
  } catch (err) {
    // An asset is missing from every layer — a broken checkout.
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function PUT(req: Request): Promise<Response> {
  const guard = await requireAssetName(req);
  if (!guard.ok) return guard.response;
  const { name, body } = guard;

  const content = body.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return Response.json({ error: 'Missing "content" string' }, { status: 400 });
  }

  // The one-page invariant, enforced where the base resume is authored: it
  // must compile in the sandbox and produce exactly one page (FR-17/FR-33).
  if (name === 'base_resume') {
    try {
      const { pageCount } = await compileLatex(content);
      if (pageCount !== 1) {
        return Response.json(
          { error: `The resume compiles to ${pageCount} pages — it must be exactly one page.` },
          { status: 422 },
        );
      }
    } catch (err) {
      if (err instanceof LatexCompileError) {
        return Response.json(
          { error: 'The resume failed to compile', log: err.log },
          { status: 422 },
        );
      }
      return Response.json({ error: 'Compile failed' }, { status: 500 });
    }
  }

  repo.setResumeAsset(getDb(), name, content);
  return Response.json({ ok: true, asset: { content, provenance: 'in-app' } });
}

export async function DELETE(req: Request): Promise<Response> {
  const guard = await requireAssetName(req);
  if (!guard.ok) return guard.response;

  const db = getDb();
  repo.deleteResumeAsset(db, guard.name);
  try {
    return Response.json({ ok: true, asset: resolveResumeAssets(db)[guard.name] });
  } catch (err) {
    // Reverted, but no file/example fallback exists for this asset.
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
