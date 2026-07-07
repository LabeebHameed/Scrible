export interface Config {
  port: number;
  databasePath: string;
  jwtSecret: string;
  anthropicApiKey: string | undefined;
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
  return {
    port: Number(env.PORT ?? 8787),
    databasePath: env.DATABASE_PATH ?? 'scrible.db',
    jwtSecret,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
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
