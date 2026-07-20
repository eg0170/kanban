const COLUMNS = [
  { status: "backlog", title: "Backlog" },
  { status: "todo", title: "To Do" },
  { status: "in_progress", title: "In Progress" },
  { status: "done", title: "Done" },
];

const state = {
  tasks: [],
  categories: [],
  settings: {
    person1: "Person 1",
    person2: "Person 2",
    color_unassigned: "#475569",
    color_joint: "#1e3a8a",
    color_p1: "#0e7490",
    color_p2: "#9d174d",
  },
  filter: { owner: "all", category: "all" },
  showArchived: false,
  selected: new Set(),
  me: null,
  unread: { total: 0, map: {}, items: [] },
  activeTab: "details",
};

const $ = (sel) => document.querySelector(sel);

// ---------- Toasts ----------
function showToast(message) {
  const wrap = $("#toasts");
  // Dedupe: don't stack identical messages (e.g. repeated poll failures).
  if ([...wrap.children].some((t) => t.textContent === message)) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------- API (errors are surfaced, not swallowed) ----------
let pollingQuietly = false; // background polls shouldn't toast on every tick

async function request(method, url, body) {
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (!pollingQuietly) showToast("Network error — couldn't reach the server");
    throw e;
  }
  if (!r.ok) {
    let msg = `Request failed (${r.status})`;
    try {
      const j = await r.json();
      if (j.error) msg = j.error;
    } catch { /* non-JSON error body */ }
    if (!pollingQuietly) showToast(msg);
    throw new Error(msg);
  }
  return r.json();
}

const api = {
  get: (url) => request("GET", url),
  send: (method, url, body) => request(method, url, body),
};

function ownerName(owner) {
  if (owner === "p1") return state.settings.person1;
  if (owner === "p2") return state.settings.person2;
  if (owner === "unassigned") return "Unassigned";
  return "Joint";
}
function categoryById(id) { return state.categories.find((c) => c.id === id); }
function ownerColor(owner) { return state.settings["color_" + owner] || "#475569"; }

// ---------- Identity (who am I, remembered in a cookie) ----------
function getMe() {
  const m = document.cookie.match(/(?:^|; )kanban_me=(p1|p2)/);
  return m ? m[1] : null;
}
function setMe(p) {
  // 400 days is the max a Chromium browser will persist a cookie.
  document.cookie = `kanban_me=${p}; max-age=34560000; path=/; samesite=lax`;
  state.me = p;
}
function meName() {
  return state.me ? ownerName(state.me) : "—";
}

// ---------- Load ----------
let dataVersion = null; // server-side change counter; drives live board sync

async function loadAll() {
  const [tasks, categories, settings, version] = await Promise.all([
    api.get("/api/tasks"),
    api.get("/api/categories"),
    api.get("/api/settings"),
    api.get("/api/version"),
  ]);
  state.tasks = tasks;
  state.categories = categories;
  state.settings = settings;
  dataVersion = version.v;
  // Drop selections for tasks that no longer exist.
  const ids = new Set(tasks.map((t) => t.id));
  [...state.selected].forEach((id) => { if (!ids.has(id)) state.selected.delete(id); });
  await loadUnread();
  syncOwnerLabels();
  renderCategoryFilter();
  renderBoard();
  renderBulkBar();
  renderIdentity();
}

async function loadUnread() {
  if (!state.me) {
    state.unread = { total: 0, map: {}, items: [] };
  } else {
    const data = await api.get(`/api/unread/${state.me}`);
    const map = {};
    data.items.forEach((i) => { map[i.task_id] = i.unread; });
    state.unread = { total: data.total, map, items: data.items };
  }
  renderInboxButton();
}

function renderInboxButton() {
  const badge = $("#inbox-badge");
  badge.hidden = state.unread.total === 0;
  badge.textContent = state.unread.total;
}

function renderIdentity() {
  $("#btn-whoami").textContent = state.me ? `You: ${meName()}` : "Set who you are";
}

function syncOwnerLabels() {
  $("#filter-owner").querySelector('option[value="p1"]').textContent = state.settings.person1;
  $("#filter-owner").querySelector('option[value="p2"]').textContent = state.settings.person2;
}

// ---------- Board ----------
function visibleTasks() {
  return state.tasks.filter((t) => {
    if (state.filter.owner !== "all" && t.owner !== state.filter.owner) return false;
    if (state.filter.category !== "all" && String(t.category_id) !== state.filter.category) return false;
    return true;
  });
}

