/**
 * Race-free token accounting (Phase 8/9): usage is attached to the exact output
 * object a call returns rather than a shared mutable field, so concurrent calls on
 * one provider instance can never cross-contaminate — each output object is unique.
 * Shared by anthropic.ts and openaiCompatible.ts so both track usage the same way.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function createUsageTracker<T extends object = object>(): {
  set: (output: T, usage: TokenUsage) => void;
  get: (output: T) => TokenUsage | undefined;
} {
  const usageByOutput = new WeakMap<object, TokenUsage>();
  return {
    set: (output, usage) => {
      usageByOutput.set(output, usage);
    },
    get: (output) => usageByOutput.get(output),
  };
}
