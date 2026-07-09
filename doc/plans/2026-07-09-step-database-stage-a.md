# Step Database Stage A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目级 Step Database 从 `.ccusage/steps.db` 迁移到 `.lumencode/steps.db`，并在 sql.js 路径下补齐阶段 A 的可靠性能力：兼容迁移、进程锁、原子写、损坏自愈、gzip 快照。

**Architecture:** 以 `StepDatabase` 作为并发与持久化边界，路径解析和 legacy 迁移集中到独立模块，避免 `StepTracker`、hooks、server 各自硬编码路径。阶段 A 不引入 `better-sqlite3`，不抽完整数据库适配器，保持当前 sql.js 调用形态。

**Tech Stack:** Node.js ESM、`node:test`、`sql.js`、`fs` 原子文件操作、`zlib` gzip/base64 文本编码。

---

## 已确认决策

- 新默认 Step Database 路径是 `.lumencode/steps.db`。
- Legacy Step Database 路径是 `.ccusage/steps.db`。
- 当配置缺失或仍是旧默认 `.ccusage/steps.db` 时，解析为新默认 `.lumencode/steps.db`。
- 当用户配置非默认 `stepTracking.dbPath` 时，尊重该路径，不做 legacy 迁移。
- legacy 迁移使用 copy，不 move、不删除旧库、不双写。
- `.gitignore` 只在显式 `initStepTracking` / hooks enable 时补 `.lumencode/`，普通 hook 运行不改项目文件。
- 锁下沉到 `StepDatabase` 生命周期。
- hook 写入锁等待 2 秒；显式 init/enable 等待 10 秒；只读状态等待 500ms-2s。
- 新写入 `content_blob` 使用 `gzip:base64:<payload>`；旧明文 blob 继续可读。
- 不做旧 blob 全量重写。
- Windows 原子替换采用 `target -> bak -> tmp -> target`。

## 文件结构

- Create: `lib/step-db-paths.js`
  - 负责 Step Database 默认路径、legacy 路径、配置路径解析、legacy copy 迁移、`.gitignore` 补写。
- Create: `lib/step-db-status.js`
  - 负责 Step Database Status 的读写，记录迁移、损坏自愈、解压失败等用户可见事件。
- Modify: `lib/step-schema.js`
  - 持有数据库锁、原子保存、自愈坏库、压缩/解压 `content_blob`。
- Modify: `lib/step-tracker.js`
  - 使用统一路径解析，向 `StepDatabase.open()` 传递场景化锁超时。
- Modify: `lib/capture-recorder.js`
  - 删除 recorder 层锁，使用统一路径解析；不存在目标库时触发 legacy 迁移检查后再判断是否初始化。
- Modify: `lib/hooks-manager.js`
  - 初始化新目录 `.lumencode/`，显式 init/enable 时补 `.gitignore`，hooks 状态读取 Step Database Status。
- Modify: `lib/config.js`, `config.example.json`, `public/app.js`, `public/index.html`, `README.md`, `README.zh-CN.md`, `.gitignore`, `hooks/init-steps.js`, `index.js`
  - 更新默认路径、展示文案和忽略规则。
- Test: `test/step-db-paths.test.js`
- Test: `test/step-schema.test.js`
- Test: update `test/step-tracker.test.js`, `test/capture-recorder.test.js`, `test/hooks.test.js`, `test/server-hooks.test.js`
- Create: `test/fixtures/step-writer.mjs`
  - 真实子进程并发写入辅助脚本。

---

### Task 1: Step Database 路径解析与 legacy copy 迁移

**Files:**
- Create: `lib/step-db-paths.js`
- Test: `test/step-db-paths.test.js`

- [ ] **Step 1: 写路径解析失败测试**