// ---------- Urgency: blend deadline + priority ----------
const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };
const URGENT_DAYS = 2; // "due within ~48h"; tile turns red at/under this

function daysUntilDue(iso) {
  if (!iso) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso + "T00:00:00") - today) / 86400000);
}

// Higher score = more pressing. Deadline drives the broad order; priority
// contributes and breaks ties within the same deadline bucket.
function urgencyScore(t) {
  const pr = PRIORITY_RANK[t.priority] || 2;
  const d = daysUntilDue(t.due_date);
  let due;
  if (d === Infinity) due = 0;        // no due date
  else if (d < 0) due = 6;            // overdue
  else if (d <= URGENT_DAYS) due = 4; // within ~48h
  else if (d <= 7) due = 2;           // this week
  else if (d <= 14) due = 1;          // next week
  else due = 0.5;                     // further out
  return due * 2 + pr;
}

function byUrgency(a, b) {
  const s = urgencyScore(b) - urgencyScore(a);
  if (s) return s;
  const ad = a.due_date || "9999-12-31"; // dated tasks sort before undated
  const bd = b.due_date || "9999-12-31";
  if (ad !== bd) return ad < bd ? -1 : 1; // sooner due date first
  const p = (PRIORITY_RANK[b.priority] || 2) - (PRIORITY_RANK[a.priority] || 2);
  return p || a.id - b.id;
}

function isUrgent(t) {
  return t.status !== "done" && t.due_date != null && daysUntilDue(t.due_date) <= URGENT_DAYS;
}

function renderBoard() {
  const board = $("#board");
  board.innerHTML = "";
  board.classList.toggle("with-archived", state.showArchived);
  const tasks = visibleTasks();
  const active = tasks.filter((t) => !t.archived);

  for (const col of COLUMNS) {
    const colTasks = active
      .filter((t) => t.status === col.status)
      .sort(byUrgency);

    const clearBtn =
      col.status === "done"
        ? `<button class="col-action" id="clear-done" title="Archive all done tasks">Clear</button>`
        : "";

    const el = document.createElement("section");
    el.className = "column";
    el.innerHTML = `
      <div class="column-head"><span>${col.title}</span>
        <span class="head-right"><span class="count">${colTasks.length}</span>${clearBtn}</span></div>
      <div class="column-body" data-status="${col.status}"></div>`;
    const body = el.querySelector(".column-body");

    body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("drag-over"); });
    body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
    body.addEventListener("drop", (e) => { e.preventDefault(); body.classList.remove("drag-over"); onDrop(e, col.status, body); });

    colTasks.forEach((t) => body.appendChild(cardEl(t)));
    board.appendChild(el);
  }

  if (state.showArchived) {
    const archived = tasks
      .filter((t) => t.archived)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const el = document.createElement("section");
    el.className = "column archived-column";
    el.innerHTML = `
      <div class="column-head"><span>Archived</span><span class="count">${archived.length}</span></div>
      <div class="column-body"></div>`;
    const body = el.querySelector(".column-body");
    archived.forEach((t) => body.appendChild(cardEl(t, true)));
    board.appendChild(el);
  }

  const cd = $("#clear-done");
  if (cd) cd.addEventListener("click", clearDone);
}

async function clearDone() {
  const n = state.tasks.filter((t) => t.status === "done" && !t.archived).length;
  if (!n) return;
  if (!confirm(`Archive ${n} done task${n === 1 ? "" : "s"}? You can see them again with "Show archived".`)) return;
  await api.send("POST", "/api/tasks/clear-done");
  await loadAll();
}

// ---------- Multi-select & bulk edit ----------
function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  document
    .querySelectorAll(`.card[data-id="${id}"]`)
    .forEach((c) => c.classList.toggle("selected", state.selected.has(id)));
  renderBulkBar();
}

function clearSelection() {
  state.selected.clear();
  document.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
  renderBulkBar();
}

function renderBulkBar() {
  const n = state.selected.size;
  $("#bulk-bar").hidden = n === 0;
  $("#bulk-count").textContent = `${n} selected`;
}

