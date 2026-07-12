#!/usr/bin/env node
import { join } from 'path';
import { StepDatabase } from '../../lib/step-schema.js';

const [root] = process.argv.slice(2);
const db = new StepDatabase();
await db.open(join(root, 'steps.db'));
process.stdout.write('ready\n');
let index = 0;
while (true) {
  db.transaction(() => {
    for (let count = 0; count < 100; count++) {
      db.insertStep({
        id: `kill-${process.pid}-${index++}`,
        sessionId: 'kill-session',
        ts: Date.now(),
        toolName: 'Write',
        toolUseId: `kill-${index}`,
      });
    }
  });
}