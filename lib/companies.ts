/**
 * Company-name normalization, shared by the scrape pipeline's blocklist filter
 * and the blocklist data-access layer so a name stored as blocked matches the
 * name checked during scraping: trim, collapse internal whitespace, lowercase.
 */
export function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
