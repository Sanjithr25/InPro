/**
 * Built-in Tool Catalog
 * ─────────────────────────────────────────────────────────────────────────────
 * Defines preset tool definitions that users can install into their workspace.
 * Each entry includes:
 *  - identity (name, description, category)
 *  - JSON Schema for LLM function-calling parameters
 *  - default config (API keys, base URLs, etc.)
 *  - actual execute() handler used by ToolRegistry
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const execAsync = promisify(exec);

export type BuiltInCategory = 'Search' | 'Files' | 'System' | 'Math & Data' | 'Network';

export interface BuiltInTool {
  name: string;
  category: BuiltInCategory;
  description: string;
  /**
   * JSON Schema for the tool's input — passed to the LLM as function spec.
   * Must be a valid JSON Schema object with "type": "object" and "properties".
   */
  schema: Record<string, unknown>;
  /** Default config stored in tools.config */
  defaultConfig: Record<string, unknown>;
  /** Icon (emoji) for the gallery */
  icon: string;
  /** Short tagline for the gallery card */
  tagline: string;
  /** The actual runtime handler */
  execute: (args: Record<string, unknown>, config: Record<string, unknown>) => Promise<unknown>;
}

// ─── Implementations ──────────────────────────────────────────────────────────

const webSearchTool: BuiltInTool = {
  name: 'web_search',
  category: 'Search',
  icon: '🔍',
  tagline: 'Search the web with DuckDuckGo (no API key needed)',
  description: 'Search the web and return relevant results. Use this to find current information, news, or facts.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query to look up.' },
      num_results: { type: 'number', description: 'Number of results to return (default: 5)', default: 5 },
    },
    required: ['query'],
  },
  defaultConfig: {
    provider: 'duckduckgo',
  },
  async execute(args) {
    const query = args.query as string;
    const numResults = (args.num_results as number) ?? 5;
    // DuckDuckGo Instant Answers API (no key, CORS-friendly from server)
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'InPro-Agent/1.0' } });
    const data = await res.json() as any;

    const results: string[] = [];

    if (data.AbstractText) results.push(`Summary: ${data.AbstractText}`);
    if (data.Answer) results.push(`Answer: ${data.Answer}`);

    const related = (data.RelatedTopics ?? [])
      .slice(0, numResults)
      .map((r: any) => r.Text ?? r.Result ?? '')
      .filter(Boolean);

    results.push(...related);

    if (results.length === 0) {
      return { query, results: [], note: 'No instant results found. Try a more specific query.' };
    }
    return { query, results: results.slice(0, numResults) };
  },
};

const httpRequestTool: BuiltInTool = {
  name: 'http_request',
  category: 'Network',
  icon: '🌐',
  tagline: 'Make HTTP requests to any API endpoint',
  description: 'Make an HTTP request to a URL. Supports GET, POST, PUT, DELETE. Returns response body.',
  schema: {
    type: 'object',
    properties: {
      url:     { type: 'string',  description: 'The URL to request.' },
      method:  { type: 'string',  description: 'HTTP method: GET, POST, PUT, DELETE', default: 'GET' },
      body:    { type: 'string',  description: 'Request body (JSON string) for POST/PUT.' },
      headers: { type: 'object',  description: 'Additional HTTP headers as key-value pairs.' },
    },
    required: ['url'],
  },
  defaultConfig: {
    max_timeout_ms: 10000,
  },
  async execute(args, config) {
    const { url, method = 'GET', body, headers: extraHeaders = {} } = args as any;
    const timeout = (config.max_timeout_ms as number) ?? 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(extraHeaders as Record<string, string>) },
        body: method !== 'GET' && body ? body : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep as text */ }
      return { status: res.status, ok: res.ok, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  },
};

