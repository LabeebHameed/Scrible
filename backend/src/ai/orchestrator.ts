/**
 * AI orchestration layer (build plan §2.2).
 *
 * Owns provider selection + fallback chains, contract versioning, latency/cost
 * instrumentation, and the logging policy: instrumentation records capability,
 * provider, duration, and outcome — NEVER payload text (transcripts, titles,
 * import content must not reach logs; see docs/data-classification.md).
 */
import type { Capability, CapabilityMap } from './contracts.js';
import { CONTRACT_VERSIONS } from './contracts.js';

export interface Provider<C extends Capability> {
  name: string;
  run(input: CapabilityMap[C]['in']): Promise<CapabilityMap[C]['out']>;
  /** Optional token usage for the output just returned (Anthropic-backed providers). */
  usageOf?(output: CapabilityMap[C]['out']): { inputTokens: number; outputTokens: number } | undefined;
}

export interface CallMetric {
  capability: Capability;
  contractVersion: string;
  provider: string;
  durationMs: number;
  ok: boolean;
  fellBack: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export class Orchestrator {
  private chains: { [C in Capability]?: Array<Provider<C>> } = {};
  private metrics: CallMetric[] = [];
  /** Per-call latency budget before falling to the next provider. */
  timeoutMs = 10_000;

  register<C extends Capability>(capability: C, provider: Provider<C>): void {
    const chain = (this.chains[capability] ??= []) as Array<Provider<C>>;
    chain.push(provider);
  }

  async run<C extends Capability>(
    capability: C,
    input: CapabilityMap[C]['in'],
  ): Promise<CapabilityMap[C]['out']> {
    const chain = (this.chains[capability] ?? []) as Array<Provider<C>>;
    if (chain.length === 0) throw new Error(`no provider for ${capability}`);
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i]!;
      const started = Date.now();
      try {
        const out = await withTimeout(provider.run(input), this.timeoutMs);
        const usage = provider.usageOf?.(out);
        this.metrics.push({
          capability,
          contractVersion: CONTRACT_VERSIONS[capability],
          provider: provider.name,
          durationMs: Date.now() - started,
          ok: true,
          fellBack: i > 0,
          ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
        });
        return out;
      } catch (err) {
        lastErr = err;
        this.metrics.push({
          capability,
          contractVersion: CONTRACT_VERSIONS[capability],
          provider: provider.name,
          durationMs: Date.now() - started,
          ok: false,
          fellBack: i > 0,
        });
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`all providers failed for ${capability}`);
  }

  recentMetrics(limit = 100): CallMetric[] {
    return this.metrics.slice(-limit);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