function openBulkDialog() {
  if (state.selected.size === 0) return;
  $("#bulk-dialog-count").textContent = state.selected.size;
  // Category: leave-unchanged / none / each category.
  $("#bulk-category").innerHTML =
    `<option value="">(leave unchanged)</option><option value="none">— none —</option>` +
    state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  // Owner: leave-unchanged / the owners.
  $("#bulk-owner").innerHTML =
    `<option value="">(leave unchanged)</option>
     <option value="unassigned">Unassigned</option>
     <option value="joint">Joint</option>
     <option value="p1">${escapeHtml(state.settings.person1)}</option>
     <option value="p2">${escapeHtml(state.settings.person2)}</option>`;
  $("#bulk-priority").value = "";
  $("#bulk-status").value = "";
  $("#bulk-due-mode").value = "";
  $("#bulk-due").value = "";
  $("#bulk-due").disabled = true;
  $("#bulk-dialog").showModal();
}

$("#bulk-due-mode").addEventListener("change", (e) => {
  $("#bulk-due").disabled = e.target.value !== "set";
});

$("#bulk-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {};
  const cat = $("#bulk-category").value;
  if (cat === "none") payload.category_id = null;
  else if (cat) payload.category_id = Number(cat);
  if ($("#bulk-priority").value) payload.priority = $("#bulk-priority").value;
  if ($("#bulk-owner").value) payload.owner = $("#bulk-owner").value;
  if ($("#bulk-status").value) payload.status = $("#bulk-status").value;
  const dueMode = $("#bulk-due-mode").value;
  if (dueMode === "clear") payload.due_date = null;
  else if (dueMode === "set") payload.due_date = $("#bulk-due").value || null;

  if (Object.keys(payload).length === 0) {
    $("#bulk-dialog").close();
    return;
  }
  payload.actor = state.me;
  await Promise.all([...state.selected].map((id) => api.send("PUT", `/api/tasks/${id}`, payload)));
  state.selected.clear();
  $("#bulk-dialog").close();
  await loadAll();
});

