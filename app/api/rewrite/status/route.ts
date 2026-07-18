/**
 * GET /api/rewrite/status — the cross-page status read. Returns the rewrite
 * registry's coarse per-job snapshot (running / done / truncated / error, with
 * company + title to render and link). Read-only, no body: the always-visible
 * app indicator polls this on a short interval. Coarse status is all the
 * cross-page indicator needs; the live token stream stays scoped to /api/rewrite
 * via subscribe.
 */
import { getRewriteRegistry } from '@/lib/rewrite/registry';

export const runtime = 'nodejs';

export function GET(): Response {
  return Response.json({ jobs: getRewriteRegistry().snapshot() });
}
