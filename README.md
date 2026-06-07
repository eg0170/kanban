# Household Kanban

A self-hosted, shared to-do board for two people (plus joint tasks). Status
columns (Backlog → To Do → In Progress → Done), categories, priorities, due
dates, per-task chat with unread tracking, image attachments, a daily push
digest, and automated SQLite backups.

Stack: Node + Express + better-sqlite3, with a dependency-free vanilla-JS
frontend. Single Docker container; data is one SQLite file.

## Develop on a new machine

Prerequisites:

- **Node 22** (see `.nvmrc`). `nvm use` if you use nvm.
- A C/C++ build toolchain for `better-sqlite3` (native module). Prebuilt
  binaries usually download automatically, but if `npm install` tries to
  compile you'll need:
  - **macOS:** `xcode-select --install`
  - **Linux:** `python3`, `make`, `g++`
  - **Windows:** Visual Studio Build Tools (C++), or `npm i -g windows-build-tools`

Run it:

```bash
git clone https://github.com/eg0170/kanban.git
cd kanban
npm install
npm start           # or: npm run dev   (auto-restart on change)
# open http://localhost:3000
```

That's it — no config needed for local dev. On first run it creates
`./data/kanban.db`, seeds default categories, and auto-generates VAPID keys
for push (`./data/vapid.json`).

## Where the data lives

- **Local dev:** `./data/` (gitignored) — you start with an empty board.
- **Production:** the `kanban-data` Docker volume; backups go to the NAS.
- The repo never contains real data or secrets. To work with real data
  locally, copy a backup `.db` over `./data/kanban.db` (stop the app first).

## Configuration (environment variables)

All optional; sensible defaults apply. Set in `compose.yaml` (production) or
your shell (local).

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/kanban.db` | SQLite file location |
| `DEFAULT_PERSON1` / `DEFAULT_PERSON2` | `Person 1` / `Person 2` | Seed names (editable in Settings) |
| `DEFAULT_CATEGORIES` | `Home,Health,Work,Errands` | Seed categories |
| `BACKUP_DIR` | `<db dir>/backups` | Where snapshots are written |
| `BACKUP_INTERVAL_HOURS` | `24` | `0` disables automated backups |
| `BACKUP_KEEP` | `14` | Snapshots to retain (rotation) |
| `APP_URL` | `/` | Link a notification opens |
| `NOTIFY_TIME` | `07:00` | Daily digest time (`HH:MM`) |
| `NOTIFY_TZ` | `UTC` | Timezone for the digest |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | VAPID contact |

VAPID keys auto-generate and persist to `<db dir>/vapid.json` on first run; no
manual key setup needed.

## Deployment

Pushing to `main` triggers a GitHub Action that builds and publishes the image
to `ghcr.io/eg0170/kanban:latest`. On the server (Dockge) the stack pulls that
image — see `compose.yaml`. Update via Dockge's **Update** button (pull +
recreate). `cloudflared/compose.yaml` is a separate stack for remote access via
Cloudflare Tunnel (token set in Dockge, never committed).

Backups: consistent online SQLite snapshots run on a schedule to `BACKUP_DIR`
(an NFS share on the NAS in production), rotated to the last `BACKUP_KEEP`.

## Restore a backup

With the app stopped:

```bash
cp /path/to/kanban-<timestamp>.db ./data/kanban.db
rm -f ./data/kanban.db-wal ./data/kanban.db-shm
```
