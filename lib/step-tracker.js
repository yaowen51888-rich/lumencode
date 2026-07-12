import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { StepDatabase } from './step-schema.js';
import { migrateLegacyStepDatabase, resolveStepDbPath } from './step-db-paths.js';
import { computeBlame, buildInitialBlameMap, projectStepBlameToCommit, UNKNOWN_BLAME } from './line-blame.js';
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
    this.configuredDbPath = options.dbPath || null;
    const resolvedDbPath = resolveStepDbPath(this.projectRoot, this.configuredDbPath);
    this.dbPath = resolvedDbPath.dbPath;
    this.db = null;
    this.maxFileSize = options.maxFileSize || MAX_FILE_SIZE;
    // ponytail: fuzzy 内容对齐覆盖阈值——drift 时 commit↔step 行映射覆盖 added 行比例达此值才逐行投影，否则回比例法
    this.fuzzyCoverageThreshold = options.fuzzyCoverageThreshold ?? 0.6;
  }

  async open(options = {}) {
    const resolvedDbPath = migrateLegacyStepDatabase(this.projectRoot, this.configuredDbPath);
    this.dbPath = resolvedDbPath.dbPath;
    this.db = new StepDatabase();
    await this.db.open(this.dbPath, {
      projectRoot: this.projectRoot,
      readonly: options.readonly === true,
    });
    return this;
  }

  close() {
    if (this.db) {
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

  // 最近一次 step 入库时间（ms epoch），无 db/无数据返回 null
  getLastStepTimestamp() {
    if (!this.db) return null;
    return this.db.getLastStepTs();
  }

  async getLastStepTimestampAsync() {
    if (!existsSync(this.dbPath)) return null;
    try {
      const tempDb = new StepDatabase();
      await tempDb.open(this.dbPath);
      const ts = tempDb.getLastStepTs();
      tempDb.close();
      return ts;
    } catch { return null; }
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
    const stepFiles = [];
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

      stepFiles.push({ filePath, newBlameMap, newContent });
    }

    this.db.transaction(() => {
      for (const file of stepFiles) {
        this.db.upsertStepFile(stepHash, file.filePath, file.newBlameMap, file.newContent);
      }
      this.db.insertStep({
        id: stepHash,
        parentId: parentStepId,
        sessionId,
        origin,
        ts: timestamp,
        toolName,
        toolUseId,
      });

      this.db.upsertSession({
        id: sessionId,
        origin,
        headStepId: stepHash,
      });
    });
    return stepHash;
  }

  // ── Line attribution for a commit ──

  getLineAttributionForCommit(commit) {
    if (!this.db) return null;

    const result = {
      aiLines: 0,
      humanLines: 0,
      unknownLines: 0,
      aiDeletedLines: 0,
      humanDeletedLines: 0,
      unknownDeletedLines: 0,
      totalLines: 0,
      fileBreakdown: {},
      source: 'step_blame',
      mappedAddedLines: 0,
      mappableAddedLines: 0,
      // 行级归因可观测性：逐行投影 vs 比例法降级的文件计数（诊断行级精度用）
      alignedFiles: 0,
      degradedFiles: 0,
      // 降级主因细分：fuzzy 内容对齐仅能救 drift，noContent/noAdded 救不了
      degradedDrift: 0,
      degradedNoContent: 0,
      degradedNoAdded: 0,
      // fuzzy 内容对齐命中（drift 但行映射覆盖达标，仍逐行投影）
      fuzzyFiles: 0,
    };

    // ponytail: 档①时间对齐 —— 只取 commit 时刻及之前的 step，杜绝未来 AI 编辑污染历史 commit 归因
    const commitMs = Number.isFinite(commit.commitMs) ? commit.commitMs : null;

    for (const file of commit.files || []) {
      const filePath = normalizeCommitFilePath(file.path);
      if (shouldIgnore(filePath)) continue;

      // 时间过滤后的候选 step（DESC by ts，已对齐到 commit 时刻）
      let stepFiles = this.db.getStepFilesForPath(filePath, 5, commitMs);
      // ponytail: commit 时刻之前无 step 记录（commit 早于所有 step：时钟漂移 / 时序异常），
      // 退化为全量取最近 step 近似，避免直接返回 null 丢失归因。真实场景 commit 晚于 step，不触发。
      if (stepFiles.length === 0 && commitMs !== null) {
        stepFiles = this.db.getStepFilesForPath(filePath, 5);
      }
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

      // 使用所有相关 step 的 ID（包括 commit 关联的 session 和其他 session）
      const stepIds = new Set(relevantSteps.map(s => s.step_id));

      // 整文件逐行 AI/human 统计（降级比例法 + 对齐校验共用）
      let fileAI = 0;
      let fileHuman = 0;
      for (const lineStep of blameMap.lines) {
        if (stepIds.has(lineStep)) {
          fileAI++;
        } else {
          fileHuman++;
        }
      }
      const fileTotal = fileAI + fileHuman;
      const aiRatio = fileTotal > 0 ? fileAI / fileTotal : 0;

      const totalChanged = (file.added || 0) + (file.deleted || 0);
      if (totalChanged === 0) continue;

      // ponytail: 档②逐行投影 —— commit 文件内容 === step 记录内容（人未手改）时，
      // 逐 added 行查 blameMap 精确归属；否则降级整文件比例法。
      // 上限：逐行投影仅限 added（产出行），deleted 无 commit 前 blameMap 坐标，恒走比例。
      // ponytail: 换行符归一（step 存 CRLF / git show 出 LF），否则精确等判定与 fuzzy 行映射全失效
      const normCRLF = s => typeof s === 'string' ? s.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : s;
      const stepContent = normCRLF(this.db.getFileBlob(latestStep.step_id, filePath));
      const commitContentN = normCRLF(file.commitContent);
      const hasCommitContent = typeof commitContentN === 'string';
      const hasStepContent = stepContent !== null;
      const hasAddedLines = Array.isArray(file.addedLines) && file.addedLines.length > 0;
      const contentEqual = hasCommitContent && hasStepContent && commitContentN === stepContent;
      const aligned = contentEqual && hasAddedLines;

      let fileAIAdded;
      let fileHumanAdded;
      let fileUnknownAdded = 0;
      let fileMappedAdded = 0;
      let fileMappableAdded = 0;
      if (aligned) {
        result.alignedFiles++;
        let ai = 0;
        let human = 0;
        let unknown = 0;
        fileMappableAdded = file.addedLines.length;
        for (const n of file.addedLines) {
          const idx = n - 1;
          if (idx >= 0 && idx < blameMap.lines.length) {
            fileMappedAdded++;
            const lineBlame = blameMap.lines[idx];
            if (!lineBlame || lineBlame === UNKNOWN_BLAME) unknown++;
            else if (stepIds.has(lineBlame)) ai++;
            else human++;
          } else {
            unknown++;
          }
        }
        fileAIAdded = ai;
        fileHumanAdded = human;
        fileUnknownAdded = unknown;
      } else if (!hasCommitContent || !hasStepContent) {
        result.degradedFiles++;
        result.degradedNoContent++;
        fileAIAdded = Math.round((file.added || 0) * aiRatio);
        fileHumanAdded = (file.added || 0) - fileAIAdded;
      } else if (!contentEqual) {
        // drift：commit≠step，fuzzy 行映射投影逐行归属；覆盖不足回比例法
        const fuzzy = projectStepBlameToCommit(stepContent, commitContentN, blameMap, file.addedLines || [], stepIds);
        if (fuzzy.coverage >= this.fuzzyCoverageThreshold) {
          result.fuzzyFiles++;
          fileAIAdded = fuzzy.aiAdded;
          fileHumanAdded = fuzzy.humanAdded;
          fileUnknownAdded = fuzzy.unknownAdded || 0;
          fileMappableAdded = (file.addedLines || []).length;
          fileMappedAdded = Math.round(fuzzy.coverage * fileMappableAdded);
        } else {
          result.degradedFiles++;
          result.degradedDrift++;
          fileAIAdded = Math.round((file.added || 0) * aiRatio);
          fileHumanAdded = (file.added || 0) - fileAIAdded;
        }
      } else {
        result.degradedFiles++;
        result.degradedNoAdded++;
        fileAIAdded = Math.round((file.added || 0) * aiRatio);
        fileHumanAdded = (file.added || 0) - fileAIAdded;
      }

      const fileAIDeleted = Math.round((file.deleted || 0) * aiRatio);
      const fileHumanDeleted = (file.deleted || 0) - fileAIDeleted;
      const fileUnknownDeleted = 0;

      result.aiLines += fileAIAdded;
      result.humanLines += fileHumanAdded;
      result.unknownLines += fileUnknownAdded;
      result.aiDeletedLines += fileAIDeleted;
      result.humanDeletedLines += fileHumanDeleted;
      result.unknownDeletedLines += fileUnknownDeleted;
      result.totalLines += totalChanged;
      result.mappedAddedLines += fileMappedAdded;
      result.mappableAddedLines += fileMappableAdded;
      result.fileBreakdown[filePath] = {
        aiLines: fileAIAdded,
        humanLines: fileHumanAdded,
        unknownLines: fileUnknownAdded,
        aiDeletedLines: fileAIDeleted,
        humanDeletedLines: fileHumanDeleted,
        unknownDeletedLines: fileUnknownDeleted,
        lineCoverage: fileMappableAdded > 0 ? fileMappedAdded / fileMappableAdded : 0,
      };
    }

    if (result.totalLines === 0) return null;
    result.lineCoverage = result.mappableAddedLines > 0
      ? result.mappedAddedLines / result.mappableAddedLines
      : 0;
    return result;
  }

  // ── Backfill from existing session data ──

  async backfillFromSession(session) {
    if (!this.db) await this.open();

    const sessionId = session.id || 'unknown';
    let stepCount = 0;

    this.db.transaction(() => {
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
    });

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


