/**
 * ToolRegistry
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for all tool definitions and execution.
 *
 * Built-in tools are defined inline here and seeded into the `tools` DB table
 * on server startup via ToolRegistry.seed(). After seeding they are regular
 * DB rows — users can edit their config, enable/disable, or delete them.
 *
 * Execution priority for a given tool name:
 *   1. Name matches a known built-in executor → run it (config loaded from DB)
 *   2. DB row has endpoint/url in config      → HTTP dispatch
 *   3. No handler found                       → structured terminal error
 *
 * No separate builtins.ts file is needed.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink, readdir, mkdir } from 'node:fs/promises';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import db from '../db/client.js';
import { tavily } from '@tavily/core';
import { config as appConfig } from '../config.js';
import { glob } from 'glob';

const execAsync = promisify(exec);
const DOCS_DIR = join(homedir(), 'Documents');

// Normalize allowed_dirs: the frontend config editor saves values as plain strings.
// Handles: real string[], single path string, JSON-encoded array, comma-separated paths.
function normalizeAllowedDirs(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return (raw as string[]).map(s => s.trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x: unknown) => String(x).trim()).filter(Boolean);
      if (typeof parsed === 'string') return [parsed.trim()];
    } catch { /* not JSON */ }
    return s.split(',').map(x => x.trim()).filter(Boolean);
  }
  return [];
}

// Resolves a requested path within allowed dirs, strips redundant prefixes, auto-creates dirs.
function resolveSafePath(requestedPath: string, rawAllowedDirs: unknown): string {
  const allowedDirs = normalizeAllowedDirs(rawAllowedDirs);
  const safeRoot = allowedDirs[0] || DOCS_DIR;

  let cleanPath = requestedPath.replace(/\\/g, '/');
  // Strip redundant root folder prefix (e.g. "UserData/file.txt" -> "file.txt" when root is UserData)
  const rootBasename = basename(safeRoot).toLowerCase();
  if (cleanPath.toLowerCase().startsWith(`${rootBasename}/`)) {
    cleanPath = cleanPath.substring(rootBasename.length + 1);
  }
  // Strip "Documents/" prefix that LLMs often prepend from training data knowledge
  if (cleanPath.toLowerCase().startsWith('documents/')) {
    cleanPath = cleanPath.substring('documents/'.length);
  }

  const abs = isAbsolute(cleanPath) ? cleanPath : join(safeRoot, cleanPath);
  const finalAllowed = allowedDirs.length > 0 ? allowedDirs : [DOCS_DIR];
  const isAllowed = finalAllowed.some(d => abs.startsWith(d));

  if (!isAllowed) {
    throw new Error(`Access denied: "${requestedPath}" resolved to "${abs}" — outside allowed dirs (${finalAllowed.join(', ')}).`);
  }
  return abs;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

type Args   = Record<string, unknown>;
type Config = Record<string, unknown>;
type Result = Record<string, unknown>;
type Executor = (args: Args, config: Config, signal?: AbortSignal) => Promise<Result>;

export interface ToolDefinitionEntry {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  defaultConfig: Config;
  executor: Executor;
}

// ─── Built-in Executors ────────────────────────────────────────────────────────

const execWebSearch: Executor = async (args, config, signal) => {
  const query      = args.query as string;
  const numResults = Math.min(Math.max((args.num_results as number) ?? 5, 1), 10);
  
  // Extract API key from tool DB config or environment
  const apiKey = (config.tavily_api_key as string) || appConfig.tools.tavilyApiKey;

  if (!apiKey) {
    return {
      error: 'terminal',
      message: 'Tavily API key is not configured. Add "tavily_api_key" to the web_search tool config in the UI, or set TAVILY_API_KEY in the .env file.',
      query,
    };
  }

  try {
    if (signal?.aborted) throw new Error('Aborted');
    const tvly = tavily({ apiKey });
    const response = await tvly.search(query, {
      maxResults: numResults,
      searchDepth: 'advanced',
      includeAnswer: true
    });

    const results: string[] = [];
    if (response.answer) {
      results.push(`Answer: ${response.answer}`);
    }

    if (response.results && response.results.length > 0) {
      const snippets = response.results.map((r: any) => `[Source: ${r.url}]\n${r.content}`);
      results.push(...snippets);
    }

    if (results.length === 0) {
      return {
        error: 'terminal',
        query,
        results: [],
        message: 'No results found for this query via Tavily. Proceed using training data if possible.',
      };
    }

    return { 
      query, 
      answer: response.answer, 
      results: results.slice(0, numResults + 1), 
      result_count: results.length 
    };

  } catch (e: any) {
    return {
      error: 'terminal',
      message: `Tavily Search API failed: ${e.message}`,
      query,
    };
  }
};

const execHttpRequest: Executor = async (args, config, signal) => {
  const { url, method = 'GET', body, headers: extraHeaders = {} } = args as any;
  const timeout = (config.max_timeout_ms as number) ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(extraHeaders as Record<string, string>) },
      body: !['GET', 'HEAD'].includes(method) && body ? body : undefined,
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep as text */ }
    return {
      status: res.status, ok: res.ok, body: parsed as Result,
      ...(res.ok ? {} : { error: 'recoverable', message: `HTTP ${res.status} — check URL, auth headers, and request body.` }),
    };
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { error: 'recoverable', message: `Request timed out after ${timeout}ms.`, url };
    }
    return { error: 'terminal', message: e.message, url };
  } finally {
    clearTimeout(timer);
  }
};

