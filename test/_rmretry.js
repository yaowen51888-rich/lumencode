// Test-only setup，经 npm test 的 --import 注入。
// 给 fs.rmSync 加默认 maxRetries/retryDelay，规避 better-sqlite3 在 Windows 上 close 后
// 文件句柄异步释放导致的 rmSync ENOTEMPTY/EPERM 偶发失败（不影响生产，生产不经此文件加载）。
import fs from 'node:fs';

const _rmSync = fs.rmSync;
fs.rmSync = function rmSyncRetry(path, options = {}) {
  return _rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: options.maxRetries ?? 5,
    retryDelay: options.retryDelay ?? 50,
    ...options,
  });
};
