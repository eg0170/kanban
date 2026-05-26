import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import db from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const STATUSES = ["backlog", "todo", "in_progress", "done"];
const PRIORITIES = ["low", "medium", "high"];
const OWNERS = ["unassigned", "joint", "p1", "p2"];

// Owner/status coupling: an unassigned task belongs in the backlog grab pile;
// the moment it has an owner it shouldn't sit in backlog, so it moves to To Do.
// Tasks already past To Do (in progress / done) keep their status when owned.
function coupleStatus(owner, status) {
  if (owner === "unassigned") return "backlog";
  if (status === "backlog") return "todo";
  return status;
}

// ---- Settings (person names) ----
function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

app.get("/api/settings", (_req, res) => res.json(getSettings()));

app.put("/api/settings", (req, res) => {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  for (const key of ["person1", "person2"]) {
    if (typeof req.body[key] === "string" && req.body[key].trim()) {
      stmt.run(key, req.body[key].trim());
    }
  }
  for (const key of ["color_unassigned", "color_joint", "color_p1", "color_p2"]) {
    const v = req.body[key];
    if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) stmt.run(key, v);
  }
  res.json(getSettings());
});

// ---- Categories ----
app.get("/api/categories", (_req, res) => {
  res.json(db.prepare("SELECT * FROM categories ORDER BY position, id").all());
});

app.post("/api/categories", (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
  const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories").get().p;
  const info = db
    .prepare("INSERT INTO categories (name, color, position) VALUES (?, ?, ?)")
    .run(name.trim(), color || "#6b7280", pos);
  res.json(db.prepare("SELECT * FROM categories WHERE id = ?").get(info.lastInsertRowid));
});

app.put("/api/categories/:id", (req, res) => {
  const { name, color } = req.body;
  const existing = db.prepare("SELECT * FROM categories WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  db.prepare("UPDATE categories SET name = ?, color = ? WHERE id = ?").run(
    name?.trim() || existing.name,
    color || existing.color,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM categories WHERE id = ?").get(req.params.id));
});

app.delete("/api/categories/:id", (req, res) => {
  db.prepare("DELETE FROM categories WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Tasks ----
app.get("/api/tasks", (_req, res) => {
  res.json(db.prepare("SELECT * FROM tasks ORDER BY status, position, id").all());
});

app.post("/api/tasks", (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: "title required" });
  const rawStatus = STATUSES.includes(req.body.status) ? req.body.status : "backlog";
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : "medium";
  const owner = OWNERS.includes(req.body.owner) ? req.body.owner : "unassigned";
  const status = coupleStatus(owner, rawStatus);
  const pos = db
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE status = ?")
    .get(status).p;
  const info = db
    .prepare(
      `INSERT INTO tasks (title, notes, category_id, priority, owner, status, due_date, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title.trim(),
      req.body.notes || "",
      req.body.category_id || null,
      priority,
      owner,
      status,
      req.body.due_date || null,
      pos
    );
  res.json(db.prepare("SELECT * FROM tasks WHERE id = ?").get(info.lastInsertRowid));
});

app.put("/api/tasks/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  const b = req.body;
  const owner = OWNERS.includes(b.owner) ? b.owner : t.owner;
  const status = coupleStatus(owner, STATUSES.includes(b.status) ? b.status : t.status);
  db.prepare(
    `UPDATE tasks SET
       title = ?, notes = ?, category_id = ?, priority = ?, owner = ?,
       status = ?, due_date = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    b.title?.trim() || t.title,
    b.notes ?? t.notes,
    b.category_id === undefined ? t.category_id : b.category_id || null,
    PRIORITIES.includes(b.priority) ? b.priority : t.priority,
    owner,
    status,
    b.due_date === undefined ? t.due_date : b.due_date || null,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id));
});

// Reorder / move: accepts { status, orderedIds: [...] } for a single column.
app.post("/api/tasks/reorder", (req, res) => {
  const { status, orderedIds } = req.body;
  if (!STATUSES.includes(status) || !Array.isArray(orderedIds))
    return res.status(400).json({ error: "status and orderedIds required" });
  const move = db.prepare("UPDATE tasks SET status = ?, position = ? WHERE id = ?");
  const tx = db.transaction((ids) => {
    ids.forEach((id, i) => move.run(status, i, id));
  });
  tx(orderedIds);
  res.json({ ok: true });
});

// Archive every done task (the "Clear Done" button).
app.post("/api/tasks/clear-done", (_req, res) => {
  const info = db
    .prepare("UPDATE tasks SET archived = 1, updated_at = datetime('now') WHERE status = 'done' AND archived = 0")
    .run();
  res.json({ ok: true, archived: info.changes });
});

// Bring an archived task back (stays in Done).
app.post("/api/tasks/:id/restore", (req, res) => {
  db.prepare("UPDATE tasks SET archived = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.delete("/api/tasks/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Chat ----------
const PEOPLE = ["p1", "p2"];

function markRead(taskId, person, lastId) {
  db.prepare(
    `INSERT INTO reads (task_id, person, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(task_id, person) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`
  ).run(taskId, person, lastId);
}

app.get("/api/tasks/:id/messages", (req, res) => {
  res.json(db.prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY id").all(req.params.id));
});

app.post("/api/tasks/:id/messages", (req, res) => {
  const exists = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
  if (!exists) return res.status(404).json({ error: "not found" });
  const sender = PEOPLE.includes(req.body.sender) ? req.body.sender : null;
  const body = (req.body.body || "").trim();
  if (!sender) return res.status(400).json({ error: "sender required" });
  if (!body) return res.status(400).json({ error: "body required" });
  const info = db
    .prepare("INSERT INTO messages (task_id, sender, body) VALUES (?, ?, ?)")
    .run(req.params.id, sender, body);
  // The sender has implicitly read up to their own message.
  markRead(req.params.id, sender, info.lastInsertRowid);
  res.json(db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid));
});

app.post("/api/tasks/:id/read", (req, res) => {
  const person = PEOPLE.includes(req.body.person) ? req.body.person : null;
  if (!person) return res.status(400).json({ error: "person required" });
  const max = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE task_id = ?").get(req.params.id).m;
  markRead(req.params.id, person, max);
  res.json({ ok: true, last_read_id: max });
});

// Unread summary for one person: per-task counts + latest-message preview.
app.get("/api/unread/:me", (req, res) => {
  const me = PEOPLE.includes(req.params.me) ? req.params.me : null;
  if (!me) return res.status(400).json({ error: "me required" });
  const rows = db
    .prepare(
      `SELECT m.task_id AS task_id, t.title AS title,
         SUM(CASE WHEN m.sender != @me AND m.id > COALESCE(r.last_read_id, 0) THEN 1 ELSE 0 END) AS unread,
         MAX(m.id) AS last_id
       FROM messages m
       JOIN tasks t ON t.id = m.task_id
       LEFT JOIN reads r ON r.task_id = m.task_id AND r.person = @me
       GROUP BY m.task_id
       HAVING unread > 0`
    )
    .all({ me });
  const getMsg = db.prepare("SELECT body, sender, created_at FROM messages WHERE id = ?");
  const items = rows
    .map((row) => {
      const lm = getMsg.get(row.last_id);
      return {
        task_id: row.task_id,
        title: row.title,
        unread: row.unread,
        last_body: lm.body,
        last_sender: lm.sender,
        last_at: lm.created_at,
      };
    })
    .sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
  res.json({ total: items.reduce((s, i) => s + i.unread, 0), items });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kanban running on http://localhost:${PORT}`));
