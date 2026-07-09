#!/usr/bin/env node
/**
 * Initialize step tracking database for the current project.
 * Usage: node hooks/init-steps.js
 */
import { initStepTracking } from '../lib/hooks-manager.js';

const stats = await initStepTracking(process.cwd());
console.log(`Step tracking initialized at .lumencode/steps.db`);
console.log(`  Steps: ${stats.stepCount}, Sessions: ${stats.sessionCount}`);