新增 `test/step-db-paths.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_STEP_DB_RELATIVE_PATH,
  LEGACY_STEP_DB_RELATIVE_PATH,
  resolveStepDbPath,
  ensureStepDatabaseGitignore,
} from '../lib/step-db-paths.js';

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'lumencode-step-paths-'));
}

test('resolveStepDbPath uses product-owned default when config is missing', () => {
  const root = tempProject();
  const resolved = resolveStepDbPath(root);
  assert.equal(resolved.relativePath, DEFAULT_STEP_DB_RELATIVE_PATH);
  assert.equal(resolved.isDefaultPath, true);
  assert.equal(resolved.isLegacyDefaultConfig, false);
  assert.equal(resolved.dbPath, join(root, '.lumencode', 'steps.db'));
  assert.equal(resolved.legacyDbPath, join(root, '.ccusage', 'steps.db'));
});

test('resolveStepDbPath upgrades old default config to product-owned default', () => {
  const root = tempProject();
  const resolved = resolveStepDbPath(root, LEGACY_STEP_DB_RELATIVE_PATH);
  assert.equal(resolved.relativePath, DEFAULT_STEP_DB_RELATIVE_PATH);
  assert.equal(resolved.isDefaultPath, true);
  assert.equal(resolved.isLegacyDefaultConfig, true);
  assert.equal(resolved.dbPath, join(root, '.lumencode', 'steps.db'));
});

test('resolveStepDbPath respects custom relative path', () => {
  const root = tempProject();
  const resolved = resolveStepDbPath(root, 'custom/steps.db');
  assert.equal(resolved.relativePath, 'custom/steps.db');
  assert.equal(resolved.isDefaultPath, false);
  assert.equal(resolved.dbPath, join(root, 'custom', 'steps.db'));
  assert.equal(resolved.legacyDbPath, null);
});

test('ensureStepDatabaseGitignore adds .lumencode only during explicit init', () => {
  const root = tempProject();
  ensureStepDatabaseGitignore(root);
  const text = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(text, /^\.lumencode\/$/m);

  ensureStepDatabaseGitignore(root);
  const lines = readFileSync(join(root, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .filter(line => line === '.lumencode/');
  assert.equal(lines.length, 1);
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```powershell
node --test "test/step-db-paths.test.js"
```

Expected: FAIL，提示找不到 `../lib/step-db-paths.js`。

- [ ] **Step 3: 实现路径解析和 `.gitignore` 补写**

创建 `lib/step-db-paths.js`：

```js
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { writeStepDatabaseStatus } from './step-db-status.js';

export const DEFAULT_STEP_DB_RELATIVE_PATH = '.lumencode/steps.db';
export const LEGACY_STEP_DB_RELATIVE_PATH = '.ccusage/steps.db';
export const STEP_DB_IGNORE_ENTRY = '.lumencode/';

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function resolveStepDbPath(projectRoot = process.cwd(), configuredDbPath = null) {
  const root = resolve(projectRoot || process.cwd());
  const raw = configuredDbPath == null || configuredDbPath === ''
    ? DEFAULT_STEP_DB_RELATIVE_PATH
    : String(configuredDbPath);
  const normalized = isAbsolute(raw) ? raw : normalizeRelativePath(raw);
  const isLegacyDefaultConfig = !isAbsolute(raw) && normalized === LEGACY_STEP_DB_RELATIVE_PATH;
  const isDefaultPath = !isAbsolute(raw) && (normalized === DEFAULT_STEP_DB_RELATIVE_PATH || isLegacyDefaultConfig);

  if (isDefaultPath) {
    return {
      projectRoot: root,
      dbPath: join(root, DEFAULT_STEP_DB_RELATIVE_PATH),
      relativePath: DEFAULT_STEP_DB_RELATIVE_PATH,
      legacyDbPath: join(root, LEGACY_STEP_DB_RELATIVE_PATH),
      isDefaultPath: true,
      isLegacyDefaultConfig,
    };
  }

  return {
    projectRoot: root,
    dbPath: isAbsolute(raw) ? raw : join(root, normalized),
    relativePath: isAbsolute(raw) ? null : normalized,
    legacyDbPath: null,
    isDefaultPath: false,
    isLegacyDefaultConfig: false,
  };
}

export function migrateLegacyStepDatabase(projectRoot = process.cwd(), configuredDbPath = null) {
  const resolved = resolveStepDbPath(projectRoot, configuredDbPath);
  if (!resolved.isDefaultPath || !resolved.legacyDbPath) return { ...resolved, migrated: false };
  if (existsSync(resolved.dbPath)) return { ...resolved, migrated: false, legacyPresent: existsSync(resolved.legacyDbPath) };
  if (!existsSync(resolved.legacyDbPath)) return { ...resolved, migrated: false };

  mkdirSync(dirname(resolved.dbPath), { recursive: true });
  copyFileSync(resolved.legacyDbPath, resolved.dbPath);
  writeStepDatabaseStatus(resolved.projectRoot, {
    type: 'legacy_migrated',
    sourcePath: resolved.legacyDbPath,
    targetPath: resolved.dbPath,
    message: '已从旧版 .ccusage/steps.db 复制到 .lumencode/steps.db。',
  });
  return { ...resolved, migrated: true };
}

