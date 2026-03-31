/**
 * Standardized Error Types
 * ─────────────────────────────────────────────────────────────────────────────
 * Single error format used across the entire system.
 * NO MORE inconsistent error handling.
 */

export type ErrorType = 'validation' | 'execution' | 'tool' | 'system';

export interface StandardError {
  type: ErrorType;
  message: string;
  retryable: boolean;
  field?: string;
  details?: unknown;
}

export class ValidationError extends Error {
  public readonly type: ErrorType = 'validation';
  public readonly retryable: boolean;
  public readonly field?: string;

  constructor(message: string, field?: string, retryable = false) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.retryable = retryable;
  }

  toJSON(): StandardError {
    return {
      type: this.type,
      message: this.message,
      retryable: this.retryable,
      field: this.field,
    };
  }
}

export class ExecutionError extends Error {
  public readonly type: ErrorType = 'execution';
  public readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'ExecutionError';
    this.retryable = retryable;
  }

  toJSON(): StandardError {
    return {
      type: this.type,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export class ToolError extends Error {
  public readonly type: ErrorType = 'tool';
  public readonly retryable: boolean;
  public readonly toolName: string;

  constructor(message: string, toolName: string, retryable = true) {
    super(message);
    this.name = 'ToolError';
    this.toolName = toolName;
    this.retryable = retryable;
  }

  toJSON(): StandardError {
    return {
      type: this.type,
      message: this.message,
      retryable: this.retryable,
      details: { toolName: this.toolName },
    };
  }
}

export class SystemError extends Error {
  public readonly type: ErrorType = 'system';
  public readonly retryable: boolean = false;

  constructor(message: string) {
    super(message);
    this.name = 'SystemError';
  }

  toJSON(): StandardError {
    return {
      type: this.type,
      message: this.message,
      retryable: this.retryable,
    };
  }
}
