#!/usr/bin/env node
/**
 * Install PostToolUse hook into Claude Code settings.
 * Usage: node hooks/install.js
 */
import { enableClaudeHooks } from '../lib/hooks-manager.js';

const result = enableClaudeHooks(process.cwd(), { backup: false });

if (result.changed) {
  console.log(`Hook installed in ${result.configPath}`);
} else {
  console.log('Hook already installed.');
}