export function ensureStepDatabaseGitignore(projectRoot = process.cwd()) {
  const root = resolve(projectRoot || process.cwd());
  const ignorePath = join(root, '.gitignore');
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const lines = existing.split(/\r?\n/).map(line => line.trim());
  if (lines.includes(STEP_DB_IGNORE_ENTRY)) return false;
  const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  writeFileSync(ignorePath, `${prefix}${STEP_DB_IGNORE_ENTRY}\n`, 'utf8');
  return true;
}
```

- [ ] **Step 4: 创建 status 模块最小实现**

创建 `lib/step-db-status.js`：

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const STATUS_RELATIVE_PATH = '.lumencode/step-db-status.json';

export function getStepDatabaseStatusPath(projectRoot = process.cwd()) {
  return join(resolve(projectRoot || process.cwd()), STATUS_RELATIVE_PATH);
}

export function readStepDatabaseStatus(projectRoot = process.cwd()) {
  const statusPath = getStepDatabaseStatusPath(projectRoot);
  if (!existsSync(statusPath)) return null;
  try {
    return JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeStepDatabaseStatus(projectRoot = process.cwd(), event = {}) {
  const statusPath = getStepDatabaseStatusPath(projectRoot);
  mkdirSync(dirname(statusPath), { recursive: true });
  const status = {
    ...event,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n', 'utf8');
  return status;
}
```

- [ ] **Step 5: 运行测试**

Run:

```powershell
node --test "test/step-db-paths.test.js"
```

Expected: PASS。

---

### Task 2: 将 StepTracker 和 hooks 初始化切到统一新路径

**Files:**
- Modify: `lib/step-tracker.js`
- Modify: `lib/hooks-manager.js`
- Modify: `lib/config.js`
- Modify: `config.example.json`
- Modify: `hooks/init-steps.js`
- Modify: `index.js`
- Test: update `test/step-tracker.test.js`, `test/hooks.test.js`, `test/server-hooks.test.js`

- [ ] **Step 1: 写迁移行为测试**

在 `test/step-tracker.test.js` 添加：

```js
test('StepTracker migrates legacy default database by copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-migrate-'));
  const legacyPath = join(root, '.ccusage', 'steps.db');
  mkdirSync(dirname(legacyPath), { recursive: true });

  const legacy = new StepDatabase();
  await legacy.open(legacyPath, { lockTimeoutMs: 2000 });
  legacy.insertStep({
    id: 'legacy-step',
    sessionId: 'legacy-session',
    origin: 'claude_code',
    ts: 1,
    toolName: 'Write',
    toolUseId: 'tool-1',
  });
  legacy.save();
  legacy.close();

  const tracker = new StepTracker(root);
  await tracker.open();
  assert.equal(tracker.dbPath, join(root, '.lumencode', 'steps.db'));
  assert.equal(tracker.db.getStepCount(), 1);
  tracker.close();
  assert.equal(existsSync(legacyPath), true);
});

test('StepTracker keeps custom dbPath unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-custom-'));
  const tracker = new StepTracker(root, { dbPath: 'custom/steps.db' });
  assert.equal(tracker.dbPath, join(root, 'custom', 'steps.db'));
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```powershell
node --test "test/step-tracker.test.js"
```

Expected: FAIL，`tracker.dbPath` 仍指向 `.ccusage/steps.db`。

- [ ] **Step 3: 更新 `StepTracker` 路径解析**

在 `lib/step-tracker.js`：

```js
import { migrateLegacyStepDatabase, resolveStepDbPath } from './step-db-paths.js';
```

替换 constructor 中 `this.dbPath` 赋值：

```js
const resolvedDbPath = resolveStepDbPath(this.projectRoot, options.dbPath);
this.dbPath = resolvedDbPath.dbPath;
this.configuredDbPath = options.dbPath || null;
```

修改 `open()`：

```js
async open(options = {}) {
  const resolved = migrateLegacyStepDatabase(this.projectRoot, this.configuredDbPath);
  this.dbPath = resolved.dbPath;
  this.db = new StepDatabase();
  await this.db.open(this.dbPath, {
    projectRoot: this.projectRoot,
    lockTimeoutMs: options.lockTimeoutMs ?? 2_000,
    readonly: options.readonly === true,
  });
  return this;
}
```

- [ ] **Step 4: 更新默认配置**

在 `lib/config.js` 和 `config.example.json` 将：

```js
dbPath: '.ccusage/steps.db',
```

改为：

```js
dbPath: '.lumencode/steps.db',
```

- [ ] **Step 5: 更新 hooks 初始化**

在 `lib/hooks-manager.js` 引入：

```js
import { DEFAULT_STEP_DB_RELATIVE_PATH, ensureStepDatabaseGitignore, resolveStepDbPath } from './step-db-paths.js';
import { readStepDatabaseStatus } from './step-db-status.js';
```

修改 `projectPaths()` 的 `stepsDbPath`：

```js
const stepDb = resolveStepDbPath(root);
stepsDbPath: stepDb.dbPath,
```

修改 `initStepTracking()`：

```js
export async function initStepTracking(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
  ensureStepDatabaseGitignore(paths.root);
  const tracker = new StepTracker(paths.root);
  await tracker.open({ lockTimeoutMs: 10_000 });
  const stats = tracker.getStats();
  tracker.close();
  return { dbPath: paths.stepsDbPath, ...stats };
}
```

- [ ] **Step 6: 更新 CLI 文案**

将 `hooks/init-steps.js`、`index.js` 中硬编码 `.ccusage/steps.db` 的输出改成 `.lumencode/steps.db`。

- [ ] **Step 7: 更新现有测试期望**

把测试里用于新初始化结果的 `.ccusage/steps.db` 期望改为 `.lumencode/steps.db`。保留专门的 legacy 迁移测试继续使用 `.ccusage/steps.db`。

- [ ] **Step 8: 运行路径相关测试**

Run:

```powershell
node --test "test/step-db-paths.test.js" "test/step-tracker.test.js" "test/hooks.test.js" "test/server-hooks.test.js"
```

Expected: PASS。

---

### Task 3: StepDatabase 生命周期锁

**Files:**
- Modify: `lib/step-schema.js`
- Modify: `lib/capture-recorder.js`
- Test: `test/step-schema.test.js`

- [ ] **Step 1: 写锁超时测试**

创建 `test/step-schema.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StepDatabase } from '../lib/step-schema.js';

