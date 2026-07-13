/**
 * Generic OpenAI-compatible chat-completions provider (Phase 9). Targets NVIDIA
 * NIM's free-tier catalog (e.g. Llama 3.1) by default, but works against any
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
import { cleanTitle, resolveTimeIntent } from './heuristic.js';
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
    if (!content) {
      // A 200 with no choices happens when the requested model isn't actually
      // available on this account/tier — silent otherwise, since it isn't an HTTP error.
      console.error(`nvidia provider: empty response for model "${this.config.model}": ${JSON.stringify(body).slice(0, 500)}`);
      throw new Error('nvidia provider: no message content');
    }
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
      importance: 'major' | 'normal';
      routineFact: { label: string; days?: number[]; startHour: number; endHour?: number } | null;
    }>(
      `${classifyPrompt(input.context.timezone, input.profile?.routines)} Respond as JSON: { type: "task"|"idea"|"reminder", confidence: number 0-1, title: string, timePhrase: string|null, timeAtIso: string|null (ISO 8601), recurrence: string|null, computerAction: boolean, appTrigger: string|null, importance: "major"|"normal", routineFact: {label:string, days?:number[], startHour:number, endHour?:number}|null }.`,
      JSON.stringify({ transcript: input.text, localHour: input.context.localHour, recentTypes: input.context.recentTypes }),
    );
    const timeIntent = resolveTimeIntent(input.text, out, input.context.timezone);
    // Free-form JSON (no schema enforcement): models sometimes answer type
    // "routineFact" instead of using the routineFact field — normalize, never let an
    // invalid enum value reach the database.
    const validTypes = ['task', 'idea', 'reminder'] as const;
    const type = (validTypes as readonly string[]).includes(out.type) ? out.type : 'task';
    const result: ClassifyOutput = {
      type,
      confidence: Math.max(0, Math.min(1, out.confidence)),
      title: out.title?.trim() ? out.title.slice(0, 80) : cleanTitle(input.text),
      timeIntent,
      contextTag: out.computerAction || out.appTrigger ? 'computer-action' : null,
      appTrigger: out.appTrigger ? out.appTrigger.toLowerCase().slice(0, 40) : null,
      importance: out.importance === 'major' ? 'major' : 'normal',
      routineFact:
        out.routineFact && out.routineFact.label?.trim() && Number.isInteger(out.routineFact.startHour)
          ? {
              label: out.routineFact.label.trim().slice(0, 80),
              ...(out.routineFact.days?.length ? { days: out.routineFact.days.filter((d) => d >= 0 && d <= 6) } : {}),
              startHour: Math.max(0, Math.min(23, out.routineFact.startHour)),
              ...(out.routineFact.endHour != null ? { endHour: Math.max(0, Math.min(23, out.routineFact.endHour)) } : {}),
            }
          : null,
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
