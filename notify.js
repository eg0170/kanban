import webpush from "web-push";
import cron from "node-cron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import db from "./db.js";

// ---------- Config ----------
const DATA_DIR = dirname(process.env.DB_PATH || "/data/kanban.db");
const VAPID_FILE = join(DATA_DIR, "vapid.json");
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@localhost";
const NOTIFY_TIME = process.env.NOTIFY_TIME || "07:00";
const NOTIFY_TZ = process.env.NOTIFY_TZ || "UTC";
const APP_URL = process.env.APP_URL || "/";

let vapidPublicKey = process.env.VAPID_PUBLIC_KEY || null;
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || null;

// ---------- VAPID (auto-generate + persist on first run) ----------
function loadOrGenerateVapid() {
  if (vapidPublicKey && vapidPrivateKey) return;
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(VAPID_FILE)) {
    const j = JSON.parse(readFileSync(VAPID_FILE, "utf8"));
    vapidPublicKey = j.publicKey;
    vapidPrivateKey = j.privateKey;
    return;
  }
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  vapidPublicKey = keys.publicKey;
  vapidPrivateKey = keys.privateKey;
  console.log("[notify] generated new VAPID keys at", VAPID_FILE);
}

export function getPublicKey() {
  return vapidPublicKey;
}

// ---------- Subscriptions ----------
export function saveSubscription(person, subscription) {
  db.prepare(
    `INSERT INTO push_subscriptions (person, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET person = excluded.person, p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(person, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
}

export function removeSubscription(endpoint) {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

// ---------- Digest ----------
// Urgent for `person`: tasks owned by them or marked Joint, not done, not
// archived, with a due date within 2 days (or overdue).
function getUrgent(person) {
  return db
    .prepare(
      `SELECT id, title, owner, status, due_date FROM tasks
       WHERE archived = 0
         AND status != 'done'
         AND (owner = ? OR owner = 'joint')
         AND due_date IS NOT NULL
         AND date(due_date) <= date('now', '+2 day')
       ORDER BY date(due_date) ASC, id ASC
       LIMIT 10`
    )
    .all(person);
}

// Fallback: unclaimed backlog items either of you can grab.
function getBacklog() {
  return db
    .prepare(
      `SELECT id, title FROM tasks
       WHERE archived = 0 AND status = 'backlog'
       ORDER BY id DESC
       LIMIT 5`
    )
    .all();
}

function buildPayload(person) {
  const urgent = getUrgent(person);
  if (urgent.length > 0) {
    const titles = urgent.slice(0, 3).map((t) => t.title);
    const more = urgent.length > 3 ? ` (+${urgent.length - 3} more)` : "";
    return {
      title: `Today's kanban — ${urgent.length} urgent`,
      body: titles.join(" • ") + more,
      url: APP_URL,
    };
  }
  const backlog = getBacklog();
  if (backlog.length === 0) return null; // nothing to say
  const titles = backlog.slice(0, 3).map((t) => t.title);
  const more = backlog.length > 3 ? ` (+${backlog.length - 3} more)` : "";
  return {
    title: `Backlog has ${backlog.length} task${backlog.length === 1 ? "" : "s"} to grab`,
    body: titles.join(" • ") + more,
    url: APP_URL,
  };
}

// ---------- Sending ----------
async function sendToPerson(person, payload) {
  const subs = db.prepare("SELECT * FROM push_subscriptions WHERE person = ?").all(person);
  if (subs.length === 0) return 0;
  const json = JSON.stringify(payload);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        json
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
        console.log("[notify] dropped expired subscription", s.id);
      } else {
        console.error("[notify] send failed:", e.statusCode, e.body || e.message);
      }
    }
  }
  return sent;
}

export async function sendDigest(person) {
  const payload = buildPayload(person);
  if (!payload) return 0;
  return sendToPerson(person, payload);
}

export async function sendAllDigests() {
  for (const person of ["p1", "p2"]) {
    const n = await sendDigest(person);
    if (n > 0) console.log(`[notify] ${person} digest sent to ${n} device(s)`);
  }
}

export async function sendTest(person) {
  return sendToPerson(person, {
    title: "Kanban test",
    body: "Push notifications are working 🎉",
    url: APP_URL,
  });
}

// ---------- Init ----------
export function init() {
  loadOrGenerateVapid();
  webpush.setVapidDetails(VAPID_SUBJECT, vapidPublicKey, vapidPrivateKey);
  const [hh, mm] = NOTIFY_TIME.split(":").map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    console.log("[notify] invalid NOTIFY_TIME, daily digest disabled");
    return;
  }
  cron.schedule(
    `${mm} ${hh} * * *`,
    () => sendAllDigests().catch((e) => console.error("[notify] digest failed:", e.message)),
    { timezone: NOTIFY_TZ }
  );
  console.log(`[notify] daily digest scheduled for ${NOTIFY_TIME} (${NOTIFY_TZ})`);
}
