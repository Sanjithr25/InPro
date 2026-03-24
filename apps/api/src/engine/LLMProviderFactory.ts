/**
 * LLM Provider Factory
 * ─────────────────────────────────────────────────────────────────────────────
 * Factory pattern for hot-swapping LLM backends (Ollama, OpenAI, Anthropic).
 * All providers expose the same ChatProvider interface so AgentNode is
 * fully decoupled from any specific SDK.
 *
 * Ollama is the default provider — it exposes an OpenAI-compatible API at
 * http://localhost:11434/v1, so we use the `openai` npm package for all calls.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
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

// ─── Helper: OpenAI-compatible provider (Ollama + OpenAI) ────────────────────

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

      const response = await client.chat.completions.create(params);
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
  };
}

// ─── Anthropic Provider ──────────────────────────────────────────────────────

function makeAnthropicProvider(apiKey: string, model: string): ChatProvider {
  const client = new Anthropic({ apiKey });

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
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export class LLMProviderFactory {
  /**
   * Returns the appropriate ChatProvider.
   * Overrides are sourced from the llm_settings DB row for the active agent,
   * allowing per-agent provider / model configuration.
   */
  static create(overrides?: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }): ChatProvider {
    const provider = overrides?.provider ?? config.llm.provider;
    const model    = overrides?.model    ?? config.llm.model;

    switch (provider) {
      case 'ollama': {
        // Ollama exposes an OpenAI-compatible API — no key needed
        const baseURL = overrides?.baseUrl ?? 'http://localhost:11434/v1';
        const client = new OpenAI({ apiKey: 'ollama', baseURL });
        return makeOpenAICompatibleProvider(client, model);
      }

      case 'openai': {
        const apiKey = overrides?.apiKey ?? config.llm.openaiApiKey;
        if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
        const client = new OpenAI({ apiKey, baseURL: overrides?.baseUrl });
        return makeOpenAICompatibleProvider(client, model);
      }

      case 'anthropic': {
        const apiKey = overrides?.apiKey ?? config.llm.anthropicApiKey;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
        return makeAnthropicProvider(apiKey, model);
      }

      default:
        throw new Error(`Unknown LLM provider: "${provider}". Valid: ollama | openai | anthropic`);
    }
  }
}
