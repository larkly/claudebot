/**
 * Process layer — spawns `claude` CLI via node-pty with --output-format stream-json.
 * Parses structured events and invokes callbacks.
 * @see DESIGN.md > Decision 1: Conversation Continuity
 */

import * as pty from 'node-pty';
import { spawn } from 'node:child_process';
import type { ClaudeEvent } from './types.js';

/** Callback signatures for stream events. */
export interface StreamCallbacks {
  /** Called when a session_id is obtained (from system init or result event). */
  onSessionId?: (sessionId: string) => void;
  /** Called for each assistant text chunk. */
  onAssistantText?: (text: string) => void;
  /** Called when the process produces its final result. */
  onResult?: (result: string, costUsd: number | null) => void;
  /** Called on any error (process exit code != 0, parse failure, etc.). */
  onError?: (error: string) => void;
  /** Called when the process exits, regardless of success/failure. */
  onExit?: (exitCode: number) => void;
}

/** Build the claude CLI args for a first invocation (no --resume). */
function buildFirstInvocationArgs(prompt: string): string[] {
  return ['-p', prompt, '--output-format', 'stream-json'];
}

/** Build the claude CLI args for a subsequent invocation (--resume). */
function buildResumeArgs(sessionId: string, prompt: string): string[] {
  return ['--resume', sessionId, '-p', prompt, '--output-format', 'stream-json'];
}

/**
 * Spawn a Claude Code CLI process with stream-json output.
 * Uses node-pty for proper PTY handling.
 *
 * @param prompt The user's prompt text
 * @param cwd The working directory (project path) — only matters for first invocation
 * @param sessionId Optional Claude session ID for --resume
 * @param claudePath Path to the claude CLI binary (default: 'claude')
 * @param callbacks Callback functions for stream events
 * @returns The PTY process handle
 */
export function spawnClaude(
  prompt: string,
  cwd: string,
  sessionId: string | null,
  claudePath: string,
  callbacks: StreamCallbacks,
): pty.IPty {
  const args = sessionId
    ? buildResumeArgs(sessionId, prompt)
    : buildFirstInvocationArgs(prompt);

  const proc = pty.spawn(claudePath, args, {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: sessionId ? undefined : cwd,
    env: process.env as Record<string, string>,
  });

  let lineBuffer = '';

  /**
   * Parse a complete line as a JSON event and dispatch to callbacks.
   * The stream-json format emits one JSON object per line.
   */
  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: ClaudeEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Not valid JSON — might be preamble or stderr output
      return;
    }

    // Dispatch based on event type
    if (event.type === 'system' && event.session_id) {
      callbacks.onSessionId?.(event.session_id);
    } else if (event.type === 'assistant' && event.message?.content) {
      const text = event.message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (text) {
        callbacks.onAssistantText?.(text);
      }
    } else if (event.type === 'result') {
      const cost = event.total_cost_usd ?? null;
      callbacks.onResult?.(event.result ?? '', cost);
      if (event.session_id) {
        callbacks.onSessionId?.(event.session_id);
      }
    }
  }

  proc.onData((data: string) => {
    lineBuffer += data;

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, newlineIdx);
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      processLine(line);
    }
  });

  proc.onExit(({ exitCode }) => {
    // Process any remaining buffered data
    if (lineBuffer.trim()) {
      processLine(lineBuffer);
    }

    if (exitCode !== 0) {
      callbacks.onError?.(`Claude process exited with code ${exitCode}`);
    }
    callbacks.onExit?.(exitCode);
  });

  return proc;
}

/**
 * Check if the claude CLI is available at the given path.
 * Uses a simple `--version` check.
 */
export function checkClaudeAvailable(claudePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(claudePath, ['--version'], { stdio: 'pipe' });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
    // Timeout after 5 seconds
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
  });
}
