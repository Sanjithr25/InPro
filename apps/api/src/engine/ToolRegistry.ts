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
import Exa from 'exa-js';
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
  group: string;
  schema: Record<string, unknown>;
  defaultConfig: Config;
  executor: Executor;
}

// ─── Built-in Executors ────────────────────────────────────────────────────────

const execExaSearch: Executor = async (args, config, signal) => {
  const query      = args.query as string;
  const numResults = Math.min(Math.max((args.num_results as number) ?? 5, 1), 10);
  const apiKey = (config.exa_api_key as string) || appConfig.tools.exaApiKey;

  if (!apiKey) {
    return { error: 'terminal', message: 'Exa API key missing. Add "exa_api_key" to tool config or set EXA_API_KEY env.', query };
  }

  try {
    if (signal?.aborted) throw new Error('Aborted');
    const ExaClass = (Exa as any).default || Exa;
    const exa = new ExaClass(apiKey);
    
    const response = await exa.searchAndContents(query, {
      type: 'auto',
      numResults,
      text: { maxCharacters: 15000 }
    });

    const results = (response.results || []).map((r: any) => ({
      url: r.url,
      title: r.title,
      content: r.text || r.highlights?.[0] || 'No content found.',
    }));

    const snippets = results.map((r: any) => `[Source: ${r.url}]\nTitle: ${r.title}\n${r.content.slice(0, 4000)}`);

    return { query, provider: 'Exa', results: snippets, result_count: results.length };
  } catch (e: any) {
    if (e.message === 'Aborted') throw e;
    return { error: 'terminal', message: `Exa Search failed: ${e.message}`, query };
  }
};

