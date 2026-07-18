/**
 * Server-Sent Events helper for the streaming routes (/api/scrape, /api/score,
 * /api/rewrite). Wraps a ReadableStream so a handler can `send(event)` JSON
 * objects and the route returns a proper text/event-stream response. Errors
 * thrown by the handler are delivered as a final `{type:'error'}` event.
 */
export interface SseSink {
  /** Emit one SSE `data:` event carrying a JSON-serializable value. */
  send(data: unknown): void;
  /** Register cleanup to run if the consumer disconnects (cancels the stream)
   *  before the handler finishes — e.g. to release a subscription. */
  onCancel(cleanup: () => void): void;
}

export function createSseResponse(run: (sink: SseSink) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let onCancel: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const enqueue = (data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The consumer went away mid-stream (its controller is closed); stop
          // writing rather than letting the throw propagate into the caller.
          closed = true;
        }
      };
      const sink: SseSink = { send: enqueue, onCancel: (cleanup) => (onCancel = cleanup) };

      run(sink)
        .catch((err: unknown) => {
          enqueue({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
    },
    // Fired when the consumer cancels (client disconnect). Let the handler
    // release whatever it registered — the durable generation lives on in the
    // registry regardless.
    cancel() {
      onCancel?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
