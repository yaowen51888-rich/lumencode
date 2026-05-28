#!/usr/bin/env node
/**
 * Install PostToolUse hook into Codex config.
 * Usage: node hooks/install-codex.js
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const projectRoot = process.cwd();
const hookRoot = dirname(fileURLToPath(import.meta.url));
const configDir = join(projectRoot, '.codex');
const configPath = join(configDir, 'config.toml');

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

let config = '';
if (existsSync(configPath)) {
  try { config = readFileSync(configPath, 'utf8'); } catch { config = ''; }
}

config = ensureHooksFeature(config);

if (!config.includes('codex-hook')) {
  const hookPath = resolve(hookRoot, 'codex-hook.js');
  config = `${config.trimEnd()}

[[hooks.PostToolUse]]
matcher = ""
[[hooks.PostToolUse.hooks]]
type = "command"
command = 'node "${hookPath}"'
`;
}

if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
writeFileSync(configPath, config);
console.log(`Codex hook installed in ${configPath}`);
