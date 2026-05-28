#!/usr/bin/env node
/**
 * Install PostToolUse hook into Codex config.
 * Usage: node hooks/install-codex.js
 */
import { enableCodexHooks } from '../lib/hooks-manager.js';

const result = enableCodexHooks(process.cwd(), { backup: false });
console.log(result.changed ? `Codex hook installed in ${result.configPath}` : 'Codex hook already installed.');
