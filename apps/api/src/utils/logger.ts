/**
 * Production-Grade Structured Logger
 * ─────────────────────────────────────────────────────────────────────────────
 * Machine-readable, queryable, production-ready logging system
 */

import { v4 as uuidv4 } from 'uuid';

// ─── Standard Log Levels (RFC 5424) ──────────────────────────────────────────
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

// ─── Component Types (Machine-Readable) ───────────────────────────────────────
export type Component = 
  | 'system' 
  | 'database' 
  | 'redis' 
  | 'scheduler' 
  | 'schedule' 
  | 'task' 
  | 'agent' 
  | 'llm' 
  | 'tool' 
  | 'api' 
  | 'queue';

// ─── Lifecycle Phases (Enforced) ──────────────────────────────────────────────
export type Phase = 'startup' | 'runtime' | 'shutdown';

// ─── Operation Types ──────────────────────────────────────────────────────────
export type Operation = 
  | 'start' 
  | 'end' 
  | 'execute' 
  | 'kill' 
  | 'error' 
  | 'connect' 
  | 'disconnect'
  | 'request'
  | 'response';

// ─── Structured Log Entry ─────────────────────────────────────────────────────
export interface LogEntry {
  // Core fields
  timestamp: string;           // ISO 8601
  level: LogLevel;
  message: string;
  
  // Component identification
  component: Component;
  operation: Operation;
  phase: Phase;
  
  // Distributed tracing (OpenTelemetry compatible)
  traceId: string;             // Global trace across all services
  spanId: string;              // Current operation span
  parentSpanId?: string;       // Parent operation span
  
  // Execution context
  scheduleId?: string;
  scheduleName?: string;
  scheduleRunId?: string;
  taskId?: string;
  taskName?: string;
  taskRunId?: string;
  agentId?: string;
  agentName?: string;
  agentRunId?: string;
  
  // API context
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  
  // Metrics
  duration?: number;           // milliseconds
  success?: boolean;
  
  // LLM metrics
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  provider?: string;
  model?: string;
  
  // Queue metrics
  queueDepth?: number;
  retryCount?: number;
  backoffMs?: number;
  
  // Error details
  error?: string;
  errorCode?: string;
  errorStack?: string;
  
  // Additional structured data
  metadata?: Record<string, unknown>;
  
  // Environment
  env?: string;
  pid?: number;
  hostname?: string;
}

// ─── Logger Configuration ─────────────────────────────────────────────────────
interface LoggerConfig {
  minLevel: LogLevel;
  enableConsole: boolean;
  enableJson: boolean;          // JSON output for log aggregators
  enablePretty: boolean;        // Pretty console for dev
  samplingRate: number;         // 0-1, for DEBUG logs
  component?: Component;        // Default component
}

const DEFAULT_CONFIG: LoggerConfig = {
  minLevel: process.env.LOG_LEVEL as LogLevel || 'INFO',
  enableConsole: true,
  enableJson: process.env.NODE_ENV === 'production',
  enablePretty: process.env.NODE_ENV !== 'production',
  samplingRate: process.env.LOG_SAMPLING_RATE ? parseFloat(process.env.LOG_SAMPLING_RATE) : 1.0,
};

// ─── Logger Class ─────────────────────────────────────────────────────────────
class StructuredLogger {
  private config: LoggerConfig;
  private currentPhase: Phase = 'startup';
  private globalTraceId: string;
  
