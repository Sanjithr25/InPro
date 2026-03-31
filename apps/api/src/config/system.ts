/**
 * System Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized configuration for system-wide settings
 */

export class SystemConfig {
  private static config: Record<string, unknown> = {
    'dryRun.retentionCount': 3,
    'dryRun.enabled': true,
    'agent.maxTurns': 15,
    'agent.defaultTimeout': null,
    'agent.defaultTemperature': null,
  };

  static get<T = unknown>(key: string, defaultValue?: T): T {
    const value = this.config[key];
    if (value === undefined && defaultValue !== undefined) {
      return defaultValue;
    }
    return value as T;
  }

  static set(key: string, value: unknown): void {
    this.config[key] = value;
  }

  static getAll(): Record<string, unknown> {
    return { ...this.config };
  }
}