function cardEl(t, isArchived = false) {
  const cat = categoryById(t.category_id);
  const card = document.createElement("div");
  card.className = "card" + (isArchived ? " archived" : "");
  if (!isArchived && state.selected.has(t.id)) card.classList.add("selected");
  if (!isArchived && isUrgent(t)) card.classList.add("urgent");
  if (!isArchived) card.draggable = true;
  card.dataset.id = t.id;
  if (cat) card.style.setProperty("--cat-color", cat.color);

  let due = "";
  if (t.due_date) {
    const overdue = t.status !== "done" && t.due_date < new Date().toISOString().slice(0, 10);
    due = `<span class="tag due ${overdue ? "overdue" : ""}">${fmtDate(t.due_date)}</span>`;
  }

  card.innerHTML = `
    <div class="title">${escapeHtml(t.title)}</div>
    <div class="meta">
      ${cat ? `<span class="tag cat" style="background:${cat.color}">${escapeHtml(cat.name)}</span>` : ""}
      <span class="tag prio-${t.priority}">${t.priority}</span>
      <span class="tag owner" style="background:${ownerColor(t.owner)}">${escapeHtml(ownerName(t.owner))}</span>
      ${due}
      ${state.unread.map[t.id] ? `<span class="tag unread" title="Unread messages">💬 ${state.unread.map[t.id]}</span>` : ""}
      ${t.attachment_count ? `<span class="tag attach" title="Images">📎 ${t.attachment_count}</span>` : ""}
      ${isArchived ? `<button class="restore" title="Restore to Done">Restore</button>` : ""}
    </div>`;

  card.addEventListener("click", (e) => {
    if (e.target.closest(".restore")) return;
    if (!isArchived && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      toggleSelect(t.id);
      return;
    }
    openTaskDialog(t);
  });

  if (isArchived) {
    card.querySelector(".restore").addEventListener("click", async (e) => {
      e.stopPropagation();
      await api.send("POST", `/api/tasks/${t.id}/restore`);
      await loadAll();
    });
  } else {
    card.addEventListener("dragstart", (e) => {
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", String(t.id));
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  }
  return card;
}

async function onDrop(e, status, body) {
  const id = Number(e.dataTransfer.getData("text/plain"));
  const dragging = document.querySelector(".card.dragging");
  // Figure out drop position relative to existing cards.
  const after = [...body.querySelectorAll(".card:not(.dragging)")].find((c) => {
    const box = c.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2;
  });
  if (dragging) {
    if (after) body.insertBefore(dragging, after);
    else body.appendChild(dragging);
  }
  const orderedIds = [...body.querySelectorAll(".card")].map((c) => Number(c.dataset.id));
  // Optimistic local update.
  const task = state.tasks.find((t) => t.id === id);
  if (task) task.status = status;
  await api.send("POST", "/api/tasks/reorder", { status, orderedIds, actor: state.me });
  await loadAll();
}

// ---------- Task dialog ----------
function fillCategorySelect(sel, selectedId) {
  sel.innerHTML = `<option value="">— none —</option>` +
    state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  if (selectedId != null) sel.value = String(selectedId);
}
function fillOwnerSelect(sel, selected) {
  sel.innerHTML = `
    <option value="unassigned">Unassigned</option>
    <option value="joint">Joint</option>
    <option value="p1">${escapeHtml(state.settings.person1)}</option>
    <option value="p2">${escapeHtml(state.settings.person2)}</option>`;
  if (selected) sel.value = selected;
}

let editingOriginal = null; // snapshot for changed-fields-only saves

function openTaskDialog(task, initialTab = "details") {
  const isEdit = !!task;
  editingOriginal = isEdit ? { ...task } : null;
  $("#task-dialog-title").textContent = isEdit ? "Edit task" : "New task";
  $("#task-id").value = isEdit ? task.id : "";
  $("#task-title").value = isEdit ? task.title : "";
  $("#task-notes").value = isEdit ? task.notes : "";
  fillCategorySelect($("#task-category"), isEdit ? task.category_id : "");
  $("#task-priority").value = isEdit ? task.priority : "medium";
  fillOwnerSelect($("#task-owner"), isEdit ? task.owner : "unassigned");
  $("#task-status").value = isEdit ? task.status : "backlog";
  $("#task-due").value = isEdit && task.due_date ? task.due_date : "";
  $("#task-delete").hidden = !isEdit;

  // Tabs only make sense for an existing task (chat needs a saved task).
  $("#task-tabs").hidden = !isEdit;
  const unread = isEdit ? state.unread.map[task.id] || 0 : 0;
  const tabBadge = $("#tab-chat-badge");
  tabBadge.hidden = unread === 0;
  tabBadge.textContent = unread;
  setTab(isEdit ? initialTab : "details");

  // Images work for both new and existing tasks. For a new task they're queued
  // client-side and uploaded right after the task is created on Save.
  $("#task-images").hidden = false;
  pendingImages = [];
  if (isEdit) renderAttachments(task.id);
  else $("#image-thumbs").innerHTML = "";

  $("#task-dialog").showModal();
}

// ---------- Image attachments ----------
let pendingImages = []; // resized images queued for a not-yet-saved task

async function renderAttachments(taskId) {
  const wrap = $("#image-thumbs");
  const items = await api.get(`/api/tasks/${taskId}/attachments`);
  wrap.innerHTML = items
    .map(
      (a) => `<div class="thumb" data-id="${a.id}">
        <a href="/api/attachments/${a.id}" target="_blank" rel="noopener noreferrer">
          <img src="/api/attachments/${a.id}" alt="${escapeHtml(a.filename || "image")}" loading="lazy" />
        </a>
        <button type="button" class="thumb-del" data-id="${a.id}" title="Remove">&times;</button>
      </div>`
    )
    .join("");
}

function renderPendingThumbs() {
  $("#image-thumbs").innerHTML = pendingImages
    .map(
      (img, i) => `<div class="thumb" data-pending="${i}">
        <img src="data:${img.mime};base64,${img.base64}" alt="${escapeHtml(img.filename || "image")}" />
        <button type="button" class="thumb-del" data-pending="${i}" title="Remove">&times;</button>
      </div>`
    )
    .join("");
}

// Downscale + re-encode in the browser so stored images stay small (keeps the
// SQLite DB and its backups lean). Returns { mime, base64, filename }.
function resizeImage(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const finish = (blob, mime) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ mime, base64: reader.result.split(",")[1], filename: file.name });
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      };
      canvas.toBlob((b) => {
        if (b) finish(b, "image/webp");
        else canvas.toBlob((j) => (j ? finish(j, "image/jpeg") : reject(new Error("encode failed"))), "image/jpeg", quality);
      }, "image/webp", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not an image")); };
    img.src = url;
  });
}

async function addImageFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith("image/"));
  if (!imgs.length) return;
  const btn = $("#image-add-btn");
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const taskId = $("#task-id").value;
    for (const file of imgs) {
      const img = await resizeImage(file);
      if (taskId) {
        // Existing task: upload immediately.
        await api.send("POST", `/api/tasks/${taskId}/attachments`, { mime: img.mime, data: img.base64, filename: img.filename });
      } else {
        // New task: queue until the task is saved.
        pendingImages.push(img);
      }
    }
    if (taskId) await renderAttachments(taskId);
    else renderPendingThumbs();
  } catch (e) {
    alert("Couldn't add image: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "+ Add image";
  }
}

