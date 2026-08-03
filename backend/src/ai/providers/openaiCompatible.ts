/**
 * Generic OpenAI-compatible chat-completions provider (Phase 9). Targets NVIDIA
 * NIM's free-tier catalog (e.g. MiniMax M3) by default, but works against any
 * OpenAI-chat-compatible endpoint — same transport, just a different base URL.
 *
 * No SDK dependency: Node's global `fetch` is enough. Any failure (network, non-2xx,
 * malformed JSON) simply throws — the orchestrator's existing fallback chain handles
 * it exactly like an Anthropic failure, falling through to the next provider.
 */
import type {
  ClassifyInput,
  ClassifyOutput,
  ConfirmInput,
  ConfirmOutput,
  DecomposeInput,
  DecomposeOutput,
  DeriveProfileInput,
  DeriveProfileOutput,
  MatchDoneInput,
  MatchDoneOutput,
} from '../contracts.js';
import { parseTimeIntent, cleanTitle } from './heuristic.js';
import { classifyPrompt, decomposePrompt, confirmPrompt, MATCH_DONE_PROMPT, DERIVE_PROFILE_PROMPT } from './prompts.js';
import { createUsageTracker, type TokenUsage } from './usageTracker.js';

export interface OpenAICompatibleConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

const tracker = createUsageTracker();

/** Models sometimes wrap JSON in prose or markdown fences despite instructions. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object in response');
  return JSON.parse(body.slice(start, end + 1));
}

export class OpenAICompatibleProvider {
  constructor(private config: OpenAICompatibleConfig) {}

  getUsage = tracker.get;

  private async jsonCall<T>(system: string, user: string): Promise<{ data: T; usage: TokenUsage }> {
    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: `${system} Respond with ONLY a single JSON object — no markdown, no commentary.` },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      // Diagnostic only (API error detail, e.g. "model not found") — never transcript
      // text, never the key. Without this, a bad NVIDIA_MODEL/key silently falls
      // through to heuristic on every call with no way to tell why from the outside.
      const detail = await res.text().catch(() => '');
      console.error(`nvidia provider http ${res.status}: ${detail.slice(0, 500)}`);
      throw new Error(`nvidia provider http ${res.status}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('nvidia provider: no message content');
    return {
      data: extractJson(content) as T,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }

  async classify(input: ClassifyInput): Promise<ClassifyOutput> {
    const { data: out, usage } = await this.jsonCall<{
      type: 'task' | 'idea' | 'reminder';
      confidence: number;
      title: string;
      timePhrase: string | null;
      timeAtIso: string | null;
      recurrence: string | null;
      computerAction: boolean;
      appTrigger: string | null;
    }>(
      `${classifyPrompt(input.context.timezone)} Respond as JSON: { type: "task"|"idea"|"reminder", confidence: number 0-1, title: string, timePhrase: string|null, timeAtIso: string|null (ISO 8601), recurrence: string|null, computerAction: boolean, appTrigger: string|null }.`,
      JSON.stringify({ transcript: input.text, localHour: input.context.localHour, recentTypes: input.context.recentTypes }),
    );
    let at: number | undefined;
    if (out.timeAtIso) {
      const parsed = Date.parse(out.timeAtIso);
      if (!Number.isNaN(parsed)) at = parsed;
    }
    const timeIntent =
      at || out.timePhrase
        ? {
            ...(at ? { at } : parseTimeIntent(input.text) ?? {}),
            ...(out.timePhrase ? { phrase: out.timePhrase } : {}),
            ...(out.recurrence ? { recurrence: out.recurrence } : {}),
          }
        : null;
    const result: ClassifyOutput = {
      type: out.type,
      confidence: Math.max(0, Math.min(1, out.confidence)),
      title: out.title?.trim() ? out.title.slice(0, 80) : cleanTitle(input.text),
      timeIntent: timeIntent && (timeIntent.at || timeIntent.phrase) ? timeIntent : null,
      contextTag: out.computerAction || out.appTrigger ? 'computer-action' : null,
      appTrigger: out.appTrigger ? out.appTrigger.toLowerCase().slice(0, 40) : null,
    };
    tracker.set(result, usage);
    return result;
  }

  async decompose(input: DecomposeInput): Promise<DecomposeOutput> {
    const { data: out, usage } = await this.jsonCall<{ subtasks: string[] }>(
      `${decomposePrompt(input)} Respond as JSON: { subtasks: string[] }.`,
      JSON.stringify({ text: input.text }),
    );
    const result: DecomposeOutput = { subtasks: (out.subtasks ?? []).slice(0, 8) };
    tracker.set(result, usage);
    return result;
  }

  async confirm(input: ConfirmInput): Promise<ConfirmOutput> {
    const { data: out, usage } = await this.jsonCall<{ message: string }>(
      `${confirmPrompt(input)} Respond as JSON: { message: string }.`,
      JSON.stringify(input),
    );
    const result: ConfirmOutput = { message: out.message.slice(0, 160) };
    tracker.set(result, usage);
    return result;
  }

  async matchDone(input: MatchDoneInput): Promise<MatchDoneOutput> {
    const { data: out, usage } = await this.jsonCall<{ matchedId: string | null; candidates: string[] }>(
      `${MATCH_DONE_PROMPT} Respond as JSON: { matchedId: string|null, candidates: string[] }.`,
      JSON.stringify({ utterance: input.utterance, openItems: input.openItems }),
    );
    const validIds = new Set(input.openItems.map((i) => i.id));
    const result: MatchDoneOutput = {
      matchedId: out.matchedId && validIds.has(out.matchedId) ? out.matchedId : null,
      candidates: (out.candidates ?? []).filter((c) => validIds.has(c)).slice(0, 3),
    };
    tracker.set(result, usage);
    return result;
  }

  async deriveProfile(input: DeriveProfileInput): Promise<DeriveProfileOutput> {
    const { data: out, usage } = await this.jsonCall<DeriveProfileOutput['attributes']>(
      `${DERIVE_PROFILE_PROMPT} Respond as JSON: { tone: "brief"|"neutral"|"warm", verbosity: "low"|"medium"|"high", decompositionGranularity: "coarse"|"medium"|"fine", schedulingRhythm?: { creativeHours?: number[], adminHours?: number[] }, vocabulary: string[] }.`,
      JSON.stringify({
        userMessages: input.userMessages.slice(0, 400).map((m) => m.slice(0, 500)),
        behavioralSignals: input.behavioralSignals ?? {},
      }),
    );
    const result: DeriveProfileOutput = { attributes: out };
    tracker.set(result, usage);
    return result;
  }
}
