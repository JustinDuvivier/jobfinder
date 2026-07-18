/**
 * Server-only accessor for the RapidAPI aggregator key (RAPID_API_KEY in
 * .env.local). The value is read server-side ONLY and never crosses to the
 * client — callers expose at most a boolean "is it present" (hasRapidApiKey),
 * honoring the "API keys stay server-side" security rule. Ticket 04 gates
 * Greenhouse scraping on greenhouseEnabled && hasRapidApiKey().
 */

/** The trimmed RapidAPI key, or undefined when unset/blank. Server-side only. */
export function getRapidApiKey(): string | undefined {
  return process.env.RAPID_API_KEY?.trim() || undefined;
}

/** True iff a non-empty RapidAPI key is configured. */
export function hasRapidApiKey(): boolean {
  return getRapidApiKey() !== undefined;
}
