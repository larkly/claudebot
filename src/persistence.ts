/**
 * Persistent session storage.
 * Writes active thread metadata to ~/.discord-claude/active-threads.json
 * for recovery across bot restarts.
 * @see DESIGN.md > Decision 5: Persistent Sessions
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';
import type { PersistedThread } from './types.js';

const THREADS_FILE = join(CONFIG_DIR, 'active-threads.json');

/** Read all persisted threads. Returns an empty array if the file doesn't exist. */
export function readPersistedThreads(): PersistedThread[] {
  try {
    if (!existsSync(THREADS_FILE)) return [];
    const raw = readFileSync(THREADS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write the full list of persisted threads to disk. */
function writePersistedThreads(threads: PersistedThread[]): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[ERROR] Failed to persist threads: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Add or update a thread in the persisted store. */
export function persistThread(thread: PersistedThread): void {
  const threads = readPersistedThreads();
  const idx = threads.findIndex((t) => t.threadId === thread.threadId);
  if (idx >= 0) {
    threads[idx] = thread;
  } else {
    threads.push(thread);
  }
  writePersistedThreads(threads);
}

/** Update only the claudeSessionId for a persisted thread. */
export function updateClaudeSessionId(threadId: string, claudeSessionId: string): void {
  const threads = readPersistedThreads();
  const idx = threads.findIndex((t) => t.threadId === threadId);
  if (idx >= 0) {
    threads[idx].claudeSessionId = claudeSessionId;
    writePersistedThreads(threads);
  }
}

/** Remove a thread from the persisted store (session ended). */
export function removePersistedThread(threadId: string): void {
  const threads = readPersistedThreads().filter((t) => t.threadId !== threadId);
  writePersistedThreads(threads);
}

export { THREADS_FILE };
