import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import db from '../db/client.js';
import { tavily } from '@tavily/core';
import Exa from 'exa-js';
import { config as appConfig } from '../config.js';
import { glob as globModule } from 'glob';

const execAsync = promisify(exec);
const DOCS_DIR = join(homedir(), 'Documents');

// Resolves a requested path asynchronously against the global setting `root_directory`.
async function resolveSafePath(requestedPath: string): Promise<string> {
  let safeRoot = DOCS_DIR;
  try {
    const { rows } = await db.query("SELECT setting_value FROM global_settings WHERE setting_key = 'root_directory'");
    if (rows.length > 0) {
      safeRoot = JSON.parse(rows[0].setting_value);
    }
  } catch (e) {
    // Fallback to docs dir
  }

  // Treat safeRoot as the only allowed directory
  const rootDirName = basename(safeRoot).toLowerCase();
  let cleanPath = requestedPath.replace(/\\/g, '/');

  // Strip arbitrary redundant folders LLMs might prefix
  if (cleanPath.toLowerCase().startsWith(`${rootDirName}/`)) {
    cleanPath = cleanPath.substring(rootDirName.length + 1);
  }
  if (cleanPath.toLowerCase().startsWith('documents/')) {
    cleanPath = cleanPath.substring('documents/'.length);
  }

  const abs = isAbsolute(cleanPath) ? cleanPath : join(safeRoot, cleanPath);

  if (!abs.startsWith(safeRoot)) {
    throw new Error(`Access denied: Path "${abs}" is outside the restricted root directory sandbox (${safeRoot}).`);
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
  defaultRisk: 'low' | 'high';
  executor: Executor;
}

// ─── Built-in Executors ────────────────────────────────────────────────────────

const execWebSearchExa: Executor = async (args, _config, signal) => {
  const query      = args.query as string;
  const numResults = Math.min(Math.max((args.num_results as number) ?? 5, 1), 10);
  const apiKey = appConfig.tools.exaApiKey;

  if (!apiKey) {
    return { error: 'terminal', message: 'Exa API key missing. Set EXA_API_KEY env.', query };
  }

  try {
    if (signal?.aborted) throw new Error('Aborted');
    const ExaClass = (Exa as any).default || Exa;
    const exa = new ExaClass(apiKey);
    
    const response = await exa.searchAndContents(query, {
      type: 'auto', numResults, text: { maxCharacters: 15000 }
    });

    const results = (response.results || []).map((r: any) => ({
      url: r.url, title: r.title, content: r.text || r.highlights?.[0] || 'No content found.',
    }));

    const snippets = results.map((r: any) => `[Source: ${r.url}]\nTitle: ${r.title}\n${r.content.slice(0, 4000)}`);
    return { query, provider: 'Exa', results: snippets, result_count: results.length };
  } catch (e: any) {
    if (e.message === 'Aborted') throw e;
    return { error: 'terminal', message: `Exa Search failed: ${e.message}`, query };
  }
};

const execWebSearchTavily: Executor = async (args, _config, signal) => {
  const query      = args.query as string;
  const numResults = Math.min(Math.max((args.num_results as number) ?? 5, 1), 10);
  const apiKey = appConfig.tools.tavilyApiKey;

  if (!apiKey) {
    return { error: 'terminal', message: 'Tavily API key missing. Set TAVILY_API_KEY env.', query };
  }

  try {
    if (signal?.aborted) throw new Error('Aborted');
    const tvly = tavily({ apiKey });
    const response = await tvly.search(query, {
      maxResults: numResults, searchDepth: 'advanced', includeAnswer: true
    });

    const results: string[] = [];
    if (response.answer) results.push(`Answer: ${response.answer}`);
    if (response.results?.length) {
      results.push(...response.results.map((r: any) => `[Source: ${r.url}]\n${r.content}`));
    }
    return { query, provider: 'Tavily', answer: response.answer, results: results.slice(0, numResults + 1) };
  } catch (e: any) {
    if (e.message === 'Aborted') throw e;
    return { error: 'terminal', message: `Tavily Search failed: ${e.message}`, query };
  }
};

const execWebFetch: Executor = async (args, _config, signal) => {
  const { url } = args as any;
  const timeout = 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 InPro-Agent/1.0' },
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
    // Truncate fetch to 50KB to limit context size
    const buffer = await res.arrayBuffer();
    const text = new TextDecoder().decode(buffer.slice(0, 50000));
    return {
      status: res.status, ok: res.ok, 
      content: text,
      truncated: buffer.byteLength > 50000,
      ...(res.ok ? {} : { error: 'recoverable', message: `HTTP ${res.status}` }),
    };
  } catch (e: any) {
    if (e.name === 'AbortError') return { error: 'recoverable', message: `Request timed out.`, url };
    return { error: 'terminal', message: e.message, url };
  } finally {
    clearTimeout(timer);
  }
};