const calculatorTool: BuiltInTool = {
  name: 'calculator',
  category: 'Math & Data',
  icon: '🧮',
  tagline: 'Evaluate mathematical expressions safely',
  description: 'Evaluate a mathematical expression and return the result. Use for arithmetic, algebra, percentages, etc.',
  schema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'The mathematical expression to evaluate, e.g. "2 + 2 * 10" or "Math.sqrt(144)"' },
    },
    required: ['expression'],
  },
  defaultConfig: {},
  async execute(args) {
    const expr = (args.expression as string).trim();
    // Allowlist-based safe evaluator — strips dangerous tokens
    const safe = expr.replace(/[^0-9+\-*/().,%^Math.sqrtpiwlogsincostan\s]/g, '');
    if (safe !== expr) {
      throw new Error(`Unsafe expression blocked: "${expr}"`);
    }
    // Use Function constructor in a restricted scope
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${safe})`)() as number;
    if (!Number.isFinite(result)) throw new Error('Expression resulted in Infinity or NaN');
    return { expression: expr, result };
  },
};

const readFileTool: BuiltInTool = {
  name: 'read_file',
  category: 'Files',
  icon: '📄',
  tagline: 'Read file contents from disk',
  description: 'Read and return the contents of a file. Specify the file path relative to the working directory or as an absolute path.',
  schema: {
    type: 'object',
    properties: {
      path:     { type: 'string', description: 'The file path to read. Can be absolute or relative to cwd.' },
      encoding: { type: 'string', description: 'File encoding, default: utf-8', default: 'utf-8' },
    },
    required: ['path'],
  },
  defaultConfig: {
    allowed_dirs: [],  // empty = allow all; fill with allowed directories for safety
  },
  async execute(args, config) {
    const filePath = args.path as string;
    const encoding = (args.encoding as BufferEncoding) ?? 'utf-8';
    const allowedDirs = config.allowed_dirs as string[];

    if (allowedDirs.length > 0) {
      const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
      const allowed = allowedDirs.some(d => abs.startsWith(d));
      if (!allowed) throw new Error(`Access denied: ${filePath} is outside allowed directories.`);
    }

    const content = await readFile(filePath, { encoding });
    return { path: filePath, content, size: content.length };
  },
};

const writeFileTool: BuiltInTool = {
  name: 'write_file',
  category: 'Files',
  icon: '💾',
  tagline: 'Write or create a file on disk',
  description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does.',
  schema: {
    type: 'object',
    properties: {
      path:    { type: 'string', description: 'The file path to write to.' },
      content: { type: 'string', description: 'The text content to write.' },
    },
    required: ['path', 'content'],
  },
  defaultConfig: {
    allowed_dirs: [],
  },
  async execute(args, config) {
    const filePath = args.path as string;
    const content  = args.content as string;
    const allowedDirs = config.allowed_dirs as string[];

    if (allowedDirs.length > 0) {
      const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
      const allowed = allowedDirs.some(d => abs.startsWith(d));
      if (!allowed) throw new Error(`Access denied: ${filePath} is outside allowed directories.`);
    }

    await writeFile(filePath, content, 'utf-8');
    return { path: filePath, bytes_written: Buffer.byteLength(content, 'utf-8'), success: true };
  },
};

const runCommandTool: BuiltInTool = {
  name: 'run_command',
  category: 'System',
  icon: '💻',
  tagline: 'Execute shell commands on the host system',
  description: 'Run a shell command and return its stdout/stderr. Use with caution — only enable for trusted agents.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      cwd:     { type: 'string', description: 'Working directory for the command (optional).' },
    },
    required: ['command'],
  },
  defaultConfig: {
    timeout_ms: 15000,
    allowed_commands: [],  // empty = allow all; fill with command prefixes (e.g. ["git", "ls", "npm"])
  },
  async execute(args, config) {
    const command = args.command as string;
    const cwd = (args.cwd as string) || process.cwd();
    const timeout = (config.timeout_ms as number) ?? 15000;
    const allowedCmds = config.allowed_commands as string[];

    if (allowedCmds.length > 0) {
      const prefix = command.trim().split(' ')[0];
      if (!allowedCmds.includes(prefix)) {
        throw new Error(`Command "${prefix}" is not in the allowed commands list.`);
      }
    }

    const { stdout, stderr } = await execAsync(command, { cwd, timeout });
    return { command, stdout: stdout.trim(), stderr: stderr.trim(), success: true };
  },
};

const getDatetimeTool: BuiltInTool = {
  name: 'get_datetime',
  category: 'System',
  icon: '🕒',
  tagline: 'Get the current date and time',
  description: 'Return the current date and time in various formats. Useful for time-sensitive tasks.',
  schema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        description: 'Format: "iso" (default), "unix", "human", or "utc"',
        enum: ['iso', 'unix', 'human', 'utc'],
        default: 'iso',
      },
      timezone: { type: 'string', description: 'IANA timezone string, e.g. "Asia/Kolkata"' },
    },
    required: [],
  },
  defaultConfig: {},
  async execute(args) {
    const fmt = (args.format as string) ?? 'iso';
    const tz  = (args.timezone as string) ?? 'UTC';
    const now = new Date();
    const formatted = (() => {
      switch (fmt) {
        case 'unix':  return now.getTime();
        case 'human': return now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
        case 'utc':   return now.toUTCString();
        default:      return now.toISOString();
      }
    })();
    return { datetime: formatted, format: fmt, timezone: tz };
  },
};

// ─── Export catalog ───────────────────────────────────────────────────────────

export const BUILT_IN_TOOLS: BuiltInTool[] = [
  webSearchTool,
  httpRequestTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  runCommandTool,
  getDatetimeTool,
];

export const BUILT_IN_TOOL_MAP = new Map<string, BuiltInTool>(
  BUILT_IN_TOOLS.map(t => [t.name, t])
);