const execCalculator: Executor = async (args, _config, _signal) => {
  const expr = (args.expression as string).trim();
  const safe = expr.replace(/[^0-9+\-*/().,%^Math.sqrtpowfloorscielabsPI\s]/g, '');
  if (safe !== expr) {
    return { error: 'recoverable', message: 'Expression contains disallowed characters. Use numbers and: + - * / . % ^ ( ) Math functions.', expression: expr };
  }
  try {
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${safe})`)() as number;
    if (!Number.isFinite(result)) {
      return { error: 'recoverable', message: 'Expression resulted in Infinity or NaN. Check for division by zero.', expression: expr };
    }
    return { expression: expr, result, result_type: typeof result };
  } catch (e: any) {
    return { error: 'recoverable', message: `Syntax error: ${e.message}`, expression: expr };
  }
};

const execReadFile: Executor = async (args, config, _signal) => {
  const requestedPath = args.path as string;
  const encoding   = (args.encoding as BufferEncoding) ?? 'utf-8';
  const maxChars   = (args.max_chars as number) ?? 8000;
  try {
    const filePath = resolveSafePath(requestedPath, config.allowed_dirs);
    console.log(`[ToolRegistry] 📂 read_file: ${filePath}`);
    const content  = await readFile(filePath, { encoding });
    const truncated = content.length > maxChars;
    return {
      path: requestedPath, resolved_path: filePath,
      content: truncated ? content.slice(0, maxChars) : content,
      size: content.length, truncated,
      ...(truncated ? { note: `Truncated at ${maxChars} chars.` } : {}),
    };
  } catch (e: any) {
    return { error: 'recoverable', message: e.message, path: requestedPath };
  }
};

const execWriteFile: Executor = async (args, config, _signal) => {
  const requestedPath = args.path as string;
  const content = args.content as string;
  try {
    const filePath = resolveSafePath(requestedPath, config.allowed_dirs);
    console.log(`[ToolRegistry] 💾 write_file: ${filePath}`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return { path: requestedPath, resolved_path: filePath, bytes_written: Buffer.byteLength(content, 'utf-8'), success: true };
  } catch (e: any) {
    return { error: 'recoverable', message: e.message, path: requestedPath };
  }
};

const execDeleteFile: Executor = async (args, config, _signal) => {
  const requestedPath = args.path as string;
  try {
    const filePath = resolveSafePath(requestedPath, config.allowed_dirs);
    console.log(`[ToolRegistry] 🗑️ delete_file: ${filePath}`);
    await unlink(filePath);
    return { path: requestedPath, resolved_path: filePath, deleted: true };
  } catch (e: any) {
    return { error: 'recoverable', message: e.message, path: requestedPath };
  }
};

const execListDirectory: Executor = async (args, config, _signal) => {
  const requestedPath = args.path as string;
  try {
    const dirPath = resolveSafePath(requestedPath, config.allowed_dirs);
    console.log(`[ToolRegistry] 📁 list_directory: ${dirPath}`);
    const entries = await readdir(dirPath, { withFileTypes: true });
    return {
      path: requestedPath, resolved_path: dirPath,
      entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other' })),
    };
  } catch (e: any) {
    return { error: 'recoverable', message: e.message, path: requestedPath };
  }
};

const execFindFiles: Executor = async (args, config, _signal) => {
  const pattern = args.pattern as string;
  const allowedDirs = normalizeAllowedDirs(config.allowed_dirs);
  const safeRoot = allowedDirs[0] || DOCS_DIR;
  try {
    const matches = await glob(pattern, { cwd: safeRoot, absolute: true, nodir: true });
    return { root: safeRoot, pattern, matches: matches.slice(0, 100), count: matches.length };
  } catch (e: any) {
    return { error: 'recoverable', message: `Find failed: ${e.message}` };
  }
};

const execSearchFiles: Executor = async (args, config, signal) => {
  const regexQuery = args.query as string;
  const pattern = (args.file_pattern as string) || '**/*.*';
  const allowedDirs = normalizeAllowedDirs(config.allowed_dirs);
  const safeRoot = allowedDirs[0] || DOCS_DIR;
  try {
    const files = await glob(pattern, { cwd: safeRoot, absolute: true, nodir: true, ignore: 'node_modules/**' });
    const regex = new RegExp(regexQuery, 'gi');
    const results: { file: string; line: number; content: string }[] = [];
    for (const file of files.slice(0, 200)) {
      if (signal?.aborted) break;
      try {
        const text = await readFile(file, 'utf-8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (signal?.aborted) break;
          if (regex.test(lines[i])) {
            results.push({ file, line: i + 1, content: lines[i].trim() });
            if (results.length >= 100) break;
          }
        }
      } catch { /* ignore */ }
      if (results.length >= 100) break;
    }
    return { query: regexQuery, root: safeRoot, results, count: results.length };
  } catch (e: any) {
    return { error: 'recoverable', message: `Search failed: ${e.message}` };
  }
};

const execRunCommand: Executor = async (args, config, signal) => {
  const command     = args.command as string;
  const cwd         = (args.cwd as string) || process.cwd();
  const timeout     = (config.timeout_ms as number) ?? 15000;
  const allowedCmds = (config.allowed_commands as string[]) ?? [];
  if (allowedCmds.length > 0) {
    const prefix = command.trim().split(' ')[0];
    if (!allowedCmds.includes(prefix)) {
      return { error: 'terminal', message: `Command "${prefix}" is blocked. Add it to allowed_commands in tool config.`, command };
    }
  }
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout, signal });
    return { command, cwd, stdout: stdout.trim(), stderr: stderr.trim(), success: true };
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { error: 'recoverable', message: 'Command was aborted/killed.', command };
    }
    return { error: 'recoverable', message: `Command failed: ${e.message}`, command, stdout: e.stdout?.trim() ?? '', stderr: e.stderr?.trim() ?? '', success: false };
  }
};

const execGetDatetime: Executor = async (args, _config, _signal) => {
  const fmt = (args.format as string) ?? 'iso';
  const tz  = (args.timezone as string) ?? 'UTC';
  try {
    const now = new Date();
    const datetime: string | number = (() => {
      switch (fmt) {
        case 'unix':  return now.getTime();
        case 'human': return now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
        case 'utc':   return now.toUTCString();
        default:      return now.toISOString();
      }
    })();
    return { datetime, format: fmt, timezone: tz };
  } catch {
    return { error: 'recoverable', message: `Invalid timezone "${tz}". Use a valid IANA string like "UTC" or "Asia/Kolkata".` };
  }
};

// ─── Built-in Tool Definitions ─────────────────────────────────────────────────
// These are seeded into the DB on startup. They live in the DB just like any
// user-created tool — the executor is resolved by name at runtime.

const BUILT_IN_TOOLS: ToolDefinitionEntry[] = [
  {
    name: 'web_search',
    description:
      'Use when you need current facts, news, or deep information not in your training data. ' +
      'Powered by Tavily Search API. Returns ranked relevant snippets and deep answers. Do NOT use for URL fetching — use http_request for that.',
    schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Specific search query. Be precise.' },
        num_results: { type: 'number', description: 'Results to return (1–10). Default: 5.', default: 5, minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
    defaultConfig: { tavily_api_key: '' },
    executor: execWebSearch,
  },
  {
    name: 'http_request',
    description:
      'Use to call external REST APIs when you have a specific URL. Returns status, ok flag, and parsed response body. ' +
      'Do NOT use for web search — use web_search for that.',
    schema: {
      type: 'object',
      properties: {
        url:     { type: 'string', description: 'Full URL including protocol (https://…).' },
        method:  { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method. Default: GET.', default: 'GET' },
        body:    { type: 'string', description: 'JSON-encoded body for POST/PUT/PATCH.' },
        headers: { type: 'object', description: 'Additional headers as key-value pairs.', additionalProperties: { type: 'string' } },
      },
      required: ['url'],
    },
    defaultConfig: { max_timeout_ms: 10000 },
    executor: execHttpRequest,
  },
  {
    name: 'calculator',
    description:
      'Use for precise arithmetic and algebra when exact computation matters. ' +
      'Supports +, -, *, /, %, **, Math.sqrt, Math.pow, Math.floor, Math.ceil, Math.abs, Math.PI. ' +
      'Do NOT use for symbolic math or unit conversion.',
    schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JS math expression. e.g. "2 + 2 * 10", "Math.sqrt(144)".' },
      },
      required: ['expression'],
    },
    defaultConfig: {},
    executor: execCalculator,
  },
  {
    name: 'read_file',
    description:
      'Use to read the contents of a file from disk. Returns content and size. ' +
      'Large files are truncated — check the truncated flag. Use absolute paths when possible.',
    schema: {
      type: 'object',
      properties: {
        path:      { type: 'string', description: 'File path — absolute or relative to server working directory.' },
        encoding:  { type: 'string', enum: ['utf-8', 'base64', 'hex'], description: 'File encoding. Default: utf-8.', default: 'utf-8' },
        max_chars: { type: 'number', description: 'Truncate at this many characters. Default: 8000.', default: 8000 },
      },
      required: ['path'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execReadFile,
  },
  {
    name: 'write_file',
    description: 'Use to create or overwrite a file with new content. Returns bytes written.',
    schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path to write.' },
        content: { type: 'string', description: 'Full text content to write.' },
      },
      required: ['path', 'content'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execWriteFile,
  },
  {
    name: 'delete_file',
    description: 'Use to permanently delete a file from the file system.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to delete.' },
      },
      required: ['path'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execDeleteFile,
  },
  {
    name: 'list_directory',
    description: 'Use to list the contents of a directory (like ls).',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list.' },
      },
      required: ['path'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execListDirectory,
  },
  {
    name: 'find_files',
    description: 'Use to find files by glob pattern (e.g. "**/*.ts").',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to search.' },
        cwd:     { type: 'string', description: 'Directory to search within.' },
      },
      required: ['pattern'],
    },
    defaultConfig: {},
    executor: execFindFiles,
  },
  {
    name: 'search_files',
    description: 'Use to search for content inside files using Regex (grep equivalent). Skips node_modules.',
    schema: {
      type: 'object',
      properties: {
        query:        { type: 'string', description: 'Regex query to find.' },
        file_pattern: { type: 'string', description: 'Glob pattern for files to check. Default: **/*.*' },
        cwd:          { type: 'string', description: 'Directory to search within.' },
      },
      required: ['query'],
    },
    defaultConfig: {},
    executor: execSearchFiles,
  },
  {
    name: 'run_command',
    description:
      'Use to run shell commands and capture stdout/stderr. Enable only for trusted agents. ' +
      'Prefer idempotent read-only commands when possible.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Full shell command string.' },
        cwd:     { type: 'string', description: 'Working directory. Defaults to server cwd.' },
      },
      required: ['command'],
    },
    defaultConfig: { timeout_ms: 15000, allowed_commands: [] },
    executor: execRunCommand,
  },
  {
    name: 'get_datetime',
    description:
      'Use when you need the current timestamp. Returns datetime in the requested format and timezone. ' +
      'Prefer "iso" for machine use, "human" for user-facing output.',
    schema: {
      type: 'object',
      properties: {
        format:   { type: 'string', enum: ['iso', 'unix', 'human', 'utc'], description: 'Output format.', default: 'iso' },
        timezone: { type: 'string', description: 'IANA timezone e.g. "Asia/Kolkata". Default: UTC.', default: 'UTC' },
      },
      required: [],
    },
    defaultConfig: {},
    executor: execGetDatetime,
  },
];

// ─── Executor map (name → function) ───────────────────────────────────────────
const EXECUTOR_MAP = new Map<string, Executor>(
  BUILT_IN_TOOLS.map(t => [t.name, t.executor])
);

// ─── ToolRegistry ──────────────────────────────────────────────────────────────

export class ToolRegistry {
  /**
   * Seed built-in tools into the DB if they don't already exist.
   * Called once on server startup. Safe to call multiple times (idempotent).
   */
  static async seed(): Promise<void> {
    for (const tool of BUILT_IN_TOOLS) {
      await db.query(
        `INSERT INTO tools (name, description, schema, config, is_enabled)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (name) DO NOTHING`,
        [tool.name, tool.description, JSON.stringify(tool.schema), JSON.stringify(tool.defaultConfig)]
      );
    }
    console.log(`[ToolRegistry] Seeded ${BUILT_IN_TOOLS.length} built-in tools.`);
  }

  /**
   * Expose the catalog for the tools list endpoint — adds is_builtin metadata.
   */
  static getBuiltInNames(): Set<string> {
    return new Set(BUILT_IN_TOOLS.map(t => t.name));
  }

  /**
   * Execute a tool by name.
   * Config is always loaded from the DB so user edits take effect immediately.
   */
  static async execute(
    toolName: string,
    args: Args,
    _agentId?: string,
    signal?: AbortSignal
  ): Promise<Result> {
    const argsStr = JSON.stringify(args);
    console.log(`[ToolRegistry] 🔧 Executing "${toolName}" with args: ${argsStr.length > 500 ? argsStr.slice(0, 500) + '...' : argsStr}`);

    // Load tool row from DB
    const { rows } = await db.query(
      `SELECT name, config, is_enabled FROM tools WHERE name = $1 LIMIT 1`,
      [toolName]
    );

    if (rows.length === 0) {
      return {
        error: 'terminal',
        tool: toolName,
        message: `Tool "${toolName}" is not registered. Add it via the Tools page.`,
      };
    }

    const row = rows[0];
    if (!row.is_enabled) {
      return {
        error: 'terminal',
        tool: toolName,
        message: `Tool "${toolName}" is disabled. Enable it on the Tools page.`,
      };
    }

    const config: Config =
      typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {});

    // ── 1. Known built-in executor ────────────────────────────────────────────
    const executor = EXECUTOR_MAP.get(toolName);
    if (executor) {
      try {
        return await executor(args, config, signal);
      } catch (e: any) {
        console.error(`[ToolRegistry] Built-in "${toolName}" threw:`, e);
        return {
          error: 'recoverable',
          tool: toolName,
          message: `Tool execution failed: ${e.message}. This may be transient — retry or check config.`,
        };
      }
    }

    // ── 2. HTTP endpoint tool ─────────────────────────────────────────────────
    const endpoint = (config.endpoint ?? config.url ?? config.base_url) as string | undefined;
    if (endpoint) {
      const method  = (config.method as string) ?? 'POST';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.auth_token) headers['Authorization'] = `Bearer ${config.auth_token}`;
      const timeout = (config.timeout_ms as number) ?? 10000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res  = await fetch(endpoint, {
          method, headers,
          body: method !== 'GET' ? JSON.stringify(args) : undefined,
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        });
        const text = await res.text();
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        return {
          status: res.status, ok: res.ok, body: parsed as Result,
          ...(res.ok ? {} : { error: 'recoverable', message: `Endpoint returned HTTP ${res.status}. Check endpoint and auth_token in tool config.` }),
        };
      } catch (e: any) {
        if (e.name === 'AbortError') {
          return { error: 'recoverable', tool: toolName, message: `HTTP tool timed out after ${timeout}ms.` };
        }
        return { error: 'recoverable', tool: toolName, message: `HTTP request failed: ${e.message}` };
      } finally {
        clearTimeout(timer);
      }
    }

    // ── 3. No handler ─────────────────────────────────────────────────────────
    return {
      error: 'terminal',
      tool: toolName,
      message:
        `Tool "${toolName}" has no executor. ` +
        `Add an "endpoint" key to its config for HTTP tools, ` +
        `or use a built-in name (web_search, calculator, http_request, read_file, write_file, run_command, get_datetime).`,
    };
  }
}