const execRead: Executor = async (args, _config, _signal) => {
  const requestedPath = args.path as string;
  const maxChars   = (args.max_chars as number) ?? 15000;
  try {
    const filePath = await resolveSafePath(requestedPath);
    const content  = await readFile(filePath, { encoding: 'utf-8' });
    const truncated = content.length > maxChars;
    return {
      path: requestedPath, resolved_path: filePath,
      content: truncated ? content.slice(0, maxChars) : content,
      truncated,
      ...(truncated ? { note: `Truncated at ${maxChars} chars.` } : {}),
    };
  } catch (e: any) {
    return { error: 'recoverable', message: e.message, path: requestedPath };
  }
};

const execWrite: Executor = async (args, _config, _signal) => {
  const requestedPath = args.path as string;
  const content = args.content as string;
  try {
    const filePath = await resolveSafePath(requestedPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return { path: requestedPath, bytes_written: Buffer.byteLength(content, 'utf-8'), success: true };
  } catch (e: any) {
    return { error: 'recoverable', message: e.message, path: requestedPath };
  }
};

const execEdit: Executor = async (args, _config, _signal) => {
  const requestedPath = args.path as string;
  const target = args.target_content as string;
  const replacement = args.replacement_content as string;
  try {
    const filePath = await resolveSafePath(requestedPath);
    let content = await readFile(filePath, 'utf-8');
    if (!content.includes(target)) {
      return { error: 'recoverable', message: 'Target content not found exactly in the file.', path: requestedPath };
    }
    content = content.replace(target, replacement);
    await writeFile(filePath, content, 'utf-8');
    return { path: requestedPath, success: true, message: 'File patched successfully.' };
  } catch (e: any) {
    return { error: 'recoverable', message: e.message, path: requestedPath };
  }
};

const execGlob: Executor = async (args, _config, _signal) => {
  const pattern = args.pattern as string;
  try {
    let safeRoot = DOCS_DIR;
    try {
      const { rows } = await db.query("SELECT setting_value FROM global_settings WHERE setting_key = 'root_directory'");
      if (rows.length > 0) safeRoot = JSON.parse(rows[0].setting_value);
    } catch {}
    
    const matches = await globModule(pattern, { cwd: safeRoot, absolute: true, nodir: true });
    return { root: safeRoot, pattern, matches: matches.slice(0, 100), count: matches.length };
  } catch (e: any) {
    return { error: 'recoverable', message: `Glob failed: ${e.message}` };
  }
};

const execGrep: Executor = async (args, _config, signal) => {
  const regexQuery = args.query as string;
  const pattern = (args.file_pattern as string) || '**/*.*';
  try {
    let safeRoot = DOCS_DIR;
    try {
      const { rows } = await db.query("SELECT setting_value FROM global_settings WHERE setting_key = 'root_directory'");
      if (rows.length > 0) safeRoot = JSON.parse(rows[0].setting_value);
    } catch {}

    const files = await globModule(pattern, { cwd: safeRoot, absolute: true, nodir: true, ignore: 'node_modules/**' });
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

const execBash: Executor = async (args, _config, signal) => {
  const command     = args.command as string;
  // Dangerous commands blocker
  const dangerCmds = ['rm ', 'sudo ', 'shutdown', 'reboot', 'mkfs', 'dd '];
  if (dangerCmds.some(cmd => command.includes(cmd))) {
    return { error: 'terminal', message: `Command rejected. Dangerous commands are blocked.`, command };
  }

  // Force running inside the root directory
  let cwd = DOCS_DIR;
  try {
    const { rows } = await db.query("SELECT setting_value FROM global_settings WHERE setting_key = 'root_directory'");
    if (rows.length > 0) cwd = JSON.parse(rows[0].setting_value);
  } catch {}
  
  const timeout = 15000;
  
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout, signal });
    return { command, cwd, stdout: stdout.trim().slice(0, 8000), stderr: stderr.trim().slice(0, 8000), success: true };
  } catch (e: any) {
    if (e.name === 'AbortError') return { error: 'recoverable', message: 'Command aborted/timed out.', command };
    return { error: 'recoverable', message: `Command failed: ${e.message}`, command, stdout: e.stdout?.trim() ?? '', stderr: e.stderr?.trim() ?? '', success: false };
  }
};

// ─── Built-in Tool Definitions ─────────────────────────────────────────────────

