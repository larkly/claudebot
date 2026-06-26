/**
 * Core type definitions for Claudebot.
 * @see DESIGN.md for schema details and design rationale.
 */

/// <reference types="node" />


/** Session state for a Discord thread tied to a Claude Code CLI session. */
export interface SessionState {
  /** Discord thread ID (primary key) */
  threadId: string;
  /** Discord user ID of the session owner */
  ownerId: string;
  /** Active project name for this session */
  projectName: string;
  /** Claude Code session ID for --resume; null until the first result event */
  claudeSessionId: string | null;
  /** node-pty handle for the current invocation; null when idle between messages */
  ptyProcess: import('node-pty').IPty | null;
  /** Date.now() timestamp when the session was created */
  startedAt: number;
  /** Date.now() of the last owner message (for idle timeout) */
  lastActivityAt: number;
  /** maxSessionDuration enforcement timer */
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  /** idleTimeoutSeconds enforcement timer */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** ID of the Discord message being edited for streaming */
  currentMessageId: string | null;
  /** Pending output not yet flushed to Discord */
  outputBuffer: string;
}

/** Global configuration merged with per-project config. */
export interface GlobalConfig {
  allowedRoles: string[];
  maxConcurrentSessions: number;
  maxSessionDuration: number;
  idleTimeoutSeconds: number;
  secretPatterns: string[];
}

/** Per-project configuration. */
export interface ProjectConfig {
  path: string;
  commands?: Record<string, string>;
  autoApprove?: boolean;
  allowedShellCommands?: string[];
}

/** Full merged configuration shape. */
export interface AppConfig {
  global: GlobalConfig;
  projects: Record<string, ProjectConfig>;
}

/** Stream-JSON event types emitted by `claude --output-format stream-json`. */
export type ClaudeEventType = 'system' | 'assistant' | 'result';

/** Base event shape for stream-json. */
export interface ClaudeEvent {
  type: ClaudeEventType;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  message?: {
    content: Array<{ type: string; text: string }>;
  };
  result?: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
}

/** Persisted thread record for session recovery across restarts. */
export interface PersistedThread {
  threadId: string;
  ownerId: string;
  claudeSessionId: string | null;
  projectName: string;
}
