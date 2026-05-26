import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/kanban.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    color     TEXT NOT NULL DEFAULT '#6b7280',
    position  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    notes       TEXT NOT NULL DEFAULT '',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    priority    TEXT NOT NULL DEFAULT 'medium',
    owner       TEXT NOT NULL DEFAULT 'unassigned',
    status      TEXT NOT NULL DEFAULT 'backlog',
    due_date    TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration: add `archived` to tasks tables created before this column existed.
const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!taskCols.includes("archived")) {
  db.exec("ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
}

// Per-task chat between the two people, plus per-person read tracking.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sender     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);

  CREATE TABLE IF NOT EXISTS reads (
    task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    person       TEXT NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, person)
  );
`);

// Seed defaults on first run. Everything below is overridable via env vars so
// no personal data needs to live in the repo — rename people in Settings and
// edit categories in the Categories dialog at runtime.
const PALETTE = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ef4444", "#14b8a6", "#ec4899", "#6b7280"];

const catCount = db.prepare("SELECT COUNT(*) AS n FROM categories").get().n;
if (catCount === 0) {
  const defaultCategories = (process.env.DEFAULT_CATEGORIES ?? "Home,Health,Work,Errands")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seed = db.prepare("INSERT INTO categories (name, color, position) VALUES (?, ?, ?)");
  defaultCategories.forEach((name, i) => seed.run(name, PALETTE[i % PALETTE.length], i));
}

// Insert-or-ignore so existing installs pick up newly added defaults on
// upgrade without overwriting values the user has already set.
const defaultSettings = {
  person1: process.env.DEFAULT_PERSON1 || "Person 1",
  person2: process.env.DEFAULT_PERSON2 || "Person 2",
  color_unassigned: "#475569",
  color_joint: "#1e3a8a",
  color_p1: "#0e7490",
  color_p2: "#9d174d",
};
const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [k, v] of Object.entries(defaultSettings)) insertSetting.run(k, v);

export default db;
