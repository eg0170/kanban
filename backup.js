import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import db from "./db.js";

// Where to write backups, how often, and how many to keep.
const BACKUP_DIR = process.env.BACKUP_DIR || "/data/backups";
const INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
const KEEP = Number(process.env.BACKUP_KEEP ?? 14);

function stamp() {
  // 2026-05-26T12:30:00.000Z -> 2026-05-26-12-30-00
  return new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+/, "");
}

function prune() {
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("kanban-") && f.endsWith(".db"))
    .map((f) => ({ f, t: statSync(join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(KEEP)) {
    try { unlinkSync(join(BACKUP_DIR, f)); } catch { /* ignore */ }
  }
}

// Consistent online backup (WAL-safe) to a timestamped file.
export async function runBackup() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = join(BACKUP_DIR, `kanban-${stamp()}.db`);
  await db.backup(dest);
  prune();
  console.log(`[backup] wrote ${dest}`);
  return dest;
}

export function startBackups() {
  if (!(INTERVAL_HOURS > 0)) {
    console.log("[backup] disabled (BACKUP_INTERVAL_HOURS <= 0)");
    return;
  }
  // One shortly after boot, then on the configured interval.
  setTimeout(() => runBackup().catch((e) => console.error("[backup] failed:", e.message)), 10_000);
  setInterval(
    () => runBackup().catch((e) => console.error("[backup] failed:", e.message)),
    INTERVAL_HOURS * 3600 * 1000
  );
  console.log(`[backup] every ${INTERVAL_HOURS}h to ${BACKUP_DIR}, keeping ${KEEP}`);
}
