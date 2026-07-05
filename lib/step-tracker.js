import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { StepDatabase } from './step-schema.js';
import { computeBlame, buildInitialBlameMap } from './line-blame.js';
import {
  normalizeCommitFilePath,
  toRepoRelativePath,
} from './git-paths.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__']);

function shouldIgnore(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts.some(p => IGNORED_DIRS.has(p));
}

function generateStepHash(data) {
  const raw = typeof data === 'string' ? data : JSON.stringify(data);
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function normalizePath(filePath, projectRoot) {
  if (!filePath) return '';
  const relative = toRepoRelativePath(filePath, projectRoot);
  return normalizeCommitFilePath(relative);
}

function extractPatchTargetFiles(patchText, projectRoot) {
  const files = [];
  const patch = String(patchText || '');
  const markerRe = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s+(.+)$/gm;
  let match;
  while ((match = markerRe.exec(patch)) !== null) {
    const normalized = normalizePath(match[1].trim(), projectRoot);
    if (normalized) files.push(normalized);
  }
  return files;
}

// Extract file paths from tool input (reuses logic from git.js)
function extractTargetFiles(toolName, toolInput, projectRoot) {
  const files = [];
  const input = toolInput || {};
  const normalizedTool = String(toolName || '').toLowerCase();

  if (['write', 'edit', 'multiedit', 'notebookedit', 'file_write', 'file_edit', 'write_file', 'edit_file', 'replace'].includes(normalizedTool)) {
    const rawPath = input.file_path || input.filePath || input.filepath || input.path || '';
    if (rawPath) {
      const normalized = normalizePath(rawPath, projectRoot);
      if (normalized) files.push(normalized);
    }
  } else if (normalizedTool === 'bash' || normalizedTool === 'shell') {
    // Minimal extraction for shell commands touching files
    const cmd = input.command || input.cmd || '';
    const redirectRe = />>?\s*['"]?([^&|;\s<>$`'"]+)['"]?/g;
    let m;
    while ((m = redirectRe.exec(cmd)) !== null) {
      const p = normalizePath(m[1], projectRoot);
      if (p) files.push(p);
    }
  } else if (normalizedTool === 'apply_patch') {
    files.push(...extractPatchTargetFiles(input.patchText || input.patch_text || input.patch, projectRoot));
  } else if (String(toolName || '').startsWith('mcp__')) {
    const rawPath = input.relative_path || input.file_path || input.path || '';
    if (rawPath) {
      const normalized = normalizePath(rawPath, projectRoot);
      if (normalized) files.push(normalized);
    }
  }

  return files.filter(f => !shouldIgnore(f));
}

export class StepTracker {
  constructor(projectRoot, options = {}) {
    this.projectRoot = resolve(projectRoot || process.cwd());
    this.dbPath = options.dbPath
      ? (isAbsolute(options.dbPath) ? options.dbPath : join(this.projectRoot, options.dbPath))
      : join(this.projectRoot, '.ccusage', 'steps.db');
    this.db = null;
    this.maxFileSize = options.maxFileSize || MAX_FILE_SIZE;
  }

  async open() {
    this.db = new StepDatabase();
    await this.db.open(this.dbPath);
    return this;
  }

  close() {
    if (this.db) {
      this.db.save();
      this.db.close();
      this.db = null;
    }
  }

  isAvailable() {
    return this.db && this.db.getStepCount() > 0;
  }

  async isAvailableAsync() {
    if (!existsSync(this.dbPath)) return false;
    try {
      const tempDb = new StepDatabase();
      await tempDb.open(this.dbPath);
      const count = tempDb.getStepCount();
      tempDb.close();
      return count > 0;
    } catch { return false; }
  }

  // ── Record a tool use step ──

  async recordStep(payload) {
    if (!this.db) await this.open();

    const sessionId = payload.sessionId || 'unknown';
    const origin = payload.origin || 'claude_code';
    const toolName = payload.toolName || '';
    const toolUseId = payload.toolUseId || generateStepHash(`${sessionId}:${Date.now()}`);
    const timestamp = payload.timestamp ? new Date(payload.timestamp).getTime() : Date.now();

    // Extract target files from tool input
    const explicitTargets = Array.isArray(payload.targetFiles)
      ? payload.targetFiles.map(file => normalizePath(file, this.projectRoot)).filter(Boolean)
      : [];
    const batchTargets = Array.isArray(payload.toolCalls)
      ? payload.toolCalls.flatMap(call => extractTargetFiles(
        call.toolName || call.tool_name || call.name || call.tool || '',
        call.toolInput || call.tool_input || call.input || call.args || {},
        this.projectRoot
      ))
      : [];
    const targetFiles = [...new Set([
      ...explicitTargets,
      ...batchTargets,
      ...extractTargetFiles(toolName, payload.toolInput || {}, this.projectRoot),
    ])];
    if (targetFiles.length === 0) return null;

    // Get parent step for session
    const parentStepId = this.db.getSessionHead(sessionId);

    // Generate step hash
    const stepHash = generateStepHash(
      `${parentStepId}:${sessionId}:${toolName}:${toolUseId}:${timestamp}`
    );

    // Compute blame for each target file
    for (const filePath of targetFiles) {
      const absPath = resolve(this.projectRoot, filePath);
      if (!existsSync(absPath)) continue;

      const stat = statSync(absPath);
      if (stat.size > this.maxFileSize) continue;

      const newContent = readFileSync(absPath, 'utf-8');

      // Get old content and blame from parent step
      let oldContent = null;
      let oldBlameMap = null;
      if (parentStepId) {
        oldContent = this.db.getFileBlob(parentStepId, filePath);
        oldBlameMap = this.db.getBlameMap(parentStepId, filePath);
      }

      let newBlameMap;
      if (oldContent !== null) {
        newBlameMap = computeBlame(oldContent, newContent, oldBlameMap, stepHash);
      } else {
        newBlameMap = buildInitialBlameMap(newContent, stepHash);
      }

      this.db.upsertStepFile(stepHash, filePath, newBlameMap, newContent);
    }

    // Write step record
    this.db.insertStep({
      id: stepHash,
      parentId: parentStepId,
      sessionId,
      origin,
      ts: timestamp,
      toolName,
      toolUseId,
    });

    // Update session head
    this.db.upsertSession({
      id: sessionId,
      origin,
      headStepId: stepHash,
    });

    this.db.save();
    return stepHash;
  }

  // ── Line attribution for a commit ──

  getLineAttributionForCommit(commit) {
    if (!this.db) return null;

    const result = {
      aiLines: 0,
      humanLines: 0,
      aiDeletedLines: 0,
      humanDeletedLines: 0,
      totalLines: 0,
      fileBreakdown: {},
      source: 'step_blame',
    };

    for (const file of commit.files || []) {
      const filePath = normalizeCommitFilePath(file.path);
      if (shouldIgnore(filePath)) continue;

      // Find the latest step for this file
      const stepFiles = this.db.getStepFilesForPath(filePath, 5);
      if (stepFiles.length === 0) continue;

      // 优先查找 commit 关联的 session，如果没有则查找任何 session
      // 这解决了多工具协作场景：Codex 写代码 + Claude Code 提交
      let relevantSteps = commit.sessionId
        ? stepFiles.filter(sf => sf.session_id === commit.sessionId)
        : [];
      if (relevantSteps.length === 0) {
        relevantSteps = stepFiles;
      }

      const latestStep = relevantSteps[0]; // already sorted DESC by ts
      const blameMap = this.db.getBlameMap(latestStep.step_id, filePath);
      if (!blameMap || !blameMap.lines) continue;

      // Count AI vs human lines in the blame map
      // 使用所有相关 step 的 ID（包括 commit 关联的 session 和其他 session）
      const stepIds = new Set(relevantSteps.map(s => s.step_id));
      let fileAI = 0;
      let fileHuman = 0;

      for (const lineStep of blameMap.lines) {
        if (stepIds.has(lineStep)) {
          fileAI++;
        } else {
          fileHuman++;
        }
      }

      const totalChanged = (file.added || 0) + (file.deleted || 0);
      if (totalChanged === 0) continue;

      // Proportionally attribute added/deleted lines
      const fileTotal = fileAI + fileHuman;
      const aiRatio = fileTotal > 0 ? fileAI / fileTotal : 0;

      const fileAIAdded = Math.round((file.added || 0) * aiRatio);
      const fileHumanAdded = (file.added || 0) - fileAIAdded;
      const fileAIDeleted = Math.round((file.deleted || 0) * aiRatio);
      const fileHumanDeleted = (file.deleted || 0) - fileAIDeleted;

      result.aiLines += fileAIAdded;
      result.humanLines += fileHumanAdded;
      result.aiDeletedLines += fileAIDeleted;
      result.humanDeletedLines += fileHumanDeleted;
      result.totalLines += totalChanged;
      result.fileBreakdown[filePath] = { aiLines: fileAIAdded, humanLines: fileHumanAdded, aiDeletedLines: fileAIDeleted, humanDeletedLines: fileHumanDeleted };
    }

    if (result.totalLines === 0) return null;
    return result;
  }

  // ── Backfill from existing session data ──

  async backfillFromSession(session) {
    if (!this.db) await this.open();

    const sessionId = session.id || 'unknown';
    let stepCount = 0;

    for (const tc of session.toolSequence || []) {
      const targetFiles = extractTargetFiles(tc.name, tc.input, this.projectRoot);
      if (targetFiles.length === 0) continue;

      const timestamp = tc.timestamp ? new Date(tc.timestamp).getTime() : Date.now();
      const parentStepId = this.db.getSessionHead(sessionId);
      const stepHash = generateStepHash(
        `backfill:${parentStepId}:${sessionId}:${tc.name}:${timestamp}`
      );

      for (const filePath of targetFiles) {
        const absPath = resolve(this.projectRoot, filePath);
        if (!existsSync(absPath)) continue;

        const stat = statSync(absPath);
        if (stat.size > this.maxFileSize) continue;

        const content = readFileSync(absPath, 'utf-8');
        const blameMap = buildInitialBlameMap(content, stepHash);
        this.db.upsertStepFile(stepHash, filePath, blameMap);
      }

      this.db.insertStep({
        id: stepHash,
        parentId: parentStepId,
        sessionId,
        ts: timestamp,
        toolName: tc.name,
        toolUseId: `backfill-${stepCount}`,
      });

      this.db.upsertSession({ id: sessionId, headStepId: stepHash });
      stepCount++;
    }

    if (stepCount > 0) this.db.save();
    return stepCount;
  }

  // ── Stats ──

  getStats() {
    if (!this.db) return { stepCount: 0, sessionCount: 0 };
    return {
      stepCount: this.db.getStepCount(),
      sessionCount: this.db.getSessionCount(),
    };
  }
}
