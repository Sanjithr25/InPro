/**
 * ToolRegistry
 * ─────────────────────────────────────────────────────────────────────────────
 * Routes tool calls from the agentic loop to their actual implementations.
 *
 * Built-in tools (web_search, calculator, etc.) are handled by the
 * BUILT_IN_TOOL_MAP from builtins.ts.
 *
 * Custom tools (user-created via the UI) fall through to a generic HTTP
 * handler if they have an `endpoint` or `url` in their config.
 */

import { BUILT_IN_TOOL_MAP } from './builtins.js';

export class ToolRegistry {
  static async execute(
    toolName: string,
    args: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    console.log(`[ToolRegistry] "${toolName}"`, args);

    // ── 1. Built-in tool ─────────────────────────────────────────────────────
    const builtIn = BUILT_IN_TOOL_MAP.get(toolName);
    if (builtIn) {
      const result = await builtIn.execute(args, config);
      return result as Record<string, unknown>;
    }

    // ── 2. Custom HTTP tool (has endpoint in config) ──────────────────────────
    const endpoint = (config.endpoint ?? config.url ?? config.base_url) as string | undefined;
    if (endpoint) {
      const method = (config.method as string) ?? 'POST';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.auth_token) headers['Authorization'] = `Bearer ${config.auth_token}`;
      const res = await fetch(endpoint, {
        method,
        headers,
        body: method !== 'GET' ? JSON.stringify(args) : undefined,
      });
      const text = await res.text();
      try { return JSON.parse(text) as Record<string, unknown>; }
      catch { return { response: text, status: res.status }; }
    }

    // ── 3. Unknown tool — return structured stub ──────────────────────────────
    console.warn(`[ToolRegistry] No handler for tool: "${toolName}"`);
    return {
      tool: toolName,
      status: 'not_implemented',
      message: `Tool "${toolName}" has no handler registered. Add an endpoint to its config or implement a built-in handler.`,
      args,
    };
  }
}
