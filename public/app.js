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
};

const $ = (sel) => document.querySelector(sel);
const api = {
  async get(url) { return (await fetch(url)).json(); },
  async send(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  },
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
async function loadAll() {
  const [tasks, categories, settings] = await Promise.all([
    api.get("/api/tasks"),
    api.get("/api/categories"),
    api.get("/api/settings"),
  ]);
  state.tasks = tasks;
  state.categories = categories;
  state.settings = settings;
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

function renderBoard() {
  const board = $("#board");
  board.innerHTML = "";
  board.classList.toggle("with-archived", state.showArchived);
  const tasks = visibleTasks();
  const active = tasks.filter((t) => !t.archived);

  for (const col of COLUMNS) {
    const colTasks = active
      .filter((t) => t.status === col.status)
      .sort((a, b) => a.position - b.position);

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
  await api.send("POST", "/api/tasks/reorder", { status, orderedIds });
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

function openTaskDialog(task) {
  const isEdit = !!task;
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
  openChat(isEdit ? task.id : null);
  $("#task-dialog").showModal();
}

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
  };
  if (id) await api.send("PUT", `/api/tasks/${id}`, payload);
  else await api.send("POST", "/api/tasks", payload);
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

// ---------- Per-task chat ----------
async function openChat(taskId) {
  const section = $("#task-chat");
  if (!taskId) { section.hidden = true; return; }
  section.hidden = false;
  $("#chat-input").value = "";
  await renderChat(taskId);
  if (state.me) await api.send("POST", `/api/tasks/${taskId}/read`, { person: state.me });
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
        return `<div class="msg ${mine ? "mine" : "theirs"}">
          <div class="msg-meta">${escapeHtml(ownerName(m.sender))} · ${fmtDateTime(m.created_at)}</div>
          <div class="msg-body">${escapeHtml(m.body)}</div>
        </div>`;
      })
      .join("");
  }
  box.scrollTop = box.scrollHeight;
}

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
function openInbox() {
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
      if (task) openTaskDialog(task);
    })
  );
  $("#inbox-dialog").showModal();
}
$("#btn-inbox").addEventListener("click", openInbox);

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
function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtDateTime(s) {
  // SQLite stores UTC ("YYYY-MM-DD HH:MM:SS"); parse as UTC then show local.
  const d = new Date(s.replace(" ", "T") + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

state.me = getMe();
loadAll().then(() => { if (!state.me) openWhoami(); });
