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
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

const settingCount = db.prepare("SELECT COUNT(*) AS n FROM settings").get().n;
if (settingCount === 0) {
  const s = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  s.run("person1", process.env.DEFAULT_PERSON1 || "Person 1");
  s.run("person2", process.env.DEFAULT_PERSON2 || "Person 2");
}

export default db;
