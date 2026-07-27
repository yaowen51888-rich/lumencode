#!/usr/bin/env node
/**
 * Install Gemini CLI AfterTool hook.
 * Usage: node hooks/install-gemini.js
 */
import { enableGeminiHooks } from '../lib/hooks-manager.js';

const result = enableGeminiHooks(process.cwd(), { backup: false });
console.log(result.changed ? `Gemini hook installed in ${result.configPath}` : 'Gemini hook already installed.');