$("#image-add-btn").addEventListener("click", () => $("#image-input").click());
$("#image-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = ""; // allow re-selecting the same file
  if (files.length) await addImageFiles(files);
});

// Paste an image anywhere in the task dialog to attach it.
$("#task-dialog").addEventListener("paste", async (e) => {
  const files = [...(e.clipboardData?.items || [])]
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (files.length) {
    e.preventDefault();
    await addImageFiles(files);
  }
});

$("#image-thumbs").addEventListener("click", async (e) => {
  const del = e.target.closest(".thumb-del");
  if (!del) return;
  e.preventDefault();
  if (del.dataset.pending !== undefined) {
    pendingImages.splice(Number(del.dataset.pending), 1);
    renderPendingThumbs();
    return;
  }
  if (confirm("Remove this image?")) {
    await api.send("DELETE", `/api/attachments/${del.dataset.id}`);
    await renderAttachments($("#task-id").value);
  }
});

$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#task-id").value;
  const payload = {
    title: $("#task-title").value,
    notes: $("#task-notes").value,
    category_id: $("#task-category").value ? Number($("#task-category").value) : null,
    priority: $("#task-priority").value,
    owner: $("#task-owner").value,
    status: $("#task-status").value,
    due_date: $("#task-due").value || null,
    actor: state.me,
  };
  if (id) {
    // Send only the fields that actually changed, so a stale form can't
    // clobber edits the other person made while this dialog was open. This
    // also lets the server auto-claim unassigned tasks moved out of Backlog
    // (owner is omitted when untouched).
    const diff = { actor: state.me };
    let changed = false;
    for (const key of ["title", "notes", "category_id", "priority", "owner", "status", "due_date"]) {
      const before = editingOriginal ? editingOriginal[key] ?? null : null;
      const after = payload[key] ?? null;
      if (String(before ?? "") !== String(after ?? "")) {
        diff[key] = payload[key];
        changed = true;
      }
    }
    if (changed) await api.send("PUT", `/api/tasks/${id}`, diff);
  } else {
    const created = await api.send("POST", "/api/tasks", payload);
    // Upload any images queued while the task was still unsaved.
    if (created && created.id) {
      for (const img of pendingImages) {
        await api.send("POST", `/api/tasks/${created.id}/attachments`, { mime: img.mime, data: img.base64, filename: img.filename });
      }
    }
  }
  pendingImages = [];
  $("#task-dialog").close(); // 'close' listener reloads the board.
});

$("#task-delete").addEventListener("click", async () => {
  const id = $("#task-id").value;
  if (id && confirm("Delete this task?")) {
    await api.send("DELETE", `/api/tasks/${id}`);
    $("#task-dialog").close();
  }
});

// Refresh the board (and unread badges) whenever the task dialog closes,
// since opening a task's chat marks its messages read.
$("#task-dialog").addEventListener("close", () => loadAll());

// ---------- Task dialog tabs (Details / Chat) ----------
function setTab(name) {
  state.activeTab = name;
  document.querySelectorAll("#task-tabs .tab").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.tab === name)
  );
  $("#panel-details").hidden = name !== "details";
  $("#panel-chat").hidden = name !== "chat";
  if (name === "chat") enterChat();
}

$("#task-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) setTab(tab.dataset.tab);
});

// ---------- Per-task chat ----------
async function enterChat() {
  const taskId = $("#task-id").value;
  if (!taskId) return;
  $("#chat-input").value = "";
  await renderChat(taskId);
  // Viewing the chat marks it read and clears the tab badge.
  if (state.me) await api.send("POST", `/api/tasks/${taskId}/read`, { person: state.me });
  $("#tab-chat-badge").hidden = true;
}

async function renderChat(taskId) {
  const box = $("#chat-messages");
  const msgs = await api.get(`/api/tasks/${taskId}/messages`);
  if (msgs.length === 0) {
    box.innerHTML = `<p class="chat-empty">No messages yet.</p>`;
  } else {
    box.innerHTML = msgs
      .map((m) => {
        const mine = m.sender === state.me;
        const actions = mine
          ? `<div class="msg-actions">
               <button type="button" class="msg-edit" data-id="${m.id}">Edit</button>
               <button type="button" class="msg-del" data-id="${m.id}">Delete</button>
             </div>`
          : "";
        return `<div class="msg ${mine ? "mine" : "theirs"}" data-id="${m.id}" data-body="${escapeHtml(m.body)}">
          <div class="msg-meta">${escapeHtml(ownerName(m.sender))} · ${fmtDateTime(m.created_at)}</div>
          <div class="msg-body">${linkify(m.body)}</div>
          ${actions}
        </div>`;
      })
      .join("");
  }
  box.scrollTop = box.scrollHeight;
}

