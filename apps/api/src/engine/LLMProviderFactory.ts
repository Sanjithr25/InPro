/**
 * LLM Provider Abstraction
 * ─────────────────────────────────────────────────────────────────────────────
 * The factory pattern allows hot-swapping between Grok (Phase 1),
 * Anthropic Claude, OpenAI, or Gemini by changing LLM_PROVIDER in .env.
 *
 * All providers expose the same ChatProvider interface so the engine
 * is completely decoupled from any specific SDK.
 */

import OpenAI from 'openai';
import type { ToolDefinition } from '../types.js';
import { config } from '../config.js';

// ─── Core Interfaces ──────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop';
  toolCalls: ChatToolCall[];
  inputTokens: number;
  outputTokens: number;
}

export interface ChatProvider {
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<ChatResponse>;
}

// ─── Grok Provider (OpenAI-compatible, used in Phase 1) ──────────────────────

class GrokProvider implements ChatProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    this.model = model;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    options: { maxTokens?: number; temperature?: number } = {}
  ): Promise<ChatResponse> {
    const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      ...(openaiTools.length > 0 && { tools: openaiTools }),
    };

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];
    const msg = choice.message;

    const toolCalls: ChatToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const stopReason = (() => {
      switch (choice.finish_reason) {
        case 'tool_calls': return 'tool_use' as const;
        case 'length':     return 'max_tokens' as const;
        case 'stop':
        default:           return 'end_turn' as const;
      }
    })();

    return {
      content: msg.content ?? '',
      stopReason,
      toolCalls,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}

// ─── Anthropic Provider (Phase 2+) ───────────────────────────────────────────
// Placeholder — swap in @anthropic-ai/sdk when Phase 2 begins

class AnthropicProvider implements ChatProvider {
  constructor(_apiKey: string, _model: string) {
    // TODO Phase 2: import Anthropic SDK and implement
    throw new Error('AnthropicProvider not yet implemented — use LLM_PROVIDER=groq for Phase 1');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async chat(_messages: ChatMessage[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    throw new Error('Not implemented');
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export class LLMProviderFactory {
  /**
   * Returns the appropriate ChatProvider based on LLM_PROVIDER env var.
   * Pass custom config to override env defaults (used by AgentNode when
   * an agent has a specific llm_provider_id set).
   */
  static create(overrides?: {
    provider?: typeof config.llm.provider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }): ChatProvider {
    const provider = overrides?.provider ?? config.llm.provider;
    const model    = overrides?.model    ?? config.llm.model;

    switch (provider) {
      case 'groq': {
        const apiKey = overrides?.apiKey ?? config.llm.groqApiKey;
        if (!apiKey) throw new Error('GROQ_API_KEY is not set');
        return new GrokProvider(apiKey, model);
      }
      case 'anthropic': {
        const apiKey = overrides?.apiKey ?? config.llm.anthropicApiKey;
        return new AnthropicProvider(apiKey, model);
      }
      case 'openai': {
        const apiKey = overrides?.apiKey ?? config.llm.openaiApiKey;
        if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
        // OpenAI uses the same GrokProvider class since both are OAI-compatible
        const client = new OpenAI({ apiKey, baseURL: overrides?.baseUrl });
        return {
          async chat(messages, tools = [], options = {}) {
            const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> },
            }));
            const r = await client.chat.completions.create({
              model,
              messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
              max_tokens: options.maxTokens ?? 4096,
              temperature: options.temperature ?? 0.7,
              ...(openaiTools.length > 0 && { tools: openaiTools }),
            });
            const choice = r.choices[0];
            const msg = choice.message;
            return {
              content: msg.content ?? '',
              stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
              toolCalls: (msg.tool_calls ?? []).map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
              })),
              inputTokens: r.usage?.prompt_tokens ?? 0,
              outputTokens: r.usage?.completion_tokens ?? 0,
            };
          },
        };
      }
      default:
        throw new Error(`Unknown LLM provider: ${provider as string}`);
    }
  }
}
