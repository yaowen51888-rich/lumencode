// 自动更新：npm registry 版本检查 + 全局安装更新与进程重启
import { spawn, exec } from 'child_process';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { createRequire } from 'module';

const { version: APP_VERSION } = createRequire(import.meta.url)('../package.json');

const REGISTRY_URL = 'https://registry.npmjs.org/lumencode/latest';
const FETCH_TIMEOUT = 5000;

// 结果缓存整个进程生命周期（启动检查一次，手动检查走 force）
let cachedCheck = null;
let globalRootCache; // undefined=未查询, null=查询失败, string=全局 node_modules 路径
let updating = false;
let updateLog = [];
let serveArgs = [];

// 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0；容忍 v 前缀与缺段
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.');
  const pb = String(b).replace(/^v/, '').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number(pa[i] || 0);
    const nb = Number(pb[i] || 0);
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// npm root -g 结果缓存；查询失败返回 null
function getGlobalRoot() {
  if (globalRootCache !== undefined) return Promise.resolve(globalRootCache);
  return new Promise(resolve => {
    exec('npm root -g', { timeout: 10000 }, (err, stdout) => {
      globalRootCache = err || !stdout.trim() ? null : stdout.trim();
      resolve(globalRootCache);
    });
  });
}

// 判断当前运行实例是否位于全局 node_modules（npx/本地运行返回 false，不提供自动更新）
// realpath 解析符号链接：npm link 安装时全局目录是指向源码目录的软链，直接前缀比对会误判
export async function isGloballyInstalled() {
  const root = await getGlobalRoot();
  if (!root) return false;
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const norm = p => { try { return realpathSync(p).replace(/\\/g, '/').toLowerCase(); } catch { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); } };
  return norm(pkgDir).startsWith(norm(path.join(root, 'lumencode')));
}

// 检查新版本。网络失败静默降级（latest=null），不阻塞调用方
export async function checkForUpdate(force = false) {
  if (!force && cachedCheck) return cachedCheck;
  const result = { current: APP_VERSION, latest: null, updateAvailable: false, globallyInstalled: false };
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (res.ok) {
      result.latest = (await res.json()).version || null;
      result.updateAvailable = result.latest ? compareVersions(result.latest, APP_VERSION) > 0 : false;
    }
  } catch { /* 网络失败静默，不弹窗 */ }
  try { result.globallyInstalled = await isGloballyInstalled(); } catch { /* 判定失败按非全局处理 */ }
  if (result.latest) cachedCheck = result;
  return result;
}

export function setServeArgs(args) { serveArgs = args || []; }

export function getUpdateState() {
  return { updating, message: updateLog.slice(-5).join('\n') };
}

// 执行更新并重启。fire-and-forget：触发后立即返回，进度经 getUpdateState 轮询
export function performUpdate() {
  if (updating) return { started: false, updating: true };
  updating = true;
  updateLog = [];
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCmd, ['install', '-g', 'lumencode@latest'], { shell: true });
  child.stdout.on('data', d => updateLog.push(String(d).trim()));
  child.stderr.on('data', d => updateLog.push(String(d).trim()));
  child.on('error', err => {
    updateLog.push('npm 启动失败: ' + err.message);
    updating = false;
  });
  child.on('close', code => {
    if (code !== 0) {
      updateLog.push(`npm install 失败，退出码 ${code}`);
      updating = false;
      return;
    }
    updateLog.push('更新完成，正在重启服务…');
    // detached 拉起新进程后退出旧进程；npm 更新后全局 bin 路径不变
    spawn('lumencode', ['serve', ...serveArgs], { detached: true, stdio: 'ignore', shell: true }).unref();
    process.exit(0);
  });
  return { started: true };
}
