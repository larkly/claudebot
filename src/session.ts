/**
 * Session manager — in-memory Map<threadId, SessionState> with lifecycle,
 * timeouts, and RBAC.
 * @see DESIGN.md > Decision 2: Multi-User Sessions
 */

import type { SessionState, AppConfig } from './types.js';
import { persistThread, removePersistedThread, updateClaudeSessionId } from './persistence.js';

/** In-memory session store keyed by Discord thread ID. */
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /** Create a new session for a thread. */
  createSession(params: {
    threadId: string;
    ownerId: string;
    projectName: string;
  }): SessionState {
    const { threadId, ownerId, projectName } = params;
    const now = Date.now();

    const session: SessionState = {
      threadId,
      ownerId,
      projectName,
      claudeSessionId: null,
      ptyProcess: null,
      startedAt: now,
      lastActivityAt: now,
      watchdogTimer: null,
      idleTimer: null,
      currentMessageId: null,
      outputBuffer: '',
    };

    this.sessions.set(threadId, session);
    persistThread({ threadId, ownerId, claudeSessionId: null, projectName });

    // Start timers
    this.startIdleTimer(threadId);
    this.startWatchdogTimer(threadId);

    return session;
  }

  /** Get a session by thread ID. */
  get(threadId: string): SessionState | undefined {
    return this.sessions.get(threadId);
  }

  /** Check if a session exists for this thread. */
  has(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  /** Get the count of active sessions. */
  size(): number {
    return this.sessions.size;
  }

  /** Check if the user is the owner of the session in this thread. */
  isOwner(threadId: string, userId: string): boolean {
    const session = this.sessions.get(threadId);
    return session?.ownerId === userId;
  }

  /** Check if there are too many concurrent sessions. */
  isAtCapacity(): boolean {
    return this.sessions.size >= this.config.global.maxConcurrentSessions;
  }

  /** Update the claude session ID after the first invocation's result event. */
  setClaudeSessionId(threadId: string, claudeSessionId: string): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.claudeSessionId = claudeSessionId;
      updateClaudeSessionId(threadId, claudeSessionId);
    }
  }

  /** Reset the idle timer for a session (called on owner activity). */
  resetIdleTimer(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    session.lastActivityAt = Date.now();

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    this.startIdleTimer(threadId);
  }

  /** Destroy a session, cleaning up all resources. */
  destroy(threadId: string): SessionState | undefined {
    const session = this.sessions.get(threadId);
    if (!session) return undefined;

    // Kill the PTY process if still running
    if (session.ptyProcess) {
      try {
        session.ptyProcess.kill();
      } catch {
        // Process may have already exited
      }
      session.ptyProcess = null;
    }

    // Clear timers
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    if (session.watchdogTimer) {
      clearTimeout(session.watchdogTimer);
    }

    this.sessions.delete(threadId);
    removePersistedThread(threadId);

    return session;
  }

  /** Start the idle timeout for a session. */
  private startIdleTimer(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    const timeoutMs = this.config.global.idleTimeoutSeconds * 1000;
    session.idleTimer = setTimeout(() => {
      this.handleIdleTimeout(threadId);
    }, timeoutMs);
  }

  /** Start the watchdog timeout for a session. */
  private startWatchdogTimer(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    const timeoutMs = this.config.global.maxSessionDuration * 1000;
    session.watchdogTimer = setTimeout(() => {
      this.handleWatchdogTimeout(threadId);
    }, timeoutMs);
  }

  /** Idle timeout handler — releases the session lock. */
  private handleIdleTimeout(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    // The Discord layer will listen for the 'idleTimeout' event pattern
    // by checking session state. We just destroy here.
    this.destroy(threadId);
  }

  /** Watchdog timeout handler — kills the process regardless of activity. */
  private handleWatchdogTimeout(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.ptyProcess) {
      try {
        session.ptyProcess.kill();
      } catch {
        // Already dead
      }
    }
    this.destroy(threadId);
  }

  /** Get all active sessions (for restart recovery). */
  entries(): IterableIterator<[string, SessionState]> {
    return this.sessions.entries();
  }
}
