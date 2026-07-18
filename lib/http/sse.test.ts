import { describe, it, expect } from 'vitest';
import { createSseResponse } from './sse';

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

describe('createSseResponse', () => {
  it('sets the event-stream content type', () => {
    const res = createSseResponse(async () => {});
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  });

  it('emits each sent value as a data: event', async () => {
    const res = createSseResponse(async (sink) => {
      sink.send({ type: 'score', jobId: 1, score: 80 });
      sink.send({ type: 'done' });
    });
    const body = await readAll(res);
    expect(body).toContain('data: {"type":"score","jobId":1,"score":80}\n\n');
    expect(body).toContain('data: {"type":"done"}\n\n');
  });

  it('delivers a handler error as a final error event', async () => {
    const res = createSseResponse(async () => {
      throw new Error('boom');
    });
    const body = await readAll(res);
    expect(body).toContain('"type":"error"');
    expect(body).toContain('boom');
  });

  it('swallows an enqueue failure (consumer gone) instead of throwing into the handler', async () => {
    let threw = false;
    const res = createSseResponse(async (sink) => {
      // Stay alive across a tick so the test can cancel the consumer first.
      await new Promise((r) => setTimeout(r, 5));
      // The consumer is gone; enqueue on a cancelled controller throws — the
      // sink must swallow it rather than let it propagate into the handler.
      try {
        sink.send({ type: 'token', text: 'after-cancel' });
      } catch {
        threw = true;
      }
    });
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 15));
    expect(threw).toBe(false);
  });

  it('runs the registered onCancel cleanup when the consumer cancels', async () => {
    let cleaned = false;
    const res = createSseResponse(
      (sink) =>
        new Promise<void>((resolve) => {
          sink.onCancel(() => {
            cleaned = true;
            resolve();
          });
        }),
    );
    await res.body!.cancel();
    expect(cleaned).toBe(true);
  });
});
