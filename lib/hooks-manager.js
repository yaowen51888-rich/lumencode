import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { StepTracker } from './step-tracker.js';
import { ensureStepDatabaseGitignore, resolveStepDbPath } from './step-db-paths.js';
import { readStepDatabaseStatus } from './step-db-status.js';

const libRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(libRoot, '..');
const hookRoot = resolve(packageRoot, 'hooks');

const CLAUDE_LEGACY_HOOK_FILE = 'post-tool-use.js';
const CLAUDE_BATCH_HOOK_FILE = 'claude-post-tool-batch.js';
const CODEX_HOOK_FILE = 'codex-hook.js';
const OPENCODE_HOOK_FILE = 'opencode-hook.js';
const OPENCODE_PLUGIN_FILE = 'lumencode-step-tracker.js';
const OPENCODE_PLUGIN_MARKER = 'LUMENCODE_STEP_TRACKER_PLUGIN';
const GEMINI_HOOK_FILE = 'gemini-hook.js';

export const HOOK_TOOLS = Object.freeze({
  CLAUDE: 'claude',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  GEMINI: 'gemini',
});

function projectPaths(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const stepDb = resolveStepDbPath(root);
  return {
    root,
    stepsDbPath: stepDb.dbPath,
    claudeSettingsDir: join(root, '.claude'),
    claudeSettingsPath: join(root, '.claude', 'settings.local.json'),
    codexConfigDir: join(root, '.codex'),
    codexConfigPath: join(root, '.codex', 'config.toml'),
    opencodePluginDir: join(root, '.opencode', 'plugins'),
    opencodePluginPath: join(root, '.opencode', 'plugins', OPENCODE_PLUGIN_FILE),
    geminiSettingsDir: join(root, '.gemini'),
    geminiSettingsPath: join(root, '.gemini', 'settings.json'),
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

function isClaudeHook(entry, fileName) {
  return Boolean(
    entry &&
    typeof entry === 'object' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(sub => commandReferencesFile(sub?.command, fileName))
  );
}

function isAnyClaudeHook(entry) {
  return isClaudeHook(entry, CLAUDE_BATCH_HOOK_FILE) || isClaudeHook(entry, CLAUDE_LEGACY_HOOK_FILE);
}

function commandReferencesFile(command, fileName) {
  if (typeof command !== 'string') return false;
  const normalized = command.replace(/\\/g, '/');
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|/)${escaped}(["'\\s]|$)`).test(normalized);
}

// hook 失效阈值：最近一次 step 入库距今超过此值视为 stale。
// 72h 容忍 quiet project；如需更敏感可经 config 暴露。ponytail: 固定常量，够用。
const HOOK_STALE_MS = 72 * 60 * 60 * 1000;

// 从 `node "/abs/path/foo.js"` 串里提取引号内 .js 路径
function extractCommandPath(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/["']([^"']+\.js)["']/);
  return match ? match[1] : null;
}

// entry 已确认引用 fileName；检查该引用指向的文件是否在磁盘上缺失
function referencedHookFileMissing(entry, fileName) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(sub => {
    if (!commandReferencesFile(sub?.command, fileName)) return false;
    const p = extractCommandPath(sub?.command);
    return p !== null && !existsSync(p);
  });
}

// TOML 文本里查 codex hook 命令行，提取路径校验缺失
function codexHookFileMissing(configText, fileName) {
  const lines = String(configText || '').split(/\r?\n/);
  const line = lines.find(l => commandReferencesFile(l, fileName));
  if (!line) return false;
  const p = extractCommandPath(line);
  return p !== null && !existsSync(p);
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

function buildOpenCodePlugin() {
  const hookPath = resolve(hookRoot, OPENCODE_HOOK_FILE);
  return `// ${OPENCODE_PLUGIN_MARKER}
// Generated by LumenCode. Project-local plugin; safe to remove with hooks disable.

import { spawn } from "child_process";

export const LumencodeStepTracker = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      const payload = {
        input,
        output,
        cwd: input?.cwd || input?.directory || (typeof process !== "undefined" && process.cwd ? process.cwd() : undefined),
        sessionId: input?.sessionID || input?.sessionId || input?.session_id || input?.session?.id,
        toolUseId: input?.toolCallID || input?.toolUseId || input?.id,
        toolName: input?.toolName || input?.tool || input?.tool?.name,
        toolInput: output?.args || input?.args || input?.toolInput,
        toolResponse: output?.result || output,
        timestamp: new Date().toISOString(),
      };
      const proc = spawn("node", [${JSON.stringify(hookPath)}], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
      await new Promise(resolve => proc.on("exit", resolve));
    } catch {}
  },
});
`;
}

function hasOpenCodePlugin(filePath) {
  return existsSync(filePath) && readFileSync(filePath, 'utf8').includes(OPENCODE_PLUGIN_MARKER);
}

function isGeminiHook(entry) {
  return Boolean(
    entry &&
    typeof entry === 'object' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(sub => commandReferencesFile(sub?.command, GEMINI_HOOK_FILE))
  );
}

function hasGeminiHook(config, eventName = 'AfterTool') {
  if (!config || !config.hooks) return false;
  const eventHooks = config.hooks[eventName];
  if (!Array.isArray(eventHooks)) return false;
  return eventHooks.some(entry => isGeminiHook(entry));
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
  let claudeBatchEnabled = false;
  let claudeLegacyEnabled = false;
  let claudeInvalid = false;
  let claudeFileMissing = false;
  if (existsSync(paths.claudeSettingsPath)) {
    try {
      const settings = readJsonConfig(paths.claudeSettingsPath);
      const batchEntry = (settings.hooks?.PostToolBatch || []).find(entry => isClaudeHook(entry, CLAUDE_BATCH_HOOK_FILE));
      const legacyEntry = (settings.hooks?.PostToolUse || []).find(entry => isClaudeHook(entry, CLAUDE_LEGACY_HOOK_FILE));
      claudeBatchEnabled = Boolean(batchEntry);
      claudeLegacyEnabled = Boolean(legacyEntry);
      claudeEnabled = claudeBatchEnabled || claudeLegacyEnabled;
      if (claudeEnabled) {
        claudeFileMissing =
          (batchEntry && referencedHookFileMissing(batchEntry, CLAUDE_BATCH_HOOK_FILE)) ||
          (legacyEntry && referencedHookFileMissing(legacyEntry, CLAUDE_LEGACY_HOOK_FILE));
      }
    } catch {
      claudeInvalid = true;
    }
  }

  let codexEnabled = false;
  let codexFileMissing = false;
  if (existsSync(paths.codexConfigPath)) {
    const codexConfigText = readFileSync(paths.codexConfigPath, 'utf8');
    codexEnabled = hasCodexHook(codexConfigText);
    if (codexEnabled) codexFileMissing = codexHookFileMissing(codexConfigText, CODEX_HOOK_FILE);
  }

  const opencodeEnabled = hasOpenCodePlugin(paths.opencodePluginPath);
  // 插件内容含绝对 hookPath；包迁移/换机器后旧插件内路径失效但文件仍在 → 整文件比对检测过期
  const opencodeStale = opencodeEnabled &&
    readFileSync(paths.opencodePluginPath, 'utf8') !== buildOpenCodePlugin();

  let geminiEnabled = false;
  let geminiInvalid = false;
  let geminiFileMissing = false;
  if (existsSync(paths.geminiSettingsPath)) {
    try {
      const settings = readJsonConfig(paths.geminiSettingsPath);
      const afterTool = Array.isArray(settings.hooks?.AfterTool) ? settings.hooks.AfterTool : [];
      const geminiEntry = afterTool.find(entry => isGeminiHook(entry));
      geminiEnabled = Boolean(geminiEntry);
      if (geminiEnabled) geminiFileMissing = referencedHookFileMissing(geminiEntry, GEMINI_HOOK_FILE);
    } catch {
      geminiInvalid = true;
    }
  }

  return {
    projectRoot: paths.root,
    stepsInitialized: existsSync(paths.stepsDbPath),
    claude: {
      configPath: paths.claudeSettingsPath,
      configExists: existsSync(paths.claudeSettingsPath),
      enabled: claudeEnabled,
      batchEnabled: claudeBatchEnabled,
      legacyEnabled: claudeLegacyEnabled,
      invalid: claudeInvalid,
      fileMissing: claudeFileMissing,
    },
    codex: {
      configPath: paths.codexConfigPath,
      configExists: existsSync(paths.codexConfigPath),
      enabled: codexEnabled,
      fileMissing: codexFileMissing,
    },
    opencode: {
      configPath: paths.opencodePluginPath,
      configExists: existsSync(paths.opencodePluginPath),
      enabled: opencodeEnabled,
      fileMissing: opencodeStale, // 插件内 hookPath 过期（包迁移/换机器），migrate 据此重写
    },
    gemini: {
      configPath: paths.geminiSettingsPath,
      configExists: existsSync(paths.geminiSettingsPath),
      enabled: geminiEnabled,
      invalid: geminiInvalid,
      fileMissing: geminiFileMissing,
    },
    stepDatabaseStatus: readStepDatabaseStatus(paths.root),
  };
}

export async function initStepTracking(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
  ensureStepDatabaseGitignore(paths.root);
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

  const currentUse = Array.isArray(settings.hooks.PostToolUse) ? settings.hooks.PostToolUse : [];
  const currentBatch = Array.isArray(settings.hooks.PostToolBatch) ? settings.hooks.PostToolBatch : [];
  const hasLegacyHook = currentUse.some(entry => isClaudeHook(entry, CLAUDE_LEGACY_HOOK_FILE));
  const nextBatch = currentBatch.filter(entry => !isClaudeHook(entry, CLAUDE_BATCH_HOOK_FILE));

  if (hasLegacyHook && nextBatch.length === currentBatch.length) {
    return { tool: HOOK_TOOLS.CLAUDE, changed: false, configPath: paths.claudeSettingsPath, backupPath: null };
  }

  if (!hasLegacyHook) {
    const hookPath = resolve(hookRoot, CLAUDE_LEGACY_HOOK_FILE);
    settings.hooks.PostToolUse = currentUse;
    settings.hooks.PostToolUse.push({
      matcher: '',
      hooks: [{ type: 'command', command: `node "${hookPath}"` }],
    });
  }
  if (currentBatch.length !== nextBatch.length) settings.hooks.PostToolBatch = nextBatch;

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
  const currentUse = Array.isArray(settings.hooks?.PostToolUse) ? settings.hooks.PostToolUse : [];
  const currentBatch = Array.isArray(settings.hooks?.PostToolBatch) ? settings.hooks.PostToolBatch : [];
  const nextUse = currentUse.filter(entry => !isAnyClaudeHook(entry));
  const nextBatch = currentBatch.filter(entry => !isAnyClaudeHook(entry));
  if (nextUse.length === currentUse.length && nextBatch.length === currentBatch.length) {
    return { tool: HOOK_TOOLS.CLAUDE, changed: false, configPath: paths.claudeSettingsPath, backupPath: null };
  }

  if (settings.hooks?.PostToolUse) settings.hooks.PostToolUse = nextUse;
  if (settings.hooks?.PostToolBatch) settings.hooks.PostToolBatch = nextBatch;
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

export function enableOpenCodeHooks(projectRoot = process.cwd(), options = {}) {
  const paths = projectPaths(projectRoot);
  const plugin = buildOpenCodePlugin();
  if (existsSync(paths.opencodePluginPath) && readFileSync(paths.opencodePluginPath, 'utf8') === plugin) {
    return { tool: HOOK_TOOLS.OPENCODE, changed: false, configPath: paths.opencodePluginPath, backupPath: null };
  }

  const backupPath = options.backup === false ? null : backupFile(paths.opencodePluginPath);
  if (!existsSync(paths.opencodePluginDir)) mkdirSync(paths.opencodePluginDir, { recursive: true });
  writeFileSync(paths.opencodePluginPath, plugin);
  return { tool: HOOK_TOOLS.OPENCODE, changed: true, configPath: paths.opencodePluginPath, backupPath };
}

export function disableOpenCodeHooks(projectRoot = process.cwd(), options = {}) {
  const paths = projectPaths(projectRoot);
  if (!existsSync(paths.opencodePluginPath)) {
    return { tool: HOOK_TOOLS.OPENCODE, changed: false, configPath: paths.opencodePluginPath, backupPath: null };
  }
  if (!hasOpenCodePlugin(paths.opencodePluginPath)) {
    return { tool: HOOK_TOOLS.OPENCODE, changed: false, configPath: paths.opencodePluginPath, backupPath: null };
  }

  const backupPath = options.backup === false ? null : backupFile(paths.opencodePluginPath);
  unlinkSync(paths.opencodePluginPath);
  return { tool: HOOK_TOOLS.OPENCODE, changed: true, configPath: paths.opencodePluginPath, backupPath };
}

export function enableGeminiHooks(projectRoot = process.cwd(), options = {}) {
  const paths = projectPaths(projectRoot);
  const settings = readJsonConfig(paths.geminiSettingsPath);
  if (!settings.hooks) settings.hooks = {};

  const currentAfterTool = Array.isArray(settings.hooks.AfterTool) ? settings.hooks.AfterTool : [];
  if (hasGeminiHook(settings, 'AfterTool')) {
    return { tool: HOOK_TOOLS.GEMINI, changed: false, configPath: paths.geminiSettingsPath, backupPath: null };
  }

  const hookPath = resolve(hookRoot, GEMINI_HOOK_FILE).replace(/\\/g, '/');
  // Match file editing tools: write_*, edit_*, replace
  settings.hooks.AfterTool = currentAfterTool;
  settings.hooks.AfterTool.push({
    matcher: 'write_.*|edit_.*|replace',
    hooks: [{
      name: 'lumencode-step-tracker',
      type: 'command',
      command: `node "${hookPath}"`,
      description: 'Track file edits for line-level attribution',
    }],
  });

  const backupPath = options.backup === false ? null : backupFile(paths.geminiSettingsPath);
  if (!existsSync(paths.geminiSettingsDir)) mkdirSync(paths.geminiSettingsDir, { recursive: true });
  writeFileSync(paths.geminiSettingsPath, JSON.stringify(settings, null, 2));
  return { tool: HOOK_TOOLS.GEMINI, changed: true, configPath: paths.geminiSettingsPath, backupPath };
}

export function disableGeminiHooks(projectRoot = process.cwd(), options = {}) {
  const paths = projectPaths(projectRoot);
  if (!existsSync(paths.geminiSettingsPath)) {
    return { tool: HOOK_TOOLS.GEMINI, changed: false, configPath: paths.geminiSettingsPath, backupPath: null };
  }

  const settings = readJsonConfig(paths.geminiSettingsPath);
  const currentAfterTool = Array.isArray(settings.hooks?.AfterTool) ? settings.hooks.AfterTool : [];
  const nextAfterTool = currentAfterTool.filter(entry => !isGeminiHook(entry));

  if (nextAfterTool.length === currentAfterTool.length) {
    return { tool: HOOK_TOOLS.GEMINI, changed: false, configPath: paths.geminiSettingsPath, backupPath: null };
  }

  if (settings.hooks?.AfterTool) settings.hooks.AfterTool = nextAfterTool;
  const backupPath = options.backup === false ? null : backupFile(paths.geminiSettingsPath);
  writeFileSync(paths.geminiSettingsPath, JSON.stringify(settings, null, 2));
  return { tool: HOOK_TOOLS.GEMINI, changed: true, configPath: paths.geminiSettingsPath, backupPath };
}

export function enableHooks(projectRoot = process.cwd(), tools = [HOOK_TOOLS.CLAUDE, HOOK_TOOLS.CODEX, HOOK_TOOLS.OPENCODE, HOOK_TOOLS.GEMINI], options = {}) {
  return tools.map(tool => {
    if (tool === HOOK_TOOLS.CLAUDE) return enableClaudeHooks(projectRoot, options);
    if (tool === HOOK_TOOLS.CODEX) return enableCodexHooks(projectRoot, options);
    if (tool === HOOK_TOOLS.OPENCODE) return enableOpenCodeHooks(projectRoot, options);
    if (tool === HOOK_TOOLS.GEMINI) return enableGeminiHooks(projectRoot, options);
    throw new Error(`Unsupported hook tool: ${tool}`);
  });
}

// 迁移过期 hook 路径：包重命名/迁移（ccusage-report → lumencode）后，已配置项目的
// settings 仍指向旧 hooks 目录 → fileMissing。enable* 按文件名判重会 no-op（不重写过期路径），
// 故先 disable 移除过期引用，再 enable 用当前 hookRoot 重写。
// best-effort：备份后重写，失败不抛。返回迁移工具列表供日志。
export function migrateStaleHooks(projectRoot = process.cwd()) {
  try {
    const status = getHooksStatus(projectRoot);
    const tools = [];
    if (status.claude?.fileMissing) tools.push(HOOK_TOOLS.CLAUDE);
    if (status.codex?.fileMissing) tools.push(HOOK_TOOLS.CODEX);
    if (status.gemini?.fileMissing) tools.push(HOOK_TOOLS.GEMINI);
    if (status.opencode?.fileMissing) tools.push(HOOK_TOOLS.OPENCODE);
    if (tools.length === 0) return { migrated: false, tools: [] };
    disableHooks(projectRoot, tools, { backup: true });
    enableHooks(projectRoot, tools, { backup: true });
    return { migrated: true, tools };
  } catch {
    return { migrated: false, tools: [], error: true };
  }
}

export function disableHooks(projectRoot = process.cwd(), tools = [HOOK_TOOLS.CLAUDE, HOOK_TOOLS.CODEX, HOOK_TOOLS.OPENCODE, HOOK_TOOLS.GEMINI], options = {}) {
  return tools.map(tool => {
    if (tool === HOOK_TOOLS.CLAUDE) return disableClaudeHooks(projectRoot, options);
    if (tool === HOOK_TOOLS.CODEX) return disableCodexHooks(projectRoot, options);
    if (tool === HOOK_TOOLS.OPENCODE) return disableOpenCodeHooks(projectRoot, options);
    if (tool === HOOK_TOOLS.GEMINI) return disableGeminiHooks(projectRoot, options);
    throw new Error(`Unsupported hook tool: ${tool}`);
  });
}

// hook 健康检查：查 steps.db 最近入库时间，判 stale。
// 仅当 hook 已开启且文件在位时有意义；调用方自行决定是否采纳 stale 判定。
// 无 step 记录视为 fresh（刚启用/尚无 AI 编辑），不报 stale。
export async function getHooksHealth(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
  const tracker = new StepTracker(paths.root);
  const lastStepAt = await tracker.getLastStepTimestampAsync();
  if (lastStepAt === null) return { lastStepAt: null, stale: false };
  return { lastStepAt, stale: Date.now() - lastStepAt > HOOK_STALE_MS };
}

