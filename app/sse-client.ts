/**
 * Browser helper to consume a POST Server-Sent-Events stream. EventSource only
 * supports GET, and these routes are POST, so we read the response body stream
 * and parse `data:` events manually.
 */
export async function postSse(
  url: string,
  body: unknown,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const message = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((message as { error?: string }).error ?? 'Request failed');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) onEvent(JSON.parse(dataLine.slice(6)));
    }
  }
}

/** Send JSON and return the parsed response, throwing on a non-2xx with its error. */
async function requestJson<T>(method: 'POST' | 'PUT' | 'DELETE', url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Request failed');
  return data as T;
}

export function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  return requestJson<T>('POST', url, body);
}

export function putJson<T = unknown>(url: string, body: unknown): Promise<T> {
  return requestJson<T>('PUT', url, body);
}

export function deleteJson<T = unknown>(url: string, body: unknown): Promise<T> {
  return requestJson<T>('DELETE', url, body);
}
