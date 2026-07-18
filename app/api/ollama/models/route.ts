/**
 * GET/POST /api/ollama/models — model status and in-app download for the
 * Settings scoring selector (FR-6b).
 *
 * GET returns installed status against the connected Ollama for every curated
 * tag plus the stored custom tag (user_config.ollama_model, when it is not
 * curated), and the active pull's progress record. The client polls this
 * (start-then-poll refetch — SSE stays reserved for scrape/score/rewrite).
 * An unreachable Ollama is a 200 with `reachable: false` and the error
 * message, so a down daemon never blocks the rest of Settings.
 *
 * POST {tag} starts a server-side `ollama pull`. Only a curated tag or the
 * stored custom tag is accepted (after a format check) — the client cannot
 * make this server download arbitrary strings. 409 while a pull is running.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { CURATED_OLLAMA_MODELS } from '@/lib/ai/models';
import { getPullManager, isOllamaModelInstalled, OLLAMA_TAG_PATTERN } from '@/lib/ai/ollama-pull';

export const runtime = 'nodejs';

/** The tags this route reports on and accepts: curated + the stored custom tag. */
function knownTags(): string[] {
  const tags: string[] = CURATED_OLLAMA_MODELS.map((m) => m.tag);
  const stored = repo.getUserConfig(getDb())?.ollamaModel;
  if (stored && !tags.includes(stored)) tags.push(stored);
  return tags;
}

export async function GET(): Promise<Response> {
  const pulling = getPullManager().snapshot();
  try {
    const models = await Promise.all(
      knownTags().map(async (tag) => ({ tag, installed: await isOllamaModelInstalled(tag) })),
    );
    return Response.json({ reachable: true, models, pulling });
  } catch (err) {
    return Response.json({ reachable: false, error: (err as Error).message, models: [], pulling });
  }
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const tag = typeof body?.tag === 'string' ? body.tag.trim() : '';
  if (!tag || !OLLAMA_TAG_PATTERN.test(tag)) {
    return Response.json({ error: 'Missing or malformed "tag"' }, { status: 400 });
  }
  if (!knownTags().includes(tag)) {
    return Response.json(
      { error: 'Unknown model tag — pick a curated model, or save it as the custom tag first.' },
      { status: 400 },
    );
  }
  const result = getPullManager().start(tag);
  if (!result.started) {
    return Response.json({ error: result.error }, { status: 409 });
  }
  return Response.json({ ok: true, tag }, { status: 202 });
}