const execTavilySearch: Executor = async (args, config, signal) => {
  const query      = args.query as string;
  const numResults = Math.min(Math.max((args.num_results as number) ?? 5, 1), 10);
  const apiKey = (config.tavily_api_key as string) || appConfig.tools.tavilyApiKey;

  if (!apiKey) {
    return { error: 'terminal', message: 'Tavily API key missing. Add "tavily_api_key" to tool config or set TAVILY_API_KEY env.', query };
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
    if (response.answer) results.push(`Answer: ${response.answer}`);
    if (response.results?.length) {
      const snippets = response.results.map((r: any) => `[Source: ${r.url}]\n${r.content}`);
      results.push(...snippets);
    }

    return { 
      query, provider: 'Tavily', answer: response.answer, 
      results: results.slice(0, numResults + 1), result_count: results.length 
    };
  } catch (e: any) {
    if (e.message === 'Aborted') throw e;
    return { error: 'terminal', message: `Tavily Search failed: ${e.message}`, query };
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
    name: 'exa_search',
    description: 'Neural web search by Exa. Great for finding relevant code, papers, and deep content. Returns full text snippets.',
    group: 'Web Search',
    schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Specific search query.' },
        num_results: { type: 'number', description: 'Results count (1-10).', default: 5 },
      },
      required: ['query'],
    },
    defaultConfig: { exa_api_key: '' },
    executor: execExaSearch,
  },
  {
    name: 'tavily_search',
    description: 'Web search optimized for LLMs. Returns ranked snippets and synthetic answers.',
    group: 'Web Search',
    schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Specific search query.' },
        num_results: { type: 'number', description: 'Results count (1-10).', default: 5 },
      },
      required: ['query'],
    },
    defaultConfig: { tavily_api_key: '' },
    executor: execTavilySearch,
  },
  {
    name: 'http_request',
    description:
      'Use to call external REST APIs when you have a specific URL. Returns status, ok flag, and parsed response body. ' +
      'Do NOT use for web search — use web_search for that.',
    group: 'Built-in Utils',
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
    group: 'Built-in Utils',
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
      'Reads content from a text file. Supports line-range partial reads. ' +
      'Useful for analyzing large scripts or logs.',
    group: 'File System',
    schema: {
      type: 'object',
      properties: {
        path:      { type: 'string', description: 'Absolute path to file.' },
        encoding:  { type: 'string', enum: ['utf-8', 'ascii', 'base64'], description: 'Default: utf-8.', default: 'utf-8' },
        max_chars: { type: 'number', description: 'Limit read size to prevent context overflow. Default: 8000.' },
      },
      required: ['path'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execReadFile,
  },
  {
    name: 'write_file',
    description: 'Creates or overwrites a file with content. Parent directories are created automatically.',
    group: 'File System',
    schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Absolute path to write.' },
        content: { type: 'string', description: 'Text or code to save.' },
      },
      required: ['path', 'content'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execWriteFile,
  },
  {
    name: 'delete_file',
    description: 'Permanently deletes a file from disk. Use with caution.',
    group: 'File System',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to delete.' },
      },
      required: ['path'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execDeleteFile,
  },
  {
    name: 'list_directory',
    description: 'Lists all files and subdirectories in a folder. Use to explore the workspace structure.',
    group: 'File System',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the directory.' },
      },
      required: ['path'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execListDirectory,
  },
  {
    name: 'find_files',
    description: 'Searches for files matching a glob pattern (e.g. "**/*.js") starting from a root directory.',
    group: 'File System',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/test_*").' },
        cwd:     { type: 'string', description: 'Search root path. Default: current directory.' },
      },
      required: ['pattern'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execFindFiles,
  },
  {
    name: 'search_files',
    description: 'Grep-like search across files. Finds lines matching a regex pattern inside the file content.',
    group: 'File System',
    schema: {
      type: 'object',
      properties: {
        query:        { type: 'string', description: 'Regex pattern to search for.' },
        file_pattern: { type: 'string', description: 'File pattern filter. Default: **/*.*' },
        cwd:          { type: 'string', description: 'Search root path.' },
      },
      required: ['query'],
    },
    defaultConfig: { allowed_dirs: [] },
    executor: execSearchFiles,
  },
  {
    name: 'run_command',
    description: 'Executes a shell command on the host. Highly powerful — only use commands you know are safe.',
    group: 'Built-in Utils',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd:     { type: 'string', description: 'Working directory for the command.' },
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
    group: 'Built-in Utils',
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
// Support legacy web_search by mapping it to tavily_search
EXECUTOR_MAP.set('web_search', execTavilySearch);

// ─── ToolRegistry ──────────────────────────────────────────────────────────────

export class ToolRegistry {
  /**
   * Seed built-in tools into the DB if they don't already exist.
   * Called once on server startup. Safe to call multiple times (idempotent).
   */
  static async seed(): Promise<void> {
    // 1. Cleanup redundant/legacy tools
    const redundant = ['web_search', 'websearch', 'exa', 'tavilly'];
    for (const name of redundant) {
      await db.query(`DELETE FROM tools WHERE name = $1`, [name]);
    }

    // 2. Seed active built-in tools
    for (const tool of BUILT_IN_TOOLS) {
      await db.query(
        `INSERT INTO tools (name, description, schema, config, tool_group, is_enabled)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (name) DO UPDATE SET
            description = EXCLUDED.description,
            schema = EXCLUDED.schema,
            tool_group = EXCLUDED.tool_group`,
        [tool.name, tool.description, JSON.stringify(tool.schema), JSON.stringify(tool.defaultConfig), tool.group]
      );
    }
    console.log(`[ToolRegistry] Seeded ${BUILT_IN_TOOLS.length} built-in tools (Cleaned redundant search tools).`);
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
    signal?: AbortSignal,
    isDryRun?: boolean
  ): Promise<Result> {
    const startTime = Date.now();
    const dryRunPrefix = isDryRun ? '(dry-run) ' : '';
    const argsStr = JSON.stringify(args);
    const argsPreview = argsStr.length > 200 ? argsStr.slice(0, 200) + '...' : argsStr;
    
    console.log(`[ToolRegistry] START ${dryRunPrefix}"${toolName}" | args: ${argsPreview}`);

    // Load tool row from DB
    const { rows } = await db.query(
      `SELECT name, config, is_enabled, risk_level FROM tools WHERE name = $1 LIMIT 1`,
      [toolName]
    );

    if (rows.length === 0) {
      const duration = Date.now() - startTime;
      console.log(`[ToolRegistry] END ${dryRunPrefix}"${toolName}" (${duration}ms, failed: not registered)`);
      return {
        error: 'terminal',
        tool: toolName,
        message: `Tool "${toolName}" is not registered. Add it via the Tools page.`,
      };
    }

    const row = rows[0];
    if (!row.is_enabled) {
      const duration = Date.now() - startTime;
      console.log(`[ToolRegistry] END ${dryRunPrefix}"${toolName}" (${duration}ms, failed: disabled)`);
      return {
        error: 'terminal',
        tool: toolName,
        message: `Tool "${toolName}" is disabled. Enable it on the Tools page.`,
      };
    }

    // Check risk level for dry runs
    if (isDryRun && row.risk_level === 'high') {
      const duration = Date.now() - startTime;
      console.log(`[ToolRegistry] END ${dryRunPrefix}"${toolName}" (${duration}ms, blocked: high-risk in dry-run)`);
      return {
        error: 'terminal',
        tool: toolName,
        message: `High-risk tools are disabled during dry run. Tool "${toolName}" cannot be executed in dry run mode.`,
      };
    }

    const config: Config =
      typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {});

    let result: Result;
    let success = false;
    let errorType: string | undefined;

    try {
      // ── 1. Known built-in executor ────────────────────────────────────────────
      const executor = EXECUTOR_MAP.get(toolName);
      if (executor) {
        result = await executor(args, config, signal);
        success = !result.error;
        errorType = result.error as string | undefined;
      }
      // ── 2. HTTP endpoint tool ─────────────────────────────────────────────────
      else {
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
            result = {
              status: res.status, ok: res.ok, body: parsed as Result,
              ...(res.ok ? {} : { error: 'recoverable', message: `Endpoint returned HTTP ${res.status}. Check endpoint and auth_token in tool config.` }),
            };
            success = res.ok;
            errorType = res.ok ? undefined : 'recoverable';
          } catch (e: any) {
            if (e.name === 'AbortError') {
              result = { error: 'recoverable', tool: toolName, message: `HTTP tool timed out after ${timeout}ms.` };
            } else {
              result = { error: 'recoverable', tool: toolName, message: `HTTP request failed: ${e.message}` };
            }
            success = false;
            errorType = 'recoverable';
          } finally {
            clearTimeout(timer);
          }
        }
        // ── 3. No handler ─────────────────────────────────────────────────────────
        else {
          result = {
            error: 'terminal',
            tool: toolName,
            message:
              `Tool "${toolName}" has no executor. ` +
              `Add an "endpoint" key to its config for HTTP tools, ` +
              `or use a built-in name (web_search, calculator, http_request, read_file, write_file, run_command, get_datetime).`,
          };
          success = false;
          errorType = 'terminal';
        }
      }
    } catch (e: any) {
      console.error(`[ToolRegistry] Built-in "${toolName}" threw:`, e);
      result = {
        error: 'recoverable',
        tool: toolName,
        message: `Tool execution failed: ${e.message}. This may be transient — retry or check config.`,
      };
      success = false;
      errorType = 'recoverable';
    }

    // Calculate output size
    const resultStr = JSON.stringify(result);
    const outputSize = resultStr.length;
    const outputPreview = outputSize > 500 ? `${(outputSize / 1024).toFixed(1)}KB` : `${outputSize}B`;
    
    const duration = Date.now() - startTime;
    const status = success ? 'success' : `failed: ${errorType}`;
    
    console.log(`[ToolRegistry] END ${dryRunPrefix}"${toolName}" (${duration}ms, ${status}, output: ${outputPreview})`);
    
    return result;
  }
}
