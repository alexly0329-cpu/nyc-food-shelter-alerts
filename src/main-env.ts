const REQUIRED_IN_PRODUCTION = [
  'VONAGE_APPLICATION_ID', 'VONAGE_PRIVATE_KEY', 'VONAGE_NUMBER', 'VONAGE_SIGNATURE_SECRET', 'TAVILY_API_KEY',
] as const;

/** Names (never values) of required vars that are unset or empty; always [] outside production. */
export function missingProductionEnv(env: NodeJS.ProcessEnv): string[] {
  return env.NODE_ENV === 'production' ? REQUIRED_IN_PRODUCTION.filter((n) => !env[n]) : [];
}