test('StepDatabase.open throws lock_timeout when lock cannot be acquired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-lock-'));
  const dbPath = join(root, 'steps.db');
  const lockPath = `${dbPath}.lock`;
  const fd = openSync(lockPath, 'wx');
  try {
    const db = new StepDatabase();
    await assert.rejects(
      () => db.open(dbPath, { lockTimeoutMs: 20 }),
      /lock_timeout/
    );
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
});

test('StepDatabase releases lock on close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-lock-release-'));
  const dbPath = join(root, 'steps.db');
  const db = new StepDatabase();
  await db.open(dbPath, { lockTimeoutMs: 2000 });
  assert.equal(existsSync(`${dbPath}.lock`), true);
  db.close();
  assert.equal(existsSync(`${dbPath}.lock`), false);
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```powershell
node --test "test/step-schema.test.js"
```

Expected: FAIL，当前 `StepDatabase.open()` 不接收锁参数。

- [ ] **Step 3: 在 `StepDatabase` 实现锁**

在 `lib/step-schema.js` 增加 imports：

```js
import { closeSync, openSync, statSync, unlinkSync } from 'fs';
```

增加 helpers：

```js
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireDbLock(dbPath, timeoutMs) {
  const lockPath = `${dbPath}.lock`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      return {
        lockPath,
        fd: openSync(lockPath, 'wx'),
      };
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
      } catch {}
      await sleep(25);
    }
  }

  const err = new Error(`lock_timeout: ${dbPath}`);
  err.code = 'lock_timeout';
  throw err;
}

function releaseDbLock(lock) {
  if (!lock) return;
  try { closeSync(lock.fd); } catch {}
  try { unlinkSync(lock.lockPath); } catch {}
}
```

修改 `constructor()`：

```js
this.lock = null;
```

修改 `open()` 开头：

```js
async open(dbPath, options = {}) {
  this.dbPath = dbPath;
  this.projectRoot = options.projectRoot || dirname(dirname(dbPath));
  const lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
  this.lock = await acquireDbLock(dbPath, lockTimeoutMs);
  ...
}
```

修改 `close()` finally 释放锁：

```js
close() {
  try {
    if (!this.db) return;
    try {
      this.save();
    } catch { /* best effort */ }
    this.db.close();
    this.db = null;
  } finally {
    releaseDbLock(this.lock);
    this.lock = null;
  }
}
```

