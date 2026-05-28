#!/usr/bin/env node
/**
 * Initialize step tracking database for the current project.
 * Usage: node hooks/init-steps.js
 */
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { StepTracker } from '../lib/step-tracker.js';

const projectRoot = process.cwd();
const stepsDir = resolve(projectRoot, '.ccusage');

if (!existsSync(stepsDir)) mkdirSync(stepsDir, { recursive: true });

const tracker = new StepTracker(projectRoot);
await tracker.open();

const stats = tracker.getStats();
console.log(`Step tracking initialized at .ccusage/steps.db`);
console.log(`  Steps: ${stats.stepCount}, Sessions: ${stats.sessionCount}`);

tracker.close();
