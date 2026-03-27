/**
 * LLM Provider Factory
 * ─────────────────────────────────────────────────────────────────────────────
 * Factory pattern for hot-swapping LLM backends with dynamic provider support.
 * All providers expose the same ChatProvider interface so AgentNode is
 * fully decoupled from any specific SDK.
 *
 * Supported Providers:
 * - llama-local: System-provided local Llama (via Ollama, no API key required)
 * - ollama: User-configured Ollama cloud (requires base URL + optional API key)
 * - groq: Groq API (OpenAI-compatible)
 * - gemini: Google Gemini (via OpenAI-compatible endpoint or native SDK)
 * - openai: OpenAI API
 * - anthropic: Anthropic Claude API
 * - custom: Any OpenAI-compatible endpoint
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, LLMProviderName, ProviderRequirements } from '../types.js';
import { config } from '../config.js';

// ─── Core Interfaces ──────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  toolCalls?: ChatToolCall[];
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

export type StreamChunk =
  | { type: 'text';      delta: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | { type: 'done';      stopReason: string; inputTokens: number; outputTokens: number };

export interface ChatProvider {
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<ChatResponse>;
  chatStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }
  ): AsyncIterable<StreamChunk>;
}

// ─── Provider Requirements Map ────────────────────────────────────────────────

export const PROVIDER_REQUIREMENTS: Record<LLMProviderName, ProviderRequirements> = {
  'llama-local': {
    requiresApiKey: false,
    requiresBaseUrl: false,
    defaultBaseUrl: 'http://localhost:11434/v1',
  },
  'ollama': {
    requiresApiKey: false,
    requiresBaseUrl: true,
  },
  'groq': {
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
  },
  'gemini': {
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  },
  'openai': {
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  'anthropic': {
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  'custom': {
    requiresApiKey: false,
    requiresBaseUrl: true,
  },
};

// ─── Helper: OpenAI-compatible provider ───────────────────────────────────────

function makeOpenAICompatibleProvider(client: OpenAI, model: string): ChatProvider {
  return {
    async chat(messages, tools = [], options = {}) {
      const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as Record<string, unknown>,
        },
      }));

      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        ...(openaiTools.length > 0 && { tools: openaiTools }),
      };

      const response = await client.chat.completions.create(params, {
        signal: options.signal,
      });
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
    },

    async *chatStream(messages, tools = [], options = {}) {
      const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> },
      }));
      const stream = await client.chat.completions.create({
        model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        stream: true,
        ...(openaiTools.length > 0 && { tools: openaiTools }),
      }, {
        signal: options.signal,
      });
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'end_turn';
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          yield { type: 'text' as const, delta: choice.delta.content };
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            if (tc.function?.name) {
              try {
                yield { type: 'tool_call' as const, name: tc.function.name, arguments: JSON.parse(tc.function.arguments ?? '{}') };
              } catch { /* partial chunk */ }
            }
          }
        }
        if (choice.finish_reason) {
          stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason;
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }
      }
      yield { type: 'done' as const, stopReason, inputTokens, outputTokens };
    },
  };
}

// ─── Anthropic Provider ──────────────────────────────────────────────────────

