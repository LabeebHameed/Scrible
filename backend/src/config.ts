export interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  anthropicApiKey: string | undefined;
  /** Free-tier-first primary LLM (Phase 9): NVIDIA NIM or any OpenAI-compatible endpoint. */
  nvidiaApiKey: string | undefined;
  nvidiaModel: string;
  nvidiaBaseUrl: string;
  /** Feature flags for gradual phase rollout (build plan §5.7). */
  flags: {
    autoClassify: boolean;
    autoSchedule: boolean;
    personalization: boolean;
    analytics: boolean;
  };
  /** Rolling retention windows (docs/data-classification.md). */
  changeFeedRetentionDays: number;
  auditLogRetentionDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET ?? 'dev-secret-do-not-use-in-production';
  if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production');
  }
  if (env.NODE_ENV === 'production' && !env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required in production');
  }
  return {
    port: Number(env.PORT ?? 8787),
    databaseUrl: env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/scrible_dev',
    jwtSecret,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    nvidiaApiKey: env.NVIDIA_API_KEY,
    nvidiaModel: env.NVIDIA_MODEL ?? 'minimaxai/minimax-m3',
    nvidiaBaseUrl: env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    flags: {
      autoClassify: env.FLAG_AUTO_CLASSIFY !== '0',
      autoSchedule: env.FLAG_AUTO_SCHEDULE !== '0',
      personalization: env.FLAG_PERSONALIZATION !== '0',
      analytics: env.FLAG_ANALYTICS !== '0',
    },
    changeFeedRetentionDays: Number(env.CHANGE_FEED_RETENTION_DAYS ?? 30),
    auditLogRetentionDays: Number(env.AUDIT_LOG_RETENTION_DAYS ?? 90),
  };
}
