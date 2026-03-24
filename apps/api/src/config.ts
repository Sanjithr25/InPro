import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from monorepo root
dotenv.config({ path: join(__dirname, '../../../.env') });

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
    provider: (process.env.LLM_PROVIDER ?? 'ollama') as 'ollama' | 'anthropic' | 'openai' | 'gemini',
    model: process.env.LLM_MODEL ?? 'llama3.2',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  },
} as const;
