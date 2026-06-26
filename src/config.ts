/**
 * Configuration loader using cosmiconfig.
 * Merges global config (~/.discord-claude/config.json) with per-project configs.
 */

import { cosmiconfigSync } from 'cosmiconfig';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { AppConfig, GlobalConfig, ProjectConfig } from './types.js';

const CONFIG_DIR = join(homedir(), '.discord-claude');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_GLOBAL: GlobalConfig = {
  allowedRoles: ['developer', 'admin'],
  maxConcurrentSessions: 5,
  maxSessionDuration: 3600,
  idleTimeoutSeconds: 600,
  secretPatterns: ['sk-[a-zA-Z0-9]+', 'ghp_[a-zA-Z0-9]+', 'AKIA[A-Z0-9]+'],
};

/** Load the global config, falling back to defaults. */
function loadGlobalConfig(): GlobalConfig {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return DEFAULT_GLOBAL;
    }
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_GLOBAL, ...parsed };
  } catch {
    return DEFAULT_GLOBAL;
  }
}

/** Load per-project config from the project directory's `.discord-claude.json`. */
function loadProjectConfig(projectPath: string): ProjectConfig | null {
  const projectConfigFile = join(projectPath, '.discord-claude.json');
  if (!existsSync(projectConfigFile)) return null;
  try {
    const raw = readFileSync(projectConfigFile, 'utf-8');
    return JSON.parse(raw) as ProjectConfig;
  } catch {
    return null;
  }
}

/**
 * Load and merge configuration.
 * Reads the global config from ~/.discord-claude/config.json and any
 * per-project .discord-claude.json files referenced in the global config.
 */
export function loadConfig(): AppConfig {
  const global = loadGlobalConfig();

  // If the global config already defines projects with paths, load each one
  const projects: Record<string, ProjectConfig> = {};
  if (globalConfigHasProjects(global)) {
    for (const [name, proj] of Object.entries(global.projects)) {
      projects[name] = proj;
      const perProject = loadProjectConfig(proj.path);
      if (perProject) {
        projects[name] = { ...proj, ...perProject };
      }
    }
  }

  return { global, projects };
}

// Type guard for the "projects" field that might appear in a raw global config
function globalConfigHasProjects(
  global: GlobalConfig & { projects?: Record<string, ProjectConfig> },
): global is GlobalConfig & { projects: Record<string, ProjectConfig> } {
  return global.projects !== undefined;
}

/** Ensure the config directory exists. */
export function ensureConfigDir(): void {
  const dataDir = dirname(CONFIG_FILE);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

export { CONFIG_DIR, CONFIG_FILE };