// Inline edit / delete on your own messages (event-delegated).
$("#chat-messages").addEventListener("click", async (e) => {
  const taskId = $("#task-id").value;
  const editBtn = e.target.closest(".msg-edit");
  const delBtn = e.target.closest(".msg-del");
  if (delBtn) {
    if (confirm("Delete this message?")) {
      await api.send("DELETE", `/api/messages/${delBtn.dataset.id}`, { me: state.me });
      await renderChat(taskId);
    }
    return;
  }
  if (editBtn) {
    const msg = editBtn.closest(".msg");
    if (msg.querySelector(".msg-editor")) return; // already editing
    const current = msg.dataset.body;
    const bodyEl = msg.querySelector(".msg-body");
    const editor = document.createElement("div");
    editor.className = "msg-editor";
    editor.innerHTML = `<textarea class="msg-edit-input" rows="2"></textarea>
      <div class="msg-editor-actions">
        <button type="button" class="msg-edit-save primary">Save</button>
        <button type="button" class="msg-edit-cancel">Cancel</button>
      </div>`;
    editor.querySelector("textarea").value = current;
    bodyEl.after(editor);
    bodyEl.style.display = "none";
    const ta = editor.querySelector("textarea");
    ta.focus();
    editor.querySelector(".msg-edit-cancel").addEventListener("click", () => { editor.remove(); bodyEl.style.display = ""; });
    editor.querySelector(".msg-edit-save").addEventListener("click", async () => {
      const body = ta.value.trim();
      if (!body) return;
      await api.send("PUT", `/api/messages/${editBtn.dataset.id}`, { me: state.me, body });
      await renderChat(taskId);
    });
  }
});

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const taskId = $("#task-id").value;
  const body = $("#chat-input").value.trim();
  if (!taskId || !body) return;
  if (!state.me) { openWhoami(); return; }
  await api.send("POST", `/api/tasks/${taskId}/messages`, { sender: state.me, body });
  $("#chat-input").value = "";
  await renderChat(taskId);
});

// ---------- Identity prompt ----------
function openWhoami() {
  $("#whoami-p1").textContent = state.settings.person1;
  $("#whoami-p2").textContent = state.settings.person2;
  $("#whoami-dialog").showModal();
}
async function chooseMe(p) {
  setMe(p);
  $("#whoami-dialog").close();
  await loadAll();
}
$("#whoami-p1").addEventListener("click", () => chooseMe("p1"));
$("#whoami-p2").addEventListener("click", () => chooseMe("p2"));
$("#btn-whoami").addEventListener("click", openWhoami);

// ---------- Unified unread inbox ----------
function renderInbox() {
  const list = $("#inbox-list");
  const items = state.unread.items;
  $("#inbox-empty").hidden = items.length > 0;
  list.innerHTML = items
    .map(
      (i) => `<li data-task="${i.task_id}">
        <div class="inbox-row">
          <span class="inbox-title">${escapeHtml(i.title)}</span>
          <span class="tag unread">💬 ${i.unread}</span>
        </div>
        <div class="inbox-preview">${escapeHtml(ownerName(i.last_sender))}: ${escapeHtml(i.last_body)}</div>
      </li>`
    )
    .join("");
  list.querySelectorAll("li").forEach((li) =>
    li.addEventListener("click", () => {
      const id = Number(li.dataset.task);
      $("#inbox-dialog").close();
      const task = state.tasks.find((t) => t.id === id);
      if (task) openTaskDialog(task, "chat");
    })
  );
}
function openInbox() {
  renderInbox();
  $("#inbox-dialog").showModal();
}
$("#btn-inbox").addEventListener("click", openInbox);

