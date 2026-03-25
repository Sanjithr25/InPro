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
    provider: (process.env.LLM_PROVIDER ?? 'llama-local') as 'llama-local' | 'ollama' | 'groq' | 'gemini' | 'openai' | 'anthropic' | 'custom',
    model: process.env.LLM_MODEL ?? 'llama3.2',
    
    // API Keys (stored in .env, used as fallback if not in DB)
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    groqApiKey: process.env.GROQ_API_KEY ?? '',
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    
    // Base URLs (optional overrides)
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
    groqBaseUrl: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
    geminiBaseUrl: process.env.GEMINI_BASE_URL,
    customBaseUrl: process.env.CUSTOM_LLM_BASE_URL,
  },

  tools: {
    tavilyApiKey: process.env.TAVILY_API_KEY ?? '',
  }
} as const;
