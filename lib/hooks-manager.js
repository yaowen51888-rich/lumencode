import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { StepTracker } from './step-tracker.js';

const libRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(libRoot, '..');
const hookRoot = resolve(packageRoot, 'hooks');

const CLAUDE_HOOK_FILE = 'post-tool-use.js';
const CODEX_HOOK_FILE = 'codex-hook.js';

export const HOOK_TOOLS = Object.freeze({
  CLAUDE: 'claude',
  CODEX: 'codex',
});

function projectPaths(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  return {
    root,
    stepsDbPath: join(root, '.ccusage', 'steps.db'),
    claudeSettingsDir: join(root, '.claude'),
    claudeSettingsPath: join(root, '.claude', 'settings.local.json'),
    codexConfigDir: join(root, '.codex'),
    codexConfigPath: join(root, '.codex', 'config.toml'),
  };
}

function backupFile(filePath) {
  if (!existsSync(filePath)) return null;
  const backupPath = `${filePath}.bak`;
  if (!existsSync(backupPath)) copyFileSync(filePath, backupPath);
  return backupPath;
}

function readJsonConfig(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON config: ${filePath}`);
  }
}

function isClaudeHook(entry) {
  return Boolean(
    entry &&
    typeof entry === 'object' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(sub => commandReferencesFile(sub?.command, CLAUDE_HOOK_FILE))
  );
}

function commandReferencesFile(command, fileName) {
  if (typeof command !== 'string') return false;
  const normalized = command.replace(/\\/g, '/');
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|/)${escaped}(["'\\s]|$)`).test(normalized);
}