// ---------- Lightweight polling for live unread badges ----------
// Patch each card's unread badge in place (no full board re-render).
function patchUnreadBadges() {
  document.querySelectorAll(".card").forEach((card) => {
    const meta = card.querySelector(".meta");
    if (!meta) return;
    const id = Number(card.dataset.id);
    const existing = meta.querySelector(".tag.unread");
    if (existing) existing.remove();
    const n = state.unread.map[id] || 0;
    if (n > 0) {
      const span = document.createElement("span");
      span.className = "tag unread";
      span.title = "Unread messages";
      span.textContent = `💬 ${n}`;
      const restore = meta.querySelector(".restore");
      if (restore) meta.insertBefore(span, restore);
      else meta.appendChild(span);
    }
  });
}

async function pollUnread() {
  if (!state.me) return;

  // Live board sync: if anything changed server-side (the other person added,
  // moved, or edited something), re-render the whole board. Skip mid-drag so
  // we never yank a card out from under the cursor. loadAll() also refreshes
  // unread state, so the badge patching below is only needed when unchanged.
  const { v } = await api.get("/api/version");
  if (dataVersion !== null && v !== dataVersion && !document.querySelector(".card.dragging")) {
    await loadAll(); // updates dataVersion itself
  } else {
    dataVersion = v;
    await loadUnread(); // refreshes state.unread + inbox button
    patchUnreadBadges();
  }
  if ($("#inbox-dialog").open) renderInbox();

  const dlg = $("#task-dialog");
  if (!dlg.open) return;
  const id = $("#task-id").value;
  if (!id) return;

  if (state.activeTab === "chat") {
    // Refresh the open chat only when messages were added/removed (avoids
    // scroll jank) and never while you're mid-edit.
    const editing = $("#chat-messages").querySelector(".msg-editor");
    if (!editing) {
      const msgs = await api.get(`/api/tasks/${id}/messages`);
      const shown = $("#chat-messages").querySelectorAll(".msg").length;
      if (msgs.length !== shown) {
        await renderChat(id);
        await api.send("POST", `/api/tasks/${id}/read`, { person: state.me });
      }
    }
    $("#tab-chat-badge").hidden = true;
  } else {
    // On the Details tab, surface newly arrived messages on the Chat tab badge.
    const n = state.unread.map[Number(id)] || 0;
    const badge = $("#tab-chat-badge");
    badge.hidden = n === 0;
    badge.textContent = n;
  }
}

setInterval(async () => {
  if (document.visibilityState !== "visible") return;
  pollingQuietly = true;
  try {
    await pollUnread();
  } catch { /* transient poll failure — next tick will retry */ }
  finally {
    pollingQuietly = false;
  }
}, 15000);

// Also sync immediately when the app regains focus (e.g. phone unlocked),
// so you don't wait up to 15s to see the other person's changes.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    pollingQuietly = true;
    pollUnread().catch(() => {}).finally(() => { pollingQuietly = false; });
  }
});

// ---------- Categories dialog ----------
function renderCategoryFilter() {
  const sel = $("#filter-category");
  const current = sel.value;
  sel.innerHTML = `<option value="all">All</option>` +
    state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  sel.value = state.categories.some((c) => String(c.id) === current) ? current : "all";
}

