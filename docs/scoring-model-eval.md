# Scoring-model eval — selecting the default small Ollama model

**Date:** 2026-07-17
**Harness:** `scripts/eval-score-golden.mts` against `golden/score.golden.json` (12 cases, constraint-based grading — see `lib/ai/score.golden.test.ts`)
**Decision:** the default local scoring model (`DEFAULT_OLLAMA_MODEL`, FR-6) moves from the tuned 27B (`batiai/qwen3.6-27b:iq3`, an 11GB pull that needs a ~16GB GPU) to **`qwen3:4b-instruct-2507-q4_K_M`** — a ~2.5GB pull a CPU-only Docker user can actually run. The 27B remains the documented higher-accuracy override (below).

## Method

Every candidate ran the full golden case set through the eval harness with the app's exact local transport settings (`lib/ai/ollama.ts`): identical prompt assembly to the shipped scoring call, `temperature 0`, `think: false`, `num_ctx 16384`, `num_predict 1024`. Grading is the golden file's constraint checks on the **raw** reply (quote fidelity, literal years reads, gap arithmetic, cap-consistent scoring, reply shape) plus one **parsed-score** check per case — the score the app would actually persist after its deterministic corrections (quote re-derive, gap cap, FR-6a park). Recall-critical cases grade an underscore as the costliest failure (a genuine match hidden behind the FR-9a threshold); an overscore anywhere is only queue noise.

## Results

Reference machine: 16GB GPU (CPU-only will be slower per job; quality numbers are decoding-deterministic at temperature 0 and transfer).

| Model | Pull | ~RAM to run* | Clean cases | Checks | Recall misses | Overscores | Persisted-score misses | Avg s/job |
|---|---|---|---|---|---|---|---|---|
| **qwen3:4b-instruct-2507-q4_K_M** (winner) | 2.5 GB | ~5 GB | **3/12** | **134/158** | **0** | **0** | **0/12** | 2.4 |
| gemma3:4b | 3.3 GB | ~6 GB | 0/12 | 116/158 | 2 | 0 | 2/12 | 3.4 |
| phi4-mini | 2.5 GB | ~5 GB | 0/12 | 90/157 | 0 | 0 | 3/12 | 2.4 |
| llama3.2:3b | 2.0 GB | ~4 GB | 0/12 | 89/158 | 4 | 0 | 7/12 | 2.5 |
| qwen3:4b (thinking) | 2.5 GB | ~5 GB | 0/12 | 0/24 | — | — | 12/12 rejected | 5.8 |
| batiai/qwen3.6-27b:iq3 (prior default, reference) | 11 GB | 16 GB GPU | — | 151/158 | 0† | 0 | — | ~8 |

\* Weights plus the ~1–2GB KV cache at the app's 16k context, rounded up; budget ~8GB free RAM for comfort on CPU.
† Its one recall-relevant miss (an invented "Senior ≈ 6 years" requirement) is neutralized by the FR-6a park rule.

## Failure modes per candidate

- **qwen3:4b-instruct-2507-q4_K_M** — all remaining failures are raw-reply hygiene that the app's code corrects: it consistently reports `gap_years` with the sign flipped (candidate − required instead of required − candidate; the app recomputes the gap from the copied quote, so every persisted score still landed in range), it sometimes returns zero `concerns` on strong matches, and on "none stated" postings it quotes a non-years requirement phrase instead of the literal `none stated` — which lands in the FR-6a park path (quote has no digits → parked at 70, review flag) rather than hiding the job. Zero underscores, zero overscores, 12/12 persisted scores in the expected range: the best result of the small class on exactly the asymmetric metrics the golden set weighs.
- **gemma3:4b** — wraps every reply in markdown fences (contract violation; the app's parser tolerates it), overscores against its own gap read, and **invents years figures for "none stated" postings** (e.g. fabricating a "5+ years" quote) — that fabrication bypasses the FR-6a park and produced 2 recall misses, the costliest failure class. Disqualifying despite the second-best check total.
- **phi4-mini** — fences, sign-flipped and sometimes missing gap fields, 1–2-row comparison tables, invented quotes on "none stated"; 3 persisted scores below the expected floor on trap cases. Structurally too sloppy.
- **llama3.2:3b** — prose before the JSON, wrong quotes, gap arithmetic errors, 4 recall misses. Fast but the weakest quality.
- **qwen3:4b (thinking build)** — hard fail under the app's transport: despite `think: false` it emits chain-of-thought into the visible reply and burns the entire 1024-token output budget before finishing the JSON (`done_reason: "length"` on all 12 cases). Every reply would be rejected and every job re-scored forever. This is the reason the winner is the non-thinking **-instruct-2507** build, not base `qwen3:4b`.

Raw replies and per-check grades for every run are written by the harness to `scripts/eval-score-results.json` (gitignored session artifact).

## Why no prompt or golden changes

The winner's residual misses are precisely the failure classes the deterministic post-processing in `lib/ai/score.ts` exists to absorb (quote re-derive, gap cap, FR-6a park) — the parsed-score column being clean on all 12 cases is the proof. Tightening the prompt for one small model's sign convention would risk regressing the other backends for no persisted-score gain, and relaxing golden expectations to raise the "clean cases" number would hide real raw-reply defects. Both files are unchanged.

## Overriding the model (e.g. restoring the 27B)

The scoring model is a Settings value, never a code edit (FR-6):

1. Pull the model you want, e.g. `ollama pull batiai/qwen3.6-27b:iq3` (11GB; wants a ~16GB GPU — it evaluated at 151/158 checks, the accuracy ceiling here).
2. In the app's **Setup** page, set **Ollama model tag** to that tag (persisted as `user_config.ollama_model`). Existing installs keep whatever tag they have saved; the new default only applies to fresh databases or a blank tag.
3. Scoring runs use the configured tag immediately; if the tag isn't pulled, the run fails loudly with the exact `ollama pull` command to fix it.

To re-run this comparison for any tag: `OLLAMA_SCORE_MODEL=<tag> npx tsx scripts/eval-score-golden.mts qwen` (requires the private `resume/` assets locally; see the harness header).