- [ ] **Step 4: 删除 recorder 层锁**

在 `lib/capture-recorder.js` 删除 `withDbLock()` 相关 helper 和 imports，直接：

```js
const tracker = new StepTracker(cwd, { dbPath });
try {
  await tracker.open({ lockTimeoutMs: 2_000 });
  ...
} catch (err) {
  if (err?.code === 'lock_timeout') {
    return { recorded: false, reason: 'lock_timeout', sessionId, origin };
  }
  throw err;
} finally {
  tracker.close();
}
```

对 `recordToolUse()` 与 `recordToolBatch()` 都应用同一模式。

- [ ] **Step 5: 运行锁测试**

Run:

```powershell
node --test "test/step-schema.test.js" "test/capture-recorder.test.js"
```

Expected: PASS。

---

### Task 4: 原子写与 `.bak` 恢复

**Files:**
- Modify: `lib/step-schema.js`
- Test: `test/step-schema.test.js`

- [ ] **Step 1: 写 bak 恢复测试**

追加到 `test/step-schema.test.js`：

```js
import { renameSync, writeFileSync } from 'fs';

test('StepDatabase recovers latest bak when target is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-bak-'));
  const dbPath = join(root, 'steps.db');

  const db = new StepDatabase();
  await db.open(dbPath, { lockTimeoutMs: 2000 });
  db.insertStep({
    id: 'before-bak',
    sessionId: 'session',
    origin: 'claude_code',
    ts: 1,
    toolName: 'Write',
    toolUseId: 'tool',
  });
  db.save();
  db.close();

  renameSync(dbPath, `${dbPath}.bak.test`);
  const reopened = new StepDatabase();
  await reopened.open(dbPath, { lockTimeoutMs: 2000 });
  assert.equal(reopened.getStepCount(), 1);
  reopened.close();
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```powershell
node --test "test/step-schema.test.js"
```

Expected: FAIL，当前没有 `.bak` 恢复逻辑。

- [ ] **Step 3: 实现原子替换**

在 `lib/step-schema.js` 添加 imports：

```js
import { readdirSync, renameSync } from 'fs';
import { basename } from 'path';
```

增加 helpers：

```js
function atomicReplaceFile(targetPath, data) {
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const tmpPath = `${targetPath}.tmp.${nonce}`;
  const bakPath = `${targetPath}.bak.${nonce}`;
  writeFileSync(tmpPath, data);

  let hasBackup = false;
  try {
    if (existsSync(targetPath)) {
      renameSync(targetPath, bakPath);
      hasBackup = true;
    }
    renameSync(tmpPath, targetPath);
    if (hasBackup) {
      try { unlinkSync(bakPath); } catch {}
    }
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    if (hasBackup && !existsSync(targetPath) && existsSync(bakPath)) {
      try { renameSync(bakPath, targetPath); } catch {}
    }
    throw err;
  }
}

function recoverMissingTargetFromBackup(dbPath) {
  if (existsSync(dbPath)) return false;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) return false;
  const prefix = `${basename(dbPath)}.bak.`;
  const candidates = readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .map(name => join(dir, name))
    .sort();
  const latest = candidates[candidates.length - 1];
  if (!latest) return false;
  renameSync(latest, dbPath);
  return true;
}
```

在 `open()` 读取前调用：

```js
recoverMissingTargetFromBackup(dbPath);
```

在 `save()` 使用：

```js
const data = this.db.export();
atomicReplaceFile(this.dbPath, Buffer.from(data));
```

并让 `close()` 不再额外手写 export，统一调用 `save()`。

- [ ] **Step 4: 运行测试**

Run:

```powershell
node --test "test/step-schema.test.js" "test/step-tracker.test.js"
```

Expected: PASS。

---

### Task 5: 损坏自愈与 Step Database Status

**Files:**
- Modify: `lib/step-schema.js`
- Modify: `lib/hooks-manager.js`
- Test: `test/step-schema.test.js`
- Test: update `test/hooks.test.js`

- [ ] **Step 1: 写损坏自愈测试**

追加到 `test/step-schema.test.js`：

```js
import { readStepDatabaseStatus } from '../lib/step-db-status.js';