function renderCategoryList() {
  const list = $("#cat-list");
  list.innerHTML = "";
  state.categories.forEach((c) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <input type="color" value="${c.color}" />
      <input type="text" value="${escapeHtml(c.name)}" maxlength="40" />
      <button class="save">Save</button>
      <button class="danger del">✕</button>`;
    const [color, name] = li.querySelectorAll("input");
    li.querySelector(".save").addEventListener("click", async () => {
      await api.send("PUT", `/api/categories/${c.id}`, { name: name.value, color: color.value });
      await loadAll();
    });
    li.querySelector(".del").addEventListener("click", async () => {
      if (confirm(`Delete category "${c.name}"? Tasks keep their data but lose this label.`)) {
        await api.send("DELETE", `/api/categories/${c.id}`);
        await loadAll();
        renderCategoryList();
      }
    });
    list.appendChild(li);
  });
}

$("#cat-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#cat-new-name").value.trim();
  if (!name) return;
  await api.send("POST", "/api/categories", { name, color: $("#cat-new-color").value });
  $("#cat-new-name").value = "";
  await loadAll();
  renderCategoryList();
});

// ---------- Settings dialog ----------
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api.send("PUT", "/api/settings", {
    person1: $("#set-p1").value,
    person2: $("#set-p2").value,
    color_p1: $("#set-color-p1").value,
    color_p2: $("#set-color-p2").value,
    color_joint: $("#set-color-joint").value,
    color_unassigned: $("#set-color-unassigned").value,
  });
  $("#settings-dialog").close();
  await loadAll();
});

// ---------- Wiring ----------
$("#btn-add").addEventListener("click", () => openTaskDialog(null));
$("#btn-archived").addEventListener("click", () => {
  state.showArchived = !state.showArchived;
  $("#btn-archived").textContent = state.showArchived ? "Hide archived" : "Show archived";
  renderBoard();
});
$("#btn-categories").addEventListener("click", () => { renderCategoryList(); $("#cat-dialog").showModal(); });
$("#btn-settings").addEventListener("click", () => {
  $("#set-p1").value = state.settings.person1;
  $("#set-p2").value = state.settings.person2;
  $("#set-color-p1").value = state.settings.color_p1;
  $("#set-color-p2").value = state.settings.color_p2;
  $("#set-color-joint").value = state.settings.color_joint;
  $("#set-color-unassigned").value = state.settings.color_unassigned;
  renderPushUI();
  $("#settings-dialog").showModal();
});
$("#bulk-edit").addEventListener("click", openBulkDialog);
$("#bulk-clear").addEventListener("click", clearSelection);
$("#filter-owner").addEventListener("change", (e) => { state.filter.owner = e.target.value; renderBoard(); });
$("#filter-category").addEventListener("change", (e) => { state.filter.category = e.target.value; renderBoard(); });
document.querySelectorAll(".dialog-close").forEach((b) =>
  b.addEventListener("click", () => b.closest("dialog").close())
);

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Escape everything, then turn http(s) URLs into new-tab links. Safe because
// only http/https-scheme matches are wrapped, and both text and href are escaped.
function linkify(text) {
  const urlRe = /(https?:\/\/[^\s<]+)/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = urlRe.exec(text))) {
    out += escapeHtml(text.slice(last, m.index));
    const url = m[0];
    out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}
function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtDateTime(s) {
  // SQLite stores UTC ("YYYY-MM-DD HH:MM:SS"); parse as UTC then show local.
  const d = new Date(s.replace(" ", "T") + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------- Web Push (PWA) ----------
const PUSH_SUPPORTED = "serviceWorker" in navigator && "PushManager" in window;

function isIOS() { return /iP(hone|ad|od)/.test(navigator.userAgent); }
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration() {
  if (!PUSH_SUPPORTED) return null;
  return (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register("/sw.js"));
}

async function currentSubscription() {
  const reg = await getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function enablePush() {
  if (!state.me) { openWhoami(); return; }
  const reg = await getRegistration();
  if (!reg) return;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { await renderPushUI(); return; }
  const { key } = await api.get("/api/push/public-key");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  }
  await api.send("POST", "/api/push/subscribe", { person: state.me, subscription: sub.toJSON() });
  await renderPushUI();
}

async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await api.send("POST", "/api/push/unsubscribe", { endpoint });
  }
  await renderPushUI();
}

async function renderPushUI() {
  const status = $("#push-status");
  const toggle = $("#push-toggle");
  const test = $("#push-test");
  test.hidden = true;
  toggle.disabled = false;

  if (!PUSH_SUPPORTED) {
    status.textContent = "Push notifications aren't supported in this browser.";
    toggle.hidden = true;
    return;
  }
  if (isIOS() && !isStandalone()) {
    status.textContent = "On iPhone: tap Share → Add to Home Screen, then open this app from your Home Screen to enable notifications.";
    toggle.hidden = true;
    return;
  }
  toggle.hidden = false;
  if (Notification.permission === "denied") {
    status.textContent = "Notifications are blocked. Allow them for this site in your browser settings.";
    toggle.disabled = true;
    return;
  }
  const sub = await currentSubscription();
  if (sub) {
    status.textContent = `Notifications ON for ${meName()} on this device.`;
    toggle.textContent = "Disable";
    test.hidden = false;
  } else {
    status.textContent = `Notifications off. Enable to get a daily digest for ${meName()}.`;
    toggle.textContent = "Enable";
  }
}

$("#push-toggle").addEventListener("click", async () => {
  $("#push-toggle").disabled = true;
  const sub = await currentSubscription();
  if (sub) await disablePush();
  else await enablePush();
});

$("#push-test").addEventListener("click", async () => {
  if (!state.me) return;
  await api.send("POST", "/api/notify/test", { person: state.me });
});

// Pre-register the SW so the subscription flow is instant when the user opts in.
if (PUSH_SUPPORTED) navigator.serviceWorker.register("/sw.js").catch(() => {});

state.me = getMe();
loadAll().then(() => { if (!state.me) openWhoami(); });