  // Level priority for filtering
  private levelPriority: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  };

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.globalTraceId = uuidv4();
  }

  setPhase(phase: Phase) {
    this.currentPhase = phase;
  }

  private shouldLog(level: LogLevel): boolean {
    // Check level priority
    if (this.levelPriority[level] < this.levelPriority[this.config.minLevel]) {
      return false;
    }
    
    // Apply sampling for DEBUG logs
    if (level === 'DEBUG' && Math.random() > this.config.samplingRate) {
      return false;
    }
    
    return true;
  }

  private formatPretty(entry: LogEntry): string {
    const levelColors: Record<LogLevel, string> = {
      DEBUG: '\x1b[90m',  // Gray
      INFO: '\x1b[36m',   // Cyan
      WARN: '\x1b[33m',   // Yellow
      ERROR: '\x1b[31m',  // Red
    };
    const reset = '\x1b[0m';
    const color = levelColors[entry.level];
    
    const time = new Date(entry.timestamp).toISOString().substring(11, 23);
    const ctx = this.formatContext(entry);
    const metrics = this.formatMetrics(entry);
    
    return `${color}[${time}] [${entry.level}] [${entry.component}:${entry.operation}]${reset} ${ctx}${entry.message}${metrics}`;
  }

  private formatContext(entry: LogEntry): string {
    const parts: string[] = [];
    
    if (entry.scheduleName) parts.push(`sched="${entry.scheduleName}"`);
    if (entry.taskName) parts.push(`task="${entry.taskName}"`);
    if (entry.agentName) parts.push(`agent="${entry.agentName}"`);
    if (entry.requestId) parts.push(`req=${entry.requestId.substring(0, 8)}`);
    if (entry.traceId !== this.globalTraceId) parts.push(`trace=${entry.traceId.substring(0, 8)}`);
    
    return parts.length > 0 ? `[${parts.join(' ')}] ` : '';
  }

  private formatMetrics(entry: LogEntry): string {
    const metrics: string[] = [];
    
    if (entry.duration !== undefined) metrics.push(`${entry.duration}ms`);
    if (entry.success !== undefined) metrics.push(entry.success ? '✓' : '✗');
    if (entry.totalTokens) metrics.push(`${entry.totalTokens}tok`);
    if (entry.estimatedCost) metrics.push(`$${entry.estimatedCost.toFixed(4)}`);
    if (entry.statusCode) metrics.push(`${entry.statusCode}`);
    
    return metrics.length > 0 ? ` (${metrics.join(' ')})` : '';
  }

  private log(entry: Partial<LogEntry>) {
    const level = entry.level || 'INFO';
    
    if (!this.shouldLog(level)) return;
    
    const fullEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: entry.message || '',
      component: entry.component || this.config.component || 'system',
      operation: entry.operation || 'execute',
      phase: entry.phase || this.currentPhase,
      traceId: entry.traceId || this.globalTraceId,
      spanId: entry.spanId || uuidv4(),
      env: process.env.NODE_ENV,
      pid: process.pid,
      hostname: process.env.HOSTNAME,
      ...entry,
    };

    if (this.config.enableJson) {
      console.log(JSON.stringify(fullEntry));
    }
    
    if (this.config.enablePretty) {
      console.log(this.formatPretty(fullEntry));
    }
  }

  // ─── System Lifecycle ─────────────────────────────────────────────────────
  systemStart(port: number) {
    this.setPhase('startup');
    this.log({
      level: 'INFO',
      component: 'system',
      operation: 'start',
      message: 'API Server Started',
      metadata: { port, nodeVersion: process.version, platform: process.platform },
      success: true,
    });
  }

  systemShutdown(reason: string) {
    this.setPhase('shutdown');
    this.log({
      level: 'WARN',
      component: 'system',
      operation: 'end',
      message: 'API Server Shutting Down',
      metadata: { reason },
    });
  }

  // ─── Database ─────────────────────────────────────────────────────────────
  dbConnected(host: string, database: string) {
    this.log({
      level: 'INFO',
      component: 'database',
      operation: 'connect',
      message: 'Database Connected',
      metadata: { host, database },
      success: true,
    });
  }

  dbError(operation: string, error: string) {
    this.log({
      level: 'ERROR',
      component: 'database',
      operation: 'error',
      message: `Database Error: ${operation}`,
      error,
    });
  }

  // ─── Redis ────────────────────────────────────────────────────────────────
  redisConnected(mode: 'bullmq' | 'fallback') {
    this.log({
      level: 'INFO',
      component: 'redis',
      operation: 'connect',
      message: `Redis Connected (${mode})`,
      metadata: { mode },
      success: mode === 'bullmq',
    });
  }

  redisError(error: string) {
    this.log({
      level: 'WARN',
      component: 'redis',
      operation: 'error',
      message: 'Redis Connection Failed - Using Fallback',
      error,
    });
  }

  // ─── Scheduler ────────────────────────────────────────────────────────────
  schedulerInit(enabledCount: number, totalCount: number) {
    this.setPhase('runtime');
    this.log({
      level: 'INFO',
      component: 'scheduler',
      operation: 'start',
      message: 'Scheduler Initialized',
      metadata: { enabledSchedules: enabledCount, totalSchedules: totalCount },
      success: true,
    });
  }

  // ─── Schedule Execution ───────────────────────────────────────────────────
  scheduleStart(scheduleName: string, scheduleId: string, scheduleRunId: string, taskCount: number, traceId?: string) {
    this.log({
      level: 'INFO',
      component: 'schedule',
      operation: 'start',
      message: 'Schedule Started',
      scheduleName,
      scheduleId,
      scheduleRunId,
      traceId: traceId || uuidv4(),
      spanId: scheduleRunId,
      metadata: { taskCount },
    });
  }

  scheduleEnd(scheduleName: string, scheduleId: string, scheduleRunId: string, success: boolean, duration: number) {
    this.log({
      level: success ? 'INFO' : 'ERROR',
      component: 'schedule',
      operation: 'end',
      message: `Schedule ${success ? 'Completed' : 'Failed'}`,
      scheduleName,
      scheduleId,
      scheduleRunId,
      spanId: scheduleRunId,
      success,
      duration,
    });
  }

  scheduleKilled(scheduleName: string, scheduleId: string, scheduleRunId: string, killedBy: string) {
    this.log({
      level: 'WARN',
      component: 'schedule',
      operation: 'kill',
      message: 'Schedule Killed',
      scheduleName,
      scheduleId,
      scheduleRunId,
      spanId: scheduleRunId,
      metadata: { killedBy },
    });
  }

  // ─── Task Execution ───────────────────────────────────────────────────────
  taskStart(taskName: string, taskId: string, taskRunId: string, parentSpanId: string | null) {
    this.log({
      level: 'INFO',
      component: 'task',
      operation: 'start',
      message: 'Task Started',
      taskName,
      taskId,
      taskRunId,
      spanId: taskRunId,
      parentSpanId: parentSpanId || undefined,
    });
  }

  taskEnd(taskName: string, taskId: string, taskRunId: string, success: boolean, duration: number, error?: string) {
    this.log({
      level: success ? 'INFO' : 'ERROR',
      component: 'task',
      operation: 'end',
      message: `Task ${success ? 'Completed' : 'Failed'}`,
      taskName,
      taskId,
      taskRunId,
      spanId: taskRunId,
      success,
      duration,
      error,
    });
  }

  // ─── Agent Execution ──────────────────────────────────────────────────────
  agentStart(agentName: string, agentId: string, agentRunId: string, parentSpanId: string | null) {
    this.log({
      level: 'INFO',
      component: 'agent',
      operation: 'start',
      message: 'Agent Started',
      agentName,
      agentId,
      agentRunId,
      spanId: agentRunId,
      parentSpanId: parentSpanId || undefined,
    });
  }

  agentEnd(agentName: string, agentId: string, agentRunId: string, success: boolean, duration: number, toolsUsed?: string[]) {
    this.log({
      level: success ? 'INFO' : 'ERROR',
      component: 'agent',
      operation: 'end',
      message: `Agent ${success ? 'Completed' : 'Failed'}`,
      agentName,
      agentId,
      agentRunId,
      spanId: agentRunId,
      success,
      duration,
      metadata: toolsUsed ? { toolsUsed } : undefined,
    });
  }

  agentKilled(agentName: string, agentId: string, agentRunId: string, killedBy: string = 'user') {
    this.log({
      level: 'WARN',
      component: 'agent',
      operation: 'kill',
      message: 'Agent Killed',
      agentName,
      agentId,
      agentRunId,
      spanId: agentRunId,
      metadata: { killedBy },
    });
  }

  // ─── LLM Calls ────────────────────────────────────────────────────────────
  llmCall(provider: string, model: string, inputTokens: number, outputTokens: number, duration: number, cost: number) {
    this.log({
      level: 'DEBUG',
      component: 'llm',
      operation: 'execute',
      message: 'LLM API Call',
      provider,
      model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCost: cost,
      duration,
      success: true,
    });
  }

  llmError(provider: string, model: string, error: string, retryCount?: number) {
    this.log({
      level: 'ERROR',
      component: 'llm',
      operation: 'error',
      message: 'LLM API Error',
      provider,
      model,
      error,
      metadata: retryCount !== undefined ? { retryCount } : undefined,
    });
  }

  // ─── Tool Execution ───────────────────────────────────────────────────────
  toolExecute(toolName: string, success: boolean, duration: number, agentName?: string) {
    this.log({
      level: 'DEBUG',
      component: 'tool',
      operation: 'execute',
      message: `Tool: ${toolName}`,
      agentName,
      success,
      duration,
      metadata: { toolName },
    });
  }

  // ─── API Requests ─────────────────────────────────────────────────────────
  apiRequest(method: string, path: string, requestId: string, ip?: string) {
    this.log({
      level: 'DEBUG',
      component: 'api',
      operation: 'request',
      message: `${method} ${path}`,
      requestId,
      method,
      path,
      spanId: requestId,
      metadata: { ip },
    });
  }

  apiResponse(method: string, path: string, requestId: string, statusCode: number, duration: number) {
    this.log({
      level: statusCode >= 400 ? 'ERROR' : 'DEBUG',
      component: 'api',
      operation: 'response',
      message: `${method} ${path}`,
      requestId,
      method,
      path,
      statusCode,
      spanId: requestId,
      duration,
      success: statusCode < 400,
    });
  }

  // ─── Queue Metrics ────────────────────────────────────────────────────────
  queueMetrics(queueName: string, depth: number, processing: number) {
    this.log({
      level: 'DEBUG',
      component: 'queue',
      operation: 'execute',
      message: `Queue Metrics: ${queueName}`,
      queueDepth: depth,
      metadata: { queueName, processing },
    });
  }

  // ─── Kill Operations ──────────────────────────────────────────────────────
  killTree(runId: string, controllersAborted: number, dbRecordsUpdated: number) {
    this.log({
      level: 'WARN',
      component: 'system',
      operation: 'kill',
      message: 'Kill Tree Completed',
      metadata: { runId: runId.substring(0, 8), controllersAborted, dbRecordsUpdated },
    });
  }

  // ─── Generic Error ────────────────────────────────────────────────────────
  error(message: string, component: Component, error: Error | string, context?: Partial<LogEntry>) {
    this.log({
      level: 'ERROR',
      component,
      operation: 'error',
      message,
      error: error instanceof Error ? error.message : error,
      errorStack: error instanceof Error ? error.stack?.split('\n').slice(0, 5).join('\n') : undefined,
      ...context,
    });
  }

  // ─── Generic Info ─────────────────────────────────────────────────────────
  info(message: string, component: Component, metadata?: Record<string, unknown>) {
    this.log({
      level: 'INFO',
      component,
      operation: 'execute',
      message,
      metadata,
    });
  }

  warn(message: string, component: Component, metadata?: Record<string, unknown>) {
    this.log({
      level: 'WARN',
      component,
      operation: 'execute',
      message,
      metadata,
    });
  }

  debug(message: string, component: Component, metadata?: Record<string, unknown>) {
    this.log({
      level: 'DEBUG',
      component,
      operation: 'execute',
      message,
      metadata,
    });
  }
}

export const logger = new StructuredLogger();