test('StepDatabase backs up corrupt database and recreates empty database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-corrupt-'));
  const dbPath = join(root, '.lumencode', 'steps.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, 'not a sqlite database');

  const db = new StepDatabase();
  await db.open(dbPath, { projectRoot: root, lockTimeoutMs: 2000 });
  assert.equal(db.getStepCount(), 0);
  db.close();

  const status = readStepDatabaseStatus(root);
  assert.equal(status.type, 'corrupt_recovered');
  assert.match(status.corruptBackupPath, /steps\.db\.corrupt\./);
  assert.equal(existsSync(status.corruptBackupPath), true);
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```powershell
node --test "test/step-schema.test.js"
```

Expected: FAIL，当前损坏库会抛错。

- [ ] **Step 3: 实现损坏自愈**

在 `lib/step-schema.js` 引入：

```js
import { writeStepDatabaseStatus } from './step-db-status.js';
```

增加 helper：

```js
function backupCorruptDatabase(dbPath) {
  const backupPath = `${dbPath}.corrupt.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(dbPath, backupPath);
  return backupPath;
}
```

修改 `open()` 读取旧库：

```js
if (existsSync(dbPath)) {
  const buf = readFileSync(dbPath);
  try {
    this.db = new Sql.Database(buf);
  } catch (err) {
    const corruptBackupPath = backupCorruptDatabase(dbPath);
    writeStepDatabaseStatus(this.projectRoot, {
      type: 'corrupt_recovered',
      sourcePath: dbPath,
      corruptBackupPath,
      message: '检测到 Step Database 损坏，已备份并重建空库。',
    });
    this.db = new Sql.Database();
  }
} else {
  this.db = new Sql.Database();
}
```

- [ ] **Step 4: hooks 状态暴露 status**

在 `lib/hooks-manager.js` 的 `getHooksStatus()` 返回对象中增加：

```js
stepDatabaseStatus: readStepDatabaseStatus(root),
```

在 Web/CLI 可先显示原始 message，UI 精细化可后续任务处理。

- [ ] **Step 5: 运行测试**

Run:

```powershell
node --test "test/step-schema.test.js" "test/hooks.test.js"
```

Expected: PASS。

---

### Task 6: gzip 快照写入与旧明文兼容

**Files:**
- Modify: `lib/step-schema.js`
- Test: `test/step-schema.test.js`

- [ ] **Step 1: 写 gzip 兼容测试**

追加到 `test/step-schema.test.js`：

```js
test('StepDatabase stores new content_blob as gzip base64 and reads it back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-gzip-'));
  const dbPath = join(root, 'steps.db');
  const content = 'line one\nline two\n';

  const db = new StepDatabase();
  await db.open(dbPath, { lockTimeoutMs: 2000 });
  db.upsertStepFile('step1', 'src/app.js', { lines: ['step1', 'step1'] }, content);
  assert.equal(db.getFileBlob('step1', 'src/app.js'), content);

  const stmt = db.db.prepare('SELECT content_blob FROM step_files WHERE step_id = ? AND path = ?');
  stmt.bind(['step1', 'src/app.js']);
  assert.equal(stmt.step(), true);
  const row = stmt.getAsObject();
  stmt.free();
  assert.match(row.content_blob, /^gzip:base64:/);
  db.close();
});

test('StepDatabase reads legacy plain text content_blob', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-plain-'));
  const dbPath = join(root, 'steps.db');
  const db = new StepDatabase();
  await db.open(dbPath, { lockTimeoutMs: 2000 });
  db.db.run(
    'INSERT OR REPLACE INTO step_files (step_id, path, blame_map, content_blob) VALUES (?, ?, ?, ?)',
    ['step-plain', 'plain.js', '{"lines":["step-plain"]}', 'plain text\n']
  );
  assert.equal(db.getFileBlob('step-plain', 'plain.js'), 'plain text\n');
  db.close();
});
```

- [ ] **Step 2: 运行失败测试**

Run:

```powershell
node --test "test/step-schema.test.js"
```

Expected: FAIL，新写入仍是明文。

- [ ] **Step 3: 实现 gzip helpers**

在 `lib/step-schema.js` 引入：

```js
import { gzipSync, gunzipSync } from 'zlib';
```

增加：

```js
const GZIP_TEXT_PREFIX = 'gzip:base64:';

function encodeContentBlob(content) {
  if (content == null) return null;
  return `${GZIP_TEXT_PREFIX}${gzipSync(Buffer.from(String(content), 'utf8')).toString('base64')}`;
}

