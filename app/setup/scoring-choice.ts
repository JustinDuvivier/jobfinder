/**
 * Pure mapping between the Settings scoring dropdown (FR-6b) and the two
 * persisted config fields (`scoring_backend` + `ollama_model`), plus the
 * download-progress formatter. The dropdown is presentation only — the config
 * schema is unchanged and every existing install maps onto it losslessly:
 * anthropic → the Claude option (its stored tag is preserved for switching
 * back), ollama + a curated tag → that option, ollama + any other tag → the
 * custom option with the tag in the revealed input.
 */
import { CURATED_OLLAMA_MODELS, DEFAULT_OLLAMA_MODEL, type CuratedOllamaTag } from '@/lib/ai/models';
import type { ScoringBackendName } from '@/lib/types';
import type { PullProgress } from '@/lib/ai/ollama-pull';

/** A dropdown value: one curated tag, the Claude backend, or the custom escape hatch. */
export type ScoringChoice = CuratedOllamaTag | 'anthropic' | 'custom';

/** The client's view of GET /api/ollama/models: per-tag installed status
 *  (curated + stored custom tag), reachability, and the active pull. */
export interface OllamaModelsStatus {
  reachable: boolean;
  error?: string;
  models: { tag: string; installed: boolean }[];
  pulling: PullProgress | null;
}

/** The two config fields the dropdown reads and writes. */
export interface ScoringConfig {
  scoringBackend: ScoringBackendName;
  ollamaModel: string;
}

function isCuratedTag(tag: string): tag is CuratedOllamaTag {
  return CURATED_OLLAMA_MODELS.some((m) => m.tag === tag);
}

/** Which dropdown option a stored config lands on. */
export function choiceFromConfig(config: ScoringConfig): ScoringChoice {
  if (config.scoringBackend === 'anthropic') return 'anthropic';
  return isCuratedTag(config.ollamaModel) ? config.ollamaModel : 'custom';
}

/**
 * The config a dropdown selection persists. `ollamaModel` is the form's tag
 * field: the custom option saves it (trimmed, defaulting like the server
 * does), and the Claude option carries it through untouched so switching to
 * Claude and back never loses a custom tag.
 */
export function configFromChoice(choice: ScoringChoice, ollamaModel: string): ScoringConfig {
  if (choice === 'anthropic') return { scoringBackend: 'anthropic', ollamaModel };
  if (choice === 'custom') {
    return { scoringBackend: 'ollama', ollamaModel: ollamaModel.trim() || DEFAULT_OLLAMA_MODEL };
  }
  return { scoringBackend: 'ollama', ollamaModel: choice };
}

/** The Ollama tag a local dropdown selection scores with (null for Claude). */
export function localTagForChoice(choice: ScoringChoice, ollamaModel: string): string | null {
  if (choice === 'anthropic') return null;
  return choice === 'custom' ? ollamaModel.trim() : choice;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * One line of human-readable pull progress: byte counts with a percentage
 * while Ollama reports them, else its latest status text.
 */
export function formatPullProgress(pull: PullProgress): string {
  if (pull.completed !== null && pull.total !== null && pull.total > 0) {
    const pct = Math.min(100, Math.round((pull.completed / pull.total) * 100));
    return `${gigabytes(pull.completed)} / ${gigabytes(pull.total)} (${pct}%)`;
  }
  return pull.status;
}
