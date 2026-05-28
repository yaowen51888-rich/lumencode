#!/usr/bin/env node
/**
 * Install PostToolUse hook into Claude Code settings.
 * Usage: node hooks/install.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const projectRoot = process.cwd();
const hookRoot = dirname(fileURLToPath(import.meta.url));
const settingsDir = join(projectRoot, '.claude');
const settingsPath = join(settingsDir, 'settings.local.json');

let settings = {};
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settings = {}; }
}

if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

const hookPath = resolve(hookRoot, 'post-tool-use.js');
const existing = settings.hooks.PostToolUse.find(h =>
  typeof h === 'object' && h.hooks?.some(sub => sub.command?.includes('post-tool-use'))
);

if (!existing) {
  settings.hooks.PostToolUse.push({
    matcher: '',
    hooks: [{ type: 'command', command: `node "${hookPath}"` }],
  });
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`Hook installed in ${settingsPath}`);
} else {
  console.log('Hook already installed.');
}
