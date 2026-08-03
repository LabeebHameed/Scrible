# AI map — where Scrible uses AI, and the context/automation engine

Answers "where do we use AI" and documents two things:
- **Phase 8, the context engine**: learns from the user's own corrections, growing
  more accurate the more it's used, **without ever increasing token usage**.
- **Phase 9, free-tier-first automation**: heuristics are tried before any LLM, and
  the primary LLM tier is a free-tier provider (NVIDIA NIM), with paid Anthropic
  demoted to an optional, explicit opt-in. Net result: the app can run **indefinitely
  at zero cost**, and even when a key is configured, it's consulted only for the
  fraction of cases deterministic logic can't confidently resolve.

## The six capabilities

Every model interaction goes through `backend/src/ai/` (build plan §5.6) — nothing
outside that directory calls a model provider. Each capability has a versioned
contract (`ai/contracts.ts`) and a provider chain with fallback (`ai/orchestrator.ts`).

| Capability | Fires when | Provider chain | Token profile |
|---|---|---|---|
| `classify` | Every new capture (voice or typed) | `learned → heuristic-confident → nvidia → anthropic (if key) → heuristic` | **0 tokens** whenever the learned provider or the heuristic's own confidence (explicit "remind me"/"idea" hints, etc.) is already strong; only the ambiguous remainder reaches an LLM |
| `decompose` | Right after classify, same capture | `heuristic-confident → nvidia → anthropic (if key) → heuristic` | **0 tokens** when the item is confidently too small to split, or explicit connectors ("do X, then Y") already found the structure; only long implicit-structure text reaches an LLM |
| `confirm` | After capture, after scheduling, after completion, etc. | `heuristic` only | **Always 0 tokens.** Fires on every event — the highest-frequency AI call in the app — so it never consults an LLM at all; templated messages already honor tone/verbosity from the profile |
| `matchDone` | Spoken/typed "done" utterance | `learned → heuristic-confident → nvidia → anthropic (if key) → heuristic` | **0 tokens** once a learned alias or a strong single token-overlap match is confident; only genuine ambiguity reaches an LLM |
| `schedule` | Auto-scheduling an idea/reminder | `heuristic` only | 0 tokens — deterministic constraint-solving over computed free/busy slots, not language understanding |
| `deriveProfile` | Chat import, profile refresh | `nvidia → anthropic (if key) → heuristic` | Rare (not per-capture); one free-tier call when configured, capped input (≤400 messages × 500 chars) |

STT (speech-to-text) itself is on-device (`expo-speech-recognition` / Web Speech
API) — zero tokens, never touches this layer.

## Free-tier-first (Phase 9)

**Problem:** the app must be usable indefinitely without ever costing money, and AI
should be consulted for as small a slice of the work as possible — automation and
deterministic heuristics first, real language understanding only where they
genuinely can't resolve the case.

**Two independent levers, both applied to every relevant chain above:**

1. **Confidence gates ahead of any LLM** (`ai/providers/confident.ts`): thin wrappers
   around the existing heuristics (`classifyHeuristic`, `decomposeHeuristic`,
   `scoreOpenItems`) that return immediately when the heuristic's own signal is
   already strong, and `throw new NotConfident()` otherwise — reusing the exact
   fallback mechanics Phase 8's `learned` provider already established in
   `ai/orchestrator.ts` (no orchestrator changes needed). This is the "automate
   first" half: it applies regardless of which LLM (or none) is configured.
2. **NVIDIA NIM as the primary LLM tier** (`ai/providers/openaiCompatible.ts`): a
   generic OpenAI-compatible chat-completions client (works against NVIDIA NIM's
   free-tier catalog — e.g. MiniMax M3 — or any compatible endpoint), registered
   *before* Anthropic in every chain. `ANTHROPIC_API_KEY` becomes a fully optional,
   paid, opt-in quality upgrade — not required for any capability. No SDK dependency:
   built on Node's global `fetch`.

With only `NVIDIA_API_KEY` set (no Anthropic key), the app runs at $0 forever. With
neither key set, every capability still resolves via the deterministic heuristic
tier — the product works out of the box, in tests, and offline. If the configured
LLM tier is ever down, rate-limited, or returns malformed output, the provider simply
throws and the chain falls through to the next tier — **never a hard failure**
(`backend/test/ai-provider-chain.test.ts` covers this explicitly, including a stubbed
NVIDIA failure falling through to heuristic).

`confirm` is the one capability with no LLM tier at all: it fires on every single
event (captured/scheduled/moved/conflict/reminder_set/completed), making it by far
the highest-frequency AI call in the app, and the heuristic's templated messages
already vary by tone/verbosity — dropping AI here was the single largest per-capture
token cut available.

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
/ `heuristic-confident` / `nvidia` / `anthropic` / `heuristic`) and summed
`inputTokens`/`outputTokens` from each LLM's own usage response. Watch the combined
`learned` + `heuristic-confident` share of calls rise and the token sums grow slower
than call volume (or fall, per-capture, as more corrections land and more phrasing
turns out to be confidently automatable) — this is the measurable proof of the
design thesis, not an aspiration.

Token capture itself is race-free: `ai/providers/usageTracker.ts` (`createUsageTracker`)
attaches usage to each call's *specific returned output object* via a `WeakMap`,
keyed by object identity rather than a shared mutable field — safe under concurrent
requests sharing one provider instance. Both `ai/providers/anthropic.ts` and
`ai/providers/openaiCompatible.ts` use this same shared tracker.

### Transparency & deletion

`GET /v1/profile` includes a `learned` section: counts per signal kind and up to 10
patterns in plain language, e.g. `"gym" → reminder (learned from 3 corrections)`.
`learned_signals` dies with: the profile-delete button (`DELETE /v1/profile`), the
`chat_import` consent revocation hook, and account deletion (`USER_DATA_TABLES`) —
see `docs/data-classification.md`.
