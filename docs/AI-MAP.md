# AI map — where Scrible uses AI, and the context engine

Answers "where do we use AI" and documents the Phase 8 context engine: a system
that grows more aware of the user's patterns the more it's used, **without ever
increasing token usage** — usage goes down as it learns, never up.

## The six capabilities

Every model interaction goes through `backend/src/ai/` (build plan §5.6) — nothing
outside that directory calls a model provider. Each capability has a versioned
contract (`ai/contracts.ts`) and a provider chain with fallback (`ai/orchestrator.ts`).

| Capability | Fires when | Provider chain | Token profile |
|---|---|---|---|
| `classify` | Every new capture (voice or typed) | `learned → anthropic → heuristic` | **Falls to 0 tokens** once the learned provider is confident for a pattern; otherwise one Claude call (short prompt: transcript + localHour + recentTypes ≤ 5, no profile text beyond structured fields) |
| `decompose` | Right after classify, same capture | `anthropic → heuristic` | One Claude call when configured (transcript + granularity preference) |
| `confirm` | After capture, after scheduling, after completion, etc. | `anthropic → heuristic` | One small Claude call (≤256 tokens out) per event |
| `matchDone` | Spoken/typed "done" utterance | `learned → anthropic → heuristic` | **Falls to 0 tokens** once the learned provider confidently matches; otherwise one Claude call (utterance + open item titles only) |
| `schedule` | Auto-scheduling an idea/reminder | `heuristic` only | 0 tokens — deterministic constraint-solving over computed free/busy slots, not language understanding |
| `deriveProfile` | Chat import, profile refresh | `anthropic → heuristic` | One Claude call, capped input (≤400 messages × 500 chars) |

STT (speech-to-text) itself is on-device (`expo-speech-recognition` / Web Speech
API) — zero tokens, never touches this layer.

## The context engine (Phase 8)

**Design thesis:** learned priors live in the database and are applied in code,
never in prompts. A capped table (`learned_signals`, ≤200 rows/user) accumulates
pattern → outcome evidence from the user's own corrections and edits — never from
model guesses. A new `learned` provider, registered **first** in the `classify` and
`matchDone` chains, blends deterministic heuristics with this evidence:

- **Confident** (strong, unambiguous prior agreement) → answers instantly, 0 tokens.
- **Not confident** → `throw new NotConfident()`, which the orchestrator treats like
  any other provider failure and falls through to Claude — the existing fallback
  mechanics in `ai/orchestrator.ts` are unchanged.

As the user corrects the system, more captures short-circuit before ever reaching
Claude: **accuracy goes up, and token usage goes down, never up.**

### What's learned, from where

| Signal (`kind`) | Learned from | Consumed by |
|---|---|---|
| `type_prior` | `PATCH`-equivalent `item.retype` ops (user corrects task/idea/reminder) | `classifyLearned` — confident type overrides the heuristic guess |
| `app_alias` | User manually sets an item's `appTrigger` (not a server-derived one) | `classifyLearned` (inherits the trigger for similar future captures) and `matchDoneLearned` (sharpens title-overlap scoring) |

Both are gated on the `chat_import` consent category (same category, same
transparency UI as the personality profile — build plan §9.6) and are taught **only**
by user-originated sync ops. `SyncEngine.serverUpdateItem` tags its own writes with
`origin: 'server'` so the system never learns from its own enrichment guesses —
only from a human correcting it.

### Why this can never grow token usage

1. **Nothing learned is ever interpolated into a prompt string.** The `learned`
   provider only returns structured output objects (same shape as heuristic/Claude
   outputs) or throws — it never builds prompt text.
2. **Every prompt input Claude actually sees stays hard-capped** regardless of how
   much has been learned: `recentTypes` ≤ 5, profile `vocabulary` ≤ 15 terms. Growth
   in the learned table changes *which* 15 vocabulary terms are picked
   (`learnedVocabulary`), never *how many*. A test (`context-engine.test.ts`) asserts
   the serialized classify-input byte size is identical at 0 vs. 500 learned rows.
3. **Pruning keeps the table itself bounded.** `prune()` halves all weights and drops
   rows below 0.5 whenever a user crosses 200 rows, then trims to the cap if still
   over — natural decay, most-recent/strongest patterns survive.

### Proving it: `GET /v1/ai/metrics`

Authenticated route exposing per-capability call counts by provider name (`learned`
/ `anthropic` / `heuristic`) and summed `inputTokens`/`outputTokens` from Anthropic's
own `response.usage`. Watch the `learned` share of `classify`/`matchDone` calls rise
and the token sums grow slower than call volume (or fall, per-capture, as more
corrections land) — this is the measurable proof of the design thesis, not an
aspiration.

Token capture itself is race-free: `ai/providers/anthropic.ts` attaches usage to
each call's *specific returned output object* via a `WeakMap` (`getUsage`), keyed by
object identity rather than a shared mutable field — safe under concurrent requests
sharing one `AnthropicProvider` instance.

### Transparency & deletion

`GET /v1/profile` includes a `learned` section: counts per signal kind and up to 10
patterns in plain language, e.g. `"gym" → reminder (learned from 3 corrections)`.
`learned_signals` dies with: the profile-delete button (`DELETE /v1/profile`), the
`chat_import` consent revocation hook, and account deletion (`USER_DATA_TABLES`) —
see `docs/data-classification.md`.
