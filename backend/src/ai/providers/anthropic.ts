/**
 * Anthropic (Claude) provider — primary LLM for classification, decomposition,
 * confirmation phrasing, done-matching, and profile derivation.
 *
 * Uses structured outputs (output_config.format json_schema) so every response
 * parses against the capability contract. Logging policy: nothing here logs
 * transcript text; failures throw and the orchestrator falls back to heuristics.
 */
import Anthropic from '@anthropic-ai/sdk';
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

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';

export type { TokenUsage };

const tracker = createUsageTracker();
export const getUsage = tracker.get;

export class AnthropicProvider {
  private client: Anthropic;
  constructor(
    apiKey: string,
    private model = DEFAULT_MODEL,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  private async jsonCall<T>(
    system: string,
    user: string,
    schema: Record<string, unknown>,
    maxTokens = 1024,
  ): Promise<{ data: T; usage: TokenUsage }> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    if (response.stop_reason === 'refusal') throw new Error('model refused');
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('no text block');
    return {
      data: JSON.parse(text.text) as T,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
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
      classifyPrompt(input.context.timezone),
      JSON.stringify({ transcript: input.text, localHour: input.context.localHour, recentTypes: input.context.recentTypes }),
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'confidence', 'title', 'timePhrase', 'timeAtIso', 'recurrence', 'computerAction', 'appTrigger'],
        properties: {
          type: { type: 'string', enum: ['task', 'idea', 'reminder'] },
          confidence: { type: 'number' },
          title: { type: 'string' },
          timePhrase: { type: ['string', 'null'] },
          timeAtIso: { type: ['string', 'null'], format: 'date-time' },
          recurrence: { type: ['string', 'null'] },
          computerAction: { type: 'boolean' },
          appTrigger: { type: ['string', 'null'] },
        },
      },
    );
    let at: number | undefined;
    if (out.timeAtIso) {
      const parsed = Date.parse(out.timeAtIso);
      if (!Number.isNaN(parsed)) at = parsed;
    }
    // Model resolves the phrase; heuristic regex is the safety net.
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
      title: out.title.trim() ? out.title.slice(0, 80) : cleanTitle(input.text),
      timeIntent: timeIntent && (timeIntent.at || timeIntent.phrase) ? timeIntent : null,
      contextTag: out.computerAction || out.appTrigger ? 'computer-action' : null,
      appTrigger: out.appTrigger ? out.appTrigger.toLowerCase().slice(0, 40) : null,
    };
    tracker.set(result, usage);
    return result;
  }

  async decompose(input: DecomposeInput): Promise<DecomposeOutput> {
    const { data: out, usage } = await this.jsonCall<{ subtasks: string[] }>(
      decomposePrompt(input),
      JSON.stringify({ text: input.text }),
      {
        type: 'object',
        additionalProperties: false,
        required: ['subtasks'],
        properties: { subtasks: { type: 'array', items: { type: 'string' } } },
      },
    );
    const result: DecomposeOutput = { subtasks: out.subtasks.slice(0, 8) };
    tracker.set(result, usage);
    return result;
  }

  async confirm(input: ConfirmInput): Promise<ConfirmOutput> {
    const { data: out, usage } = await this.jsonCall<{ message: string }>(
      confirmPrompt(input),
      JSON.stringify(input),
      {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
      256,
    );
    const result: ConfirmOutput = { message: out.message.slice(0, 160) };
    tracker.set(result, usage);
    return result;
  }

  async matchDone(input: MatchDoneInput): Promise<MatchDoneOutput> {
    const { data: out, usage } = await this.jsonCall<{ matchedId: string | null; candidates: string[] }>(
      MATCH_DONE_PROMPT,
      JSON.stringify({ utterance: input.utterance, openItems: input.openItems }),
      {
        type: 'object',
        additionalProperties: false,
        required: ['matchedId', 'candidates'],
        properties: {
          matchedId: { type: ['string', 'null'] },
          candidates: { type: 'array', items: { type: 'string' } },
        },
      },
    );
    const validIds = new Set(input.openItems.map((i) => i.id));
    const result: MatchDoneOutput = {
      matchedId: out.matchedId && validIds.has(out.matchedId) ? out.matchedId : null,
      candidates: out.candidates.filter((c) => validIds.has(c)).slice(0, 3),
    };
    tracker.set(result, usage);
    return result;
  }

  async deriveProfile(input: DeriveProfileInput): Promise<DeriveProfileOutput> {
    const { data: out, usage } = await this.jsonCall<DeriveProfileOutput['attributes']>(
      DERIVE_PROFILE_PROMPT,
      JSON.stringify({
        // Cap the sample; raw imports never persist beyond this call.
        userMessages: input.userMessages.slice(0, 400).map((m) => m.slice(0, 500)),
        behavioralSignals: input.behavioralSignals ?? {},
      }),
      {
        type: 'object',
        additionalProperties: false,
        required: ['tone', 'verbosity', 'decompositionGranularity', 'vocabulary'],
        properties: {
          tone: { type: 'string', enum: ['brief', 'neutral', 'warm'] },
          verbosity: { type: 'string', enum: ['low', 'medium', 'high'] },
          decompositionGranularity: { type: 'string', enum: ['coarse', 'medium', 'fine'] },
          schedulingRhythm: {
            type: 'object',
            additionalProperties: false,
            properties: {
              creativeHours: { type: 'array', items: { type: 'integer' } },
              adminHours: { type: 'array', items: { type: 'integer' } },
            },
          },
          vocabulary: { type: 'array', items: { type: 'string' } },
        },
      },
      2048,
    );
    const result: DeriveProfileOutput = { attributes: out };
    tracker.set(result, usage);
    return result;
  }
}
