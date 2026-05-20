#!/usr/bin/env node
import { loadConfig } from '../lib/config.js';
import { registerParser, parseAllEnabledTools } from '../lib/parsers/index.js';
import { ClaudeParser } from '../lib/parsers/claude.js';
import { groupBySessions } from '../lib/aggregate.js';

registerParser(ClaudeParser);

const config = loadConfig();
const { records } = await parseAllEnabledTools(config);
const sessions = groupBySessions(records);

console.log(`总 session 数: ${sessions.length}\n`);

for (const s of sessions.slice(0, 8)) {
  const writeTools = (s.toolSequence || []).filter(tc => ['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(tc.name));
  const bashTools = (s.toolSequence || []).filter(tc => tc.name === 'Bash');
  console.log(`Session: ${s.id.slice(0, 8)} | 项目: ${s.project || '无'}`);
  console.log(`  Write/Edit 工具数: ${writeTools.length}`);
  console.log(`  Bash 工具数: ${bashTools.length}`);
  console.log(`  git commit Bash: ${bashTools.filter(tc => /\bgit\s+commit\b/i.test(tc.input?.command || '')).length}`);
  if (writeTools.length > 0) {
    console.log(`  Write/Edit 输入样例:`);
    for (const tc of writeTools.slice(0, 3)) {
      console.log(`    ${tc.name}: ${JSON.stringify(tc.input).slice(0, 120)}`);
    }
  }
  if (bashTools.length > 0) {
    console.log(`  Bash 命令样例:`);
    for (const tc of bashTools.slice(0, 3)) {
      console.log(`    ${tc.input?.command?.slice(0, 100) || 'no command'}`);
    }
  }
  console.log('');
}