function makeAnthropicProvider(apiKey: string, model: string, baseURL?: string): ChatProvider {
  const client = new Anthropic({ apiKey, baseURL });

  return {
    async chat(messages, tools = [], options = {}) {
      const systemMsg = messages.find(m => m.role === 'system');
      const chatMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      }));

      const response = await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? 4096,
        system: systemMsg?.content,
        messages: chatMessages,
        ...(anthropicTools.length > 0 && { tools: anthropicTools }),
      }, {
        signal: options.signal,
      });

      const textBlocks = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      const toolCalls: ChatToolCall[] = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, arguments: b.input as Record<string, unknown> }));

      const stopReason = (() => {
        switch (response.stop_reason) {
          case 'tool_use': return 'tool_use' as const;
          case 'max_tokens': return 'max_tokens' as const;
          default: return 'end_turn' as const;
        }
      })();

      return {
        content: textBlocks,
        stopReason,
        toolCalls,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },

    async *chatStream(messages, tools = [], options = {}) {
      const systemMsg = messages.find(m => m.role === 'system');
      const chatMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
        name: t.name, description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      }));
      const stream = await client.messages.stream({
        model,
        max_tokens: options.maxTokens ?? 4096,
        system: systemMsg?.content,
        messages: chatMessages,
        ...(anthropicTools.length > 0 && { tools: anthropicTools }),
      }, {
        signal: options.signal,
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text' as const, delta: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      const toolCalls = final.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map(b => ({ name: b.name, arguments: b.input as Record<string, unknown> }));
      for (const tc of toolCalls) {
        yield { type: 'tool_call' as const, ...tc };
      }
      yield {
        type: 'done' as const,
        stopReason: final.stop_reason ?? 'end_turn',
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      };
    },
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export class LLMProviderFactory {
  /**
   * Returns the appropriate ChatProvider based on the provider name.
   * Overrides are sourced from the llm_settings DB row for the active agent,
   * allowing per-agent provider / model configuration.
   */
  static create(overrides?: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }): ChatProvider {
    const provider = (overrides?.provider ?? config.llm.provider) as LLMProviderName;
    const model = overrides?.model ?? config.llm.model;
    const requirements = PROVIDER_REQUIREMENTS[provider];

    if (!requirements) {
      throw new Error(
        `Unknown LLM provider: "${provider}". Valid providers: ${Object.keys(PROVIDER_REQUIREMENTS).join(', ')}`
      );
    }

    // Resolve API key and base URL based on provider
    const apiKey = this.resolveApiKey(provider, overrides?.apiKey);
    const baseUrl = this.resolveBaseUrl(provider, overrides?.baseUrl);

    // Validate requirements
    if (requirements.requiresApiKey && !apiKey) {
      throw new Error(`Provider "${provider}" requires an API key. Please configure it in LLM settings or .env`);
    }
    if (requirements.requiresBaseUrl && !baseUrl) {
      throw new Error(`Provider "${provider}" requires a base URL. Please configure it in LLM settings.`);
    }

    // Create provider based on type
    switch (provider) {
      case 'anthropic': {
        console.log(`[LLMFactory] Initializing Anthropic SDK wrapper for model: ${model}${baseUrl ? ` (at ${baseUrl})` : ''}`);
        return makeAnthropicProvider(apiKey!, model, baseUrl);
      }

      case 'llama-local':
      case 'ollama':
      case 'groq':
      case 'gemini':
      case 'openai':
      case 'custom': {
        // All these use OpenAI-compatible API
        const finalBaseUrl = baseUrl || requirements.defaultBaseUrl;
        const finalApiKey = apiKey || 'not-required';
        console.log(`[LLMFactory] Initializing OpenAI SDK wrapper for provider: ${provider}, model: ${model}${finalBaseUrl ? ` (at ${finalBaseUrl})` : ''}`);
        const client = new OpenAI({ 
          apiKey: finalApiKey, 
          baseURL: finalBaseUrl,
        });
        return makeOpenAICompatibleProvider(client, model);
      }

      default: {
        throw new Error(`Provider "${provider}" is not implemented yet.`);
      }
    }
  }

  /**
   * Resolves API key from overrides or config based on provider
   */
  private static resolveApiKey(provider: LLMProviderName, override?: string): string | undefined {
    if (override) return override;

    switch (provider) {
      case 'anthropic': return (config.llm as any).anthropicApiKey || (config.llm as any).anthropicAuthToken || undefined;
      case 'openai': return config.llm.openaiApiKey || undefined;
      case 'groq': return config.llm.groqApiKey || undefined;
      case 'gemini': return config.llm.geminiApiKey || undefined;
      case 'llama-local': return 'not-required';
      case 'ollama': return undefined; // Optional for Ollama
      case 'custom': return undefined; // Optional for custom endpoints
      default: return undefined;
    }
  }

  /**
   * Resolves base URL from overrides or config based on provider
   */
  private static resolveBaseUrl(provider: LLMProviderName, override?: string): string | undefined {
    if (override) return override;

    const requirements = PROVIDER_REQUIREMENTS[provider];
    if (requirements.defaultBaseUrl) return requirements.defaultBaseUrl;

    switch (provider) {
      case 'anthropic': return (config.llm as any).anthropicBaseUrl;
      case 'ollama': return config.llm.ollamaBaseUrl;
      case 'groq': return config.llm.groqBaseUrl;
      case 'gemini': return config.llm.geminiBaseUrl;
      case 'custom': return config.llm.customBaseUrl;
      default: return undefined;
    }
  }

  /**
   * Get provider requirements for UI/validation
   */
  static getRequirements(provider: LLMProviderName): ProviderRequirements {
    return PROVIDER_REQUIREMENTS[provider];
  }
}
