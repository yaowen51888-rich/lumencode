import { statSync, readFileSync } from 'fs';

const MAX_DB_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * 打开 SQLite 数据库（sql.js），含大小上限保护。
 * 失败返回 null，不抛错。
 * @returns {Promise<{db, close} | null>}
 */
export async function openDb(dbPath) {
  try {
    const { size } = statSync(dbPath);
    if (size > MAX_DB_SIZE) {
      console.warn(`[_sqlite] 文件过大 (${(size / 1024 / 1024).toFixed(0)}MB)，跳过: ${dbPath}`);
      return null;
    }
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const dbBuf = readFileSync(dbPath);
    const db = new SQL.Database(dbBuf);
    return { db, close: () => db.close() };
  } catch (e) {
    console.warn(`[_sqlite] 打开失败: ${dbPath}`, e.message);
    return null;
  }
}

export { MAX_DB_SIZE };

/**
 * 在已打开的 sql.js db 中按候选顺序找首个存在的表名，找不到返回 null。
 * 用于容忍表名版本差异（如 sessions vs session）。
 */
export function pickTable(db, candidates) {
  for (const t of candidates) {
    try {
      const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`);
      if (r[0] && r[0].values.length) return t;
    } catch { /* 继续下一个候选 */ }
  }
  return null;
}

/**
 * 返回表的全部列名数组。失败返回空数组。
 */
export function columns(db, table) {
  try {
    const r = db.exec(`PRAGMA table_info("${table}")`);
    if (!r[0]) return [];
    return r[0].values.map(row => row[1]);
  } catch { return []; }
}