function ensureHooksFeature(config) {
  const lines = config.split(/\r?\n/);
  const featureIndex = lines.findIndex(line => line.trim() === '[features]');

  if (featureIndex === -1) {
    const prefix = config.trimEnd();
    return `${prefix}${prefix ? '\n\n' : ''}[features]\nhooks = true\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = featureIndex + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      nextSectionIndex = i;
      break;
    }
  }

  const hooksIndex = lines
    .slice(featureIndex + 1, nextSectionIndex)
    .findIndex(line => /^\s*hooks\s*=/.test(line));

  if (hooksIndex === -1) {
    lines.splice(featureIndex + 1, 0, 'hooks = true');
  } else {
    lines[featureIndex + 1 + hooksIndex] = 'hooks = true';
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function hasCodexHook(config) {
  return commandReferencesFile(config, CODEX_HOOK_FILE);
}

function appendCodexHook(config) {
  const hookPath = resolve(hookRoot, CODEX_HOOK_FILE).replace(/\\/g, '/');
  return `${config.trimEnd()}

[[hooks.PostToolUse]]
matcher = ""
[[hooks.PostToolUse.hooks]]
type = "command"
command = 'node "${hookPath}"'
`;
}

function removeCodexHook(config) {
  const lines = config.split(/\r?\n/);
  const output = [];
  let changed = false;

  for (let i = 0; i < lines.length;) {
    if (lines[i].trim() !== '[[hooks.PostToolUse]]') {
      output.push(lines[i]);
      i++;
      continue;
    }

    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j].trim();
      const startsArray = /^\[\[/.test(line);
      const startsSection = /^\[[^\[]/.test(line);
      if (line === '[[hooks.PostToolUse]]') break;
      if (startsSection) break;
      if (startsArray && line !== '[[hooks.PostToolUse.hooks]]') break;
      j++;
    }

    const block = lines.slice(i, j);
    if (block.some(line => commandReferencesFile(line, CODEX_HOOK_FILE))) {
      changed = true;
    } else {
      output.push(...block);
    }
    i = j;
  }

  return {
    changed,
    config: `${output.join('\n').trimEnd()}\n`,
  };
}

export function getHooksStatus(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
  let claudeEnabled = false;
  let claudeInvalid = false;
  if (existsSync(paths.claudeSettingsPath)) {
    try {
      const settings = readJsonConfig(paths.claudeSettingsPath);
      claudeEnabled = Array.isArray(settings.hooks?.PostToolUse) &&
        settings.hooks.PostToolUse.some(isClaudeHook);
    } catch {
      claudeInvalid = true;
    }
  }

  let codexEnabled = false;
  if (existsSync(paths.codexConfigPath)) {
    codexEnabled = hasCodexHook(readFileSync(paths.codexConfigPath, 'utf8'));
  }

  return {
    projectRoot: paths.root,
    stepsInitialized: existsSync(paths.stepsDbPath),
    claude: {
      configPath: paths.claudeSettingsPath,
      configExists: existsSync(paths.claudeSettingsPath),
      enabled: claudeEnabled,
      invalid: claudeInvalid,
    },
    codex: {
      configPath: paths.codexConfigPath,
      configExists: existsSync(paths.codexConfigPath),
      enabled: codexEnabled,
    },
  };
}

export async function initStepTracking(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
  const stepsDir = join(paths.root, '.ccusage');
  if (!existsSync(stepsDir)) mkdirSync(stepsDir, { recursive: true });
  const tracker = new StepTracker(paths.root);
  await tracker.open();
  const stats = tracker.getStats();
  tracker.close();
  return { dbPath: paths.stepsDbPath, ...stats };
}

export function enableClaudeHooks(projectRoot = process.cwd(), options = {}) {
  const paths = projectPaths(projectRoot);
  const settings = readJsonConfig(paths.claudeSettingsPath);
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

  if (settings.hooks.PostToolUse.some(isClaudeHook)) {
    return { tool: HOOK_TOOLS.CLAUDE, changed: false, configPath: paths.claudeSettingsPath, backupPath: null };
  }

  const hookPath = resolve(hookRoot, CLAUDE_HOOK_FILE);
  settings.hooks.PostToolUse.push({
    matcher: '',
    hooks: [{ type: 'command', command: `node "${hookPath}"` }],
  });

  const backupPath = options.backup === false ? null : backupFile(paths.claudeSettingsPath);
  if (!existsSync(paths.claudeSettingsDir)) mkdirSync(paths.claudeSettingsDir, { recursive: true });
  writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings, null, 2));
  return { tool: HOOK_TOOLS.CLAUDE, changed: true, configPath: paths.claudeSettingsPath, backupPath };
}

export function disableClaudeHooks(projectRoot = process.cwd(), options = {}) {
  const paths = projectPaths(projectRoot);
  if (!existsSync(paths.claudeSettingsPath)) {
    return { tool: HOOK_TOOLS.CLAUDE, changed: false, configPath: paths.claudeSettingsPath, backupPath: null };
  }

  const settings = readJsonConfig(paths.claudeSettingsPath);
  const current = Array.isArray(settings.hooks?.PostToolUse) ? settings.hooks.PostToolUse : [];
  const next = current.filter(entry => !isClaudeHook(entry));
  if (next.length === current.length) {
    return { tool: HOOK_TOOLS.CLAUDE, changed: false, configPath: paths.claudeSettingsPath, backupPath: null };
  }

  settings.hooks.PostToolUse = next;
  const backupPath = options.backup === false ? null : backupFile(paths.claudeSettingsPath);
  writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings, null, 2));
  return { tool: HOOK_TOOLS.CLAUDE, changed: true, configPath: paths.claudeSettingsPath, backupPath };
}

export function enableCodexHooks(projectRoot = process.cwd(), options = {}) {
  const paths = projectPaths(projectRoot);
  let config = existsSync(paths.codexConfigPath)
    ? readFileSync(paths.codexConfigPath, 'utf8')
    : '';

  const original = config;
  config = ensureHooksFeature(config);
  if (!hasCodexHook(config)) config = appendCodexHook(config);

  if (config === original) {
    return { tool: HOOK_TOOLS.CODEX, changed: false, configPath: paths.codexConfigPath, backupPath: null };
  }

  const backupPath = options.backup === false ? null : backupFile(paths.codexConfigPath);
  if (!existsSync(paths.codexConfigDir)) mkdirSync(paths.codexConfigDir, { recursive: true });
  writeFileSync(paths.codexConfigPath, config);
  return { tool: HOOK_TOOLS.CODEX, changed: true, configPath: paths.codexConfigPath, backupPath };
}

export function disableCodexHooks(projectRoot = process.cwd(), options = {}) {
  const paths = projectPaths(projectRoot);
  if (!existsSync(paths.codexConfigPath)) {
    return { tool: HOOK_TOOLS.CODEX, changed: false, configPath: paths.codexConfigPath, backupPath: null };
  }

  const config = readFileSync(paths.codexConfigPath, 'utf8');
  const removed = removeCodexHook(config);
  if (!removed.changed) {
    return { tool: HOOK_TOOLS.CODEX, changed: false, configPath: paths.codexConfigPath, backupPath: null };
  }

  const backupPath = options.backup === false ? null : backupFile(paths.codexConfigPath);
  writeFileSync(paths.codexConfigPath, removed.config);
  return { tool: HOOK_TOOLS.CODEX, changed: true, configPath: paths.codexConfigPath, backupPath };
}

export function enableHooks(projectRoot = process.cwd(), tools = [HOOK_TOOLS.CLAUDE, HOOK_TOOLS.CODEX], options = {}) {
  return tools.map(tool => {
    if (tool === HOOK_TOOLS.CLAUDE) return enableClaudeHooks(projectRoot, options);
    if (tool === HOOK_TOOLS.CODEX) return enableCodexHooks(projectRoot, options);
    throw new Error(`Unsupported hook tool: ${tool}`);
  });
}

export function disableHooks(projectRoot = process.cwd(), tools = [HOOK_TOOLS.CLAUDE, HOOK_TOOLS.CODEX], options = {}) {
  return tools.map(tool => {
    if (tool === HOOK_TOOLS.CLAUDE) return disableClaudeHooks(projectRoot, options);
    if (tool === HOOK_TOOLS.CODEX) return disableCodexHooks(projectRoot, options);
    throw new Error(`Unsupported hook tool: ${tool}`);
  });
}
