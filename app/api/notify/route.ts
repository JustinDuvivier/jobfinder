/**
 * POST /api/notify — fire a native desktop notification via the shared
 * lib/notify notifier (which shells out to scripts/notify.py). The browser
 * triggers this when a job is found / a strong match scores.
 *
 * Body: { title?: string, body?: string }.
 *
 * Security: the notifier builds the script path server-side and passes the
 * title/body as separate argv entries to a no-shell spawn, so their contents
 * can never inject a command. Bound to 127.0.0.1 like the rest of the app.
 */
import { fireNotifier } from '@/lib/notify/notifier';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const title = typeof body?.title === 'string' ? body.title.slice(0, 200) : 'JobFinder';
  const message = typeof body?.body === 'string' ? body.body.slice(0, 500) : '';
  try {
    fireNotifier(title, message);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
