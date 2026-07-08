/**
 * Token-accounting transparency (Phase 8): proves "no token growth" is measurable,
 * not aspirational — shows the learned-provider share rising and tokens falling
 * as the context engine accumulates evidence from the user's own corrections.
 */
import type { FastifyInstance } from 'fastify';
import type { Orchestrator } from '../ai/orchestrator.js';

export function registerAiMetrics(app: FastifyInstance, orchestrator: Orchestrator): void {
  app.get('/v1/ai/metrics', { preHandler: app.authenticate }, async () => {
    const metrics = orchestrator.recentMetrics(500);
    const byCapability: Record<
      string,
      Record<string, { calls: number; inputTokens: number; outputTokens: number }>
    > = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const m of metrics) {
      const cap = (byCapability[m.capability] ??= {});
      const prov = (cap[m.provider] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      prov.calls += 1;
      prov.inputTokens += m.inputTokens ?? 0;
      prov.outputTokens += m.outputTokens ?? 0;
      totalInputTokens += m.inputTokens ?? 0;
      totalOutputTokens += m.outputTokens ?? 0;
    }
    return { byCapability, totalInputTokens, totalOutputTokens, sampleSize: metrics.length };
  });
}
