/**
 * Server-only resolver for the Ollama endpoint (OLLAMA_BASE_URL in
 * .env.local). Every Ollama call site goes through getOllamaBaseUrl() — the
 * address is resolved in exactly this one place, so pointing the app at a
 * remote Ollama (another machine, or the Docker host) is a single env var.
 */

/** The default local endpoint: 127.0.0.1, not localhost — Windows may resolve
 *  localhost to ::1, which Ollama does not listen on by default. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/**
 * The Ollama base URL: OLLAMA_BASE_URL when set (trimmed, trailing slashes
 * dropped so callers can append `/api/...` paths), else the local default.
 */
export function getOllamaBaseUrl(): string {
  const raw = process.env.OLLAMA_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : DEFAULT_OLLAMA_BASE_URL;
}