const BUILT_IN_TOOLS: ToolDefinitionEntry[] = [
  // ── File Operations ──
  {
    name: 'read',
    description: 'Reads content from a text file within the restricted root directory sandbox.',
    group: 'File Operations',
    defaultRisk: 'low',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative or absolute path.' },
      },
      required: ['path'],
    },
    executor: execRead,
  },
  {
    name: 'write',
    description: 'Creates or overwrites a file with content within the restricted root directory sandbox.',
    group: 'File Operations',
    defaultRisk: 'high',
    schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Relative or absolute path.' },
        content: { type: 'string', description: 'Text or code to save.' },
      },
      required: ['path', 'content'],
    },
    executor: execWrite,
  },
  {
    name: 'edit',
    description: 'Modifies an existing file by exactly replacing a target string with a new string. Target must match existing content precisely.',
    group: 'File Operations',
    defaultRisk: 'high',
    schema: {
      type: 'object',
      properties: {
        path:                { type: 'string', description: 'Relative or absolute path.' },
        target_content:      { type: 'string', description: 'Exact string to be replaced.' },
        replacement_content: { type: 'string', description: 'New string to inject.' },
      },
      required: ['path', 'target_content', 'replacement_content'],
    },
    executor: execEdit,
  },
  {
    name: 'glob',
    description: 'Searches for files matching a glob pattern (e.g. "**/*.js") inside the root directory sandbox.',
    group: 'File Operations',
    defaultRisk: 'low',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
      },
      required: ['pattern'],
    },
    executor: execGlob,
  },
  {
    name: 'grep',
    description: 'Grep-like semantic search. Finds lines matching a regex pattern inside files.',
    group: 'File Operations',
    defaultRisk: 'low',
    schema: {
      type: 'object',
      properties: {
        query:        { type: 'string', description: 'Regex pattern.' },
        file_pattern: { type: 'string', description: 'Filter pattern. Default: **/*.*' },
      },
      required: ['query'],
    },
    executor: execGrep,
  },
  // ── System Operations ──
  {
    name: 'bash',
    description: 'Executes a shell command. Ran inside a restricted sandbox environment with timeouts. Dangerous commands are rejected.',
    group: 'System Operations',
    defaultRisk: 'high',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run.' },
      },
      required: ['command'],
    },
    executor: execBash,
  },
  // ── Web Operations ──
  {
    name: 'websearch_tavily',
    description: 'Real-time web search optimized for AI agents. Returns fast, relevant, and summarized results.',
    group: 'Web Operations',
    defaultRisk: 'low',
    schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    executor: execWebSearchTavily,
  },
  {
    name: 'websearch_exa',
    description: 'Semantic search engine focused on high-quality and context-rich sources. Best for technical research.',
    group: 'Web Operations',
    defaultRisk: 'low',
    schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    executor: execWebSearchExa,
  },
  {
    name: 'web_fetch',
    description: 'Fetches and extracts clean, readable content from a given URL for deeper analysis.',
    group: 'Web Operations',
    defaultRisk: 'high',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL (https://...).' },
      },
      required: ['url'],
    },
    executor: execWebFetch,
  },
];

const EXECUTOR_MAP = new Map<string, Executor>(
  BUILT_IN_TOOLS.map(t => [t.name, t.executor])
);

// ─── ToolRegistry ──────────────────────────────────────────────────────────────

export class ToolRegistry {
  static async seed(): Promise<void> {
    // We now have a fixed registry of tools.
    // Clean all tools that are not in the new inventory
    const newToolNames = BUILT_IN_TOOLS.map(t => t.name);
    
    // Safety sync: clean any tool that isn't statically defined here
    const { rows } = await db.query(`SELECT name FROM tools`);
    for (const row of rows) {
      if (!newToolNames.includes(row.name)) {
        await db.query(`DELETE FROM tools WHERE name = $1`, [row.name]);
      }
    }

    // Upsert exact tool definitions
    for (const tool of BUILT_IN_TOOLS) {
      await db.query(
        `INSERT INTO tools (name, description, schema, config, tool_group, is_enabled, risk_level)
         VALUES ($1, $2, $3, $4, $5, true, $6)
         ON CONFLICT (name) DO UPDATE SET
            description = EXCLUDED.description,
            schema = EXCLUDED.schema,
            tool_group = EXCLUDED.tool_group,
            risk_level = EXCLUDED.risk_level`,
        [tool.name, tool.description, JSON.stringify(tool.schema), '{}', tool.group, tool.defaultRisk]
      );
    }
    console.log(`[ToolRegistry] Seeded ${BUILT_IN_TOOLS.length} controlled core tools.`);
  }

  static async execute(
    toolName: string,
    args: Args,
    _agentId?: string,
    signal?: AbortSignal,
    isDryRun?: boolean
  ): Promise<Result> {
    const startTime = Date.now();
    const dryRunPrefix = isDryRun ? '(dry-run) ' : '';
    
    console.log(`[ToolRegistry] START ${dryRunPrefix}"${toolName}"`);

    const { rows } = await db.query(
      `SELECT name, is_enabled, risk_level FROM tools WHERE name = $1 LIMIT 1`,
      [toolName]
    );

    if (rows.length === 0) {
      throw new Error(`Tool "${toolName}" is not available.`);
    }

    const row = rows[0];

    if (!row.is_enabled) {
      throw new Error(`Tool "${toolName}" is disabled.`);
    }

    if (isDryRun && row.risk_level === 'high') {
      return {
        error: 'terminal',
        tool: toolName,
        message: `High-risk tools are disabled during dry run. Tool "${toolName}" cannot be executed.`,
      };
    }

    const executor = EXECUTOR_MAP.get(toolName);
    if (!executor) {
      throw new Error(`Tool "${toolName}" is missing an implementation layer.`);
    }

    let result: Result;
    try {
      result = await executor(args, {}, signal);
    } catch (e: any) {
      result = { error: 'terminal', message: e.message };
    }

    const duration = Date.now() - startTime;
    console.log(`[ToolRegistry] END ${dryRunPrefix}"${toolName}" (${duration}ms)`);
    return result;
  }
}