function decodeContentBlob(blob) {
  if (!blob) return null;
  const text = String(blob);
  if (!text.startsWith(GZIP_TEXT_PREFIX)) return text;
  try {
    const payload = text.slice(GZIP_TEXT_PREFIX.length);
    return gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
  } catch {
    return null;
  }
}
```

修改 `upsertStepFile()`：

```js
const storedContent = encodeContentBlob(content);
...
[stepId, path, JSON.stringify(blameMap), storedContent]
```

修改 `getFileBlob()`：

```js
result = decodeContentBlob(row.content_blob || null);
```

- [ ] **Step 4: 运行测试**

Run:

```powershell
node --test "test/step-schema.test.js" "test/step-tracker.test.js"
```

Expected: PASS。

---

### Task 7: 真实子进程并发写入回归

**Files:**
- Create: `test/fixtures/step-writer.mjs`
- Test: `test/step-schema.test.js`

- [ ] **Step 1: 创建子进程写入脚本**

创建 `test/fixtures/step-writer.mjs`：

```js
import { writeFileSync } from 'fs';
import { join } from 'path';
import { StepTracker } from '../../lib/step-tracker.js';

const [projectRoot, workerId, countRaw] = process.argv.slice(2);
const count = Number(countRaw || 0);

for (let i = 0; i < count; i++) {
  const filePath = join(projectRoot, `file-${workerId}.js`);
  writeFileSync(filePath, `export const value${i} = ${i};\n`, 'utf8');
  const tracker = new StepTracker(projectRoot);
  await tracker.open({ lockTimeoutMs: 10_000 });
  try {
    await tracker.recordStep({
      sessionId: `session-${workerId}`,
      toolName: 'Write',
      toolInput: { file_path: filePath },
      toolUseId: `${workerId}-${i}`,
      timestamp: Date.now() + i,
    });
  } finally {
    tracker.close();
  }
}
```

- [ ] **Step 2: 写并发测试**

追加到 `test/step-schema.test.js`：

```js
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `exit ${code}`));
    });
  });
}

test('StepDatabase preserves writes from concurrent hook-like processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-concurrent-'));
  const script = fileURLToPath(new URL('./fixtures/step-writer.mjs', import.meta.url));
  await Promise.all([
    runNodeScript(script, [root, 'a', '40']),
    runNodeScript(script, [root, 'b', '40']),
  ]);

  const db = new StepDatabase();
  await db.open(join(root, '.lumencode', 'steps.db'), { lockTimeoutMs: 2000 });
  assert.equal(db.getStepCount(), 80);
  db.close();
});
```

- [ ] **Step 3: 运行并发测试**

Run:

```powershell
node --test "test/step-schema.test.js"
```

Expected: PASS，最终 step 数为 80。

---

### Task 8: hook recorder 迁移路径和 lock_timeout 行为

**Files:**
- Modify: `lib/capture-recorder.js`
- Test: update `test/capture-recorder.test.js`

- [ ] **Step 1: 写 recorder 迁移测试**

在 `test/capture-recorder.test.js` 添加：

```js
test('recordToolUse migrates legacy default database before not_initialized check', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lumencode-capture-legacy-'));
  const legacyTracker = new StepTracker(tempDir, { dbPath: '.ccusage/steps.db' });
  await legacyTracker.open({ lockTimeoutMs: 2000 });
  legacyTracker.close();

  const filePath = join(tempDir, 'capture.js');
  writeFileSync(filePath, 'export const captured = true;\n', 'utf8');

  const result = await recordToolUse({
    cwd: tempDir,
    sessionId: 's',
    toolUseId: 't',
    toolName: 'Write',
    toolInput: { file_path: filePath },
  });

  assert.equal(result.recorded, true);
  assert.equal(existsSync(join(tempDir, '.lumencode', 'steps.db')), true);
  assert.equal(existsSync(join(tempDir, '.ccusage', 'steps.db')), true);
});
```

- [ ] **Step 2: 写 lock_timeout 测试**

在同文件添加：

```js
test('recordToolUse returns lock_timeout when StepDatabase lock is busy', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lumencode-capture-lock-'));
  const tracker = new StepTracker(tempDir);
  await tracker.open({ lockTimeoutMs: 2000 });
  tracker.close();

  const lockPath = join(tempDir, '.lumencode', 'steps.db.lock');
  const fd = openSync(lockPath, 'wx');
  try {
    const filePath = join(tempDir, 'locked.js');
    writeFileSync(filePath, 'export const locked = true;\n', 'utf8');
    const result = await recordToolUse({
      cwd: tempDir,
      sessionId: 's',
      toolUseId: 't',
      toolName: 'Write',
      toolInput: { file_path: filePath },
    });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, 'lock_timeout');
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
});
```

- [ ] **Step 3: 实现 recorder 路径解析**

在 `lib/capture-recorder.js` 引入：

```js
import { migrateLegacyStepDatabase, resolveStepDbPath } from './step-db-paths.js';
```

将 dbPath 计算替换为：

```js
const resolvedDb = payload.dbPath
  ? resolveStepDbPath(cwd, payload.dbPath)
  : migrateLegacyStepDatabase(cwd);
