import 'dotenv/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  db: {
    url: requireEnv('DATABASE_URL'),
  },

  llm: {
    provider: (process.env.LLM_PROVIDER ?? 'groq') as 'groq' | 'anthropic' | 'openai' | 'gemini',
    model: process.env.LLM_MODEL ?? 'llama-3.3-70b-versatile',
    groqApiKey: process.env.GROQ_API_KEY ?? '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  },
} as const;
