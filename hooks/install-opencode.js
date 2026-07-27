#!/usr/bin/env node
/**
 * Install OpenCode step-tracking plugin.
 * Usage: node hooks/install-opencode.js
 */
import { enableOpenCodeHooks } from '../lib/hooks-manager.js';

const result = enableOpenCodeHooks(process.cwd(), { backup: false });
console.log(result.changed ? `OpenCode hook installed in ${result.configPath}` : 'OpenCode hook already installed.');