const dbPath = resolvedDb.dbPath;
```

普通 hook 路径不调用 `ensureStepDatabaseGitignore()`。

- [ ] **Step 4: 运行 recorder 测试**

Run:

```powershell
node --test "test/capture-recorder.test.js"
```

Expected: PASS。

---

### Task 9: Web/CLI/文档口径更新

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `index.js`
- Modify: `hooks/post-tool-use.js`
- Modify: `TASKS.md` only if marking progress is explicitly desired during execution

- [ ] **Step 1: 更新忽略规则**

在 `.gitignore` 添加：

```gitignore
.lumencode/
```

保留：

```gitignore
.ccusage/
```

- [ ] **Step 2: 更新配置 UI 默认值**

在 `public/app.js` 的 `collectStepTracking()` 默认值改为：

```js
dbPath: document.getElementById('cfgStepDbPath')?.value.trim() || '.lumencode/steps.db',
```

在 `public/index.html` placeholder 改为：

```html
<input type="text" id="cfgStepDbPath" class="form-input" placeholder=".lumencode/steps.db">
```

- [ ] **Step 3: 更新 README**

将中英 README 中项目数据库路径表述改为：

```md
数据写入当前项目的 `.lumencode/steps.db`（含归因用的文件快照）。旧版本的 `.ccusage/steps.db` 会在首次使用时复制迁移到新路径；旧文件保留为回滚备份。
```

英文 README 使用等价英文：

```md
Data is written to `.lumencode/steps.db` in the current project. Existing `.ccusage/steps.db` files from older versions are copied to the new path on first use and kept as rollback-safe legacy backups.
```

- [ ] **Step 4: 更新 hook 注释和 CLI 文案**

把注释中：

```js
Silently no-ops if .ccusage/steps.db doesn't exist.
```

改为：

```js
Silently no-ops if the Step Database is not initialized.
```

CLI 输出使用 `.lumencode/steps.db`。

- [ ] **Step 5: 运行文案相关测试**

Run:

```powershell
node --test "test/config.test.js" "test/config-defaults.test.js" "test/smart-report-ui.test.js"
```

Expected: PASS。

---

### Task 10: 全量验证

**Files:**
- No new code files unless earlier tasks expose a focused fix.

- [ ] **Step 1: 运行全部测试**

Run:

```powershell
npm test
```

Expected:

```text
# fail 0
```

- [ ] **Step 2: 检查旧路径引用**

Run:

```powershell
rg -n "\.ccusage/steps\.db|\.ccusage\\\\steps\.db|\.lumencode/steps\.db" "D:/lumencode"
```

Expected:
- `.lumencode/steps.db` 出现在默认配置、文档、UI、测试新期望。
- `.ccusage/steps.db` 只出现在 legacy 迁移逻辑、legacy 测试、兼容说明中。

- [ ] **Step 3: 检查未跟踪文档策略**

Run:

```powershell
git check-ignore -v "D:/lumencode/doc/adr/0001-step-database-product-path-and-legacy-migration.md" "D:/lumencode/doc/plans/2026-07-09-step-database-stage-a.md"
```

Expected: no output，表示 ADR 和计划不会被忽略。

---

## 自检

**Spec coverage:**
- 路径改名：Task 1、2、9。
- 老用户兼容：Task 1、2、8。
- `.gitignore` 显式操作边界：Task 1、2、9。
- 锁下沉：Task 3、8。
- 原子写：Task 4。
- 损坏自愈和可见状态：Task 5。
- gzip 新写入和旧明文兼容：Task 6。
- 并发真实进程验证：Task 7。
- 全量验证：Task 10。

**User constraint:**
- 本计划不包含 `git commit` 步骤。提交和分支操作只有在用户明确要求时执行。
