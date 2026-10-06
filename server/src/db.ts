import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, "hub.sqlite");
const schemaFile = [
  path.join(__dirname, "schema.sql"),
  path.join(__dirname, "..", "schema.sql"),
].find((p) => fs.existsSync(p));
if (!schemaFile) throw new Error("找不到 schema.sql");

type RunInfo = { lastInsertRowid: number; changes: number };

class Statement {
  constructor(
    private raw: SqlJsDatabase,
    private sql: string,
    private persist: () => void
  ) {}

  get(...params: unknown[]) {
    const stmt = this.raw.prepare(this.sql);
    try {
      stmt.bind(params as (string | number | null | Uint8Array)[]);
      if (stmt.step()) return stmt.getAsObject() as Record<string, unknown>;
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all(...params: unknown[]) {
    const stmt = this.raw.prepare(this.sql);
    const rows: Record<string, unknown>[] = [];
    try {
      stmt.bind(params as (string | number | null | Uint8Array)[]);
      while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
      return rows;
    } finally {
      stmt.free();
    }
  }

  run(...params: unknown[]): RunInfo {
    this.raw.run(this.sql, params as (string | number | null | Uint8Array)[]);
    const idRow = this.raw.exec("SELECT last_insert_rowid() AS id, changes() AS changes");
    const lastInsertRowid = Number(idRow[0]?.values?.[0]?.[0] ?? 0);
    const changes = Number(idRow[0]?.values?.[0]?.[1] ?? 0);
    this.persist();
    return { lastInsertRowid, changes };
  }
}

class AppDb {
  constructor(private raw: SqlJsDatabase, private persist: () => void) {}
  exec(sql: string) {
    this.raw.exec(sql);
    this.persist();
  }
  prepare(sql: string) {
    return new Statement(this.raw, sql, this.persist);
  }
}

function migrate(database: AppDb) {
  const cols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "is_admin")) {
    database.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "avatar")) {
    database.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL,
      game_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, game_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS maze_users (
      username TEXT PRIMARY KEY,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      hub_user_id INTEGER UNIQUE,
      FOREIGN KEY (hub_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS maze_tokens (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (username) REFERENCES maze_users(username) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS maze_progress (
      username TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (username) REFERENCES maze_users(username) ON DELETE CASCADE
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const now = new Date().toISOString();
  const admin = database.prepare("SELECT id FROM users WHERE username = ?").get("admin") as
    | { id: number }
    | undefined;
  if (!admin) {
    const adminPassword =
      process.env.ADMIN_PASSWORD ?? crypto.randomBytes(9).toString("base64url");
    console.log(
      `[hub] 已创建管理员 admin，初始密码 ${adminPassword}（仅显示一次，登录后请尽快修改；也可用环境变量 ADMIN_PASSWORD 指定）`
    );
    database
      .prepare(
        `INSERT INTO users (username, password_hash, display_name, avatar, created_at, last_login_at, is_admin)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .run("admin", bcrypt.hashSync(adminPassword, 10), "站点管理员", "管", now, now);
  } else {
    database.prepare("UPDATE users SET is_admin = 1 WHERE username = ?").run("admin");
  }
}

function persist(raw: SqlJsDatabase) {
  const data = raw.export();
  fs.writeFileSync(dbFile, Buffer.from(data));
}

let dbRef: AppDb | null = null;
const ready = (async () => {
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = await initSqlJs({
    locateFile: () => wasmPath
  });
  const raw = fs.existsSync(dbFile) ? new SQL.Database(fs.readFileSync(dbFile)) : new SQL.Database();
  const save = () => persist(raw);
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(fs.readFileSync(schemaFile, "utf8"));
  dbRef = new AppDb(raw, save);
  migrate(dbRef);
  save();
})();

export const db = new Proxy({} as AppDb, {
  get(_target, prop, receiver) {
    if (!dbRef) throw new Error("数据库尚未初始化");
    return Reflect.get(dbRef, prop, receiver);
  }
});

export async function waitForDb() {
  await ready;
}
