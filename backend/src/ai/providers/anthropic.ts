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

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';

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
  ): Promise<T> {
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
    return JSON.parse(text.text) as T;
  }

  async classify(input: ClassifyInput): Promise<ClassifyOutput> {
    const out = await this.jsonCall<{
      type: 'task' | 'idea' | 'reminder';
      confidence: number;
      title: string;
      timePhrase: string | null;
      timeAtIso: string | null;
      recurrence: string | null;
      computerAction: boolean;
      appTrigger: string | null;
    }>(
      `You classify a voice-captured note into exactly one of: task (something to do), idea (a thought/concept to develop later), reminder (time-bound nudge). Extract any explicit time expression. Flag when the item requires being at a computer/browser (posting online, email, publishing, coding). If the item should surface when a specific desktop application is opened ("when I open Photoshop…"), extract that application's name (lowercase) as appTrigger; otherwise null. Current local time: ${new Date().toISOString()} in timezone ${input.context.timezone}. Resolve relative times against that. Produce a short cleaned title (max 60 chars) without filler like "remind me to".`,
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
    return {
      type: out.type,
      confidence: Math.max(0, Math.min(1, out.confidence)),
      title: out.title.trim() ? out.title.slice(0, 80) : cleanTitle(input.text),
      timeIntent: timeIntent && (timeIntent.at || timeIntent.phrase) ? timeIntent : null,
      contextTag: out.computerAction || out.appTrigger ? 'computer-action' : null,
      appTrigger: out.appTrigger ? out.appTrigger.toLowerCase().slice(0, 40) : null,
    };
  }

  async decompose(input: DecomposeInput): Promise<DecomposeOutput> {
    const granularity = input.profile?.decompositionGranularity ?? 'medium';
    const out = await this.jsonCall<{ subtasks: string[] }>(
      `You break a captured ${input.type} into concrete, ordered sub-tasks. Rules: if the item is small enough to do in one sitting, return an empty list — never manufacture busywork. Granularity preference: ${granularity} (coarse = 2-3 large steps, medium = up to 5, fine = up to 8 small steps). Each sub-task is a short imperative phrase.`,
      JSON.stringify({ text: input.text }),
      {
        type: 'object',
        additionalProperties: false,
        required: ['subtasks'],
        properties: { subtasks: { type: 'array', items: { type: 'string' } } },
      },
    );
    return { subtasks: out.subtasks.slice(0, 8) };
  }

  async confirm(input: ConfirmInput): Promise<ConfirmOutput> {
    const tone = input.profile?.tone ?? 'neutral';
    const verbosity = input.profile?.verbosity ?? 'medium';
    const out = await this.jsonCall<{ message: string }>(
      `Write a one-line plain-language confirmation for a task app. Tone: ${tone}. Verbosity: ${verbosity}. Never exceed 120 characters. No emoji unless tone is warm.`,
      JSON.stringify(input),
      {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
      256,
    );
    return { message: out.message.slice(0, 160) };
  }

  async matchDone(input: MatchDoneInput): Promise<MatchDoneOutput> {
    const out = await this.jsonCall<{ matchedId: string | null; candidates: string[] }>(
      'The user spoke a completion utterance. Match it to exactly one of their open items. If confident, set matchedId. If ambiguous between a few, return their ids as candidates with matchedId null. If nothing matches, both empty/null.',
      JSON.stringify(input),
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
    return {
      matchedId: out.matchedId && validIds.has(out.matchedId) ? out.matchedId : null,
      candidates: out.candidates.filter((c) => validIds.has(c)).slice(0, 3),
    };
  }

  async deriveProfile(input: DeriveProfileInput): Promise<DeriveProfileOutput> {
    const out = await this.jsonCall<DeriveProfileOutput['attributes']>(
      `Derive a small structured working-style profile from a user's assistant-chat messages and behavioral signals. Output ONLY structured attributes — never quote or paraphrase the conversations. vocabulary = up to 15 domain terms the user actually uses. schedulingRhythm hours are 0-23 local.`,
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
    return { attributes: out };
  }
}
