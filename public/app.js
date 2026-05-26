const COLUMNS = [
  { status: "backlog", title: "Backlog" },
  { status: "todo", title: "To Do" },
  { status: "in_progress", title: "In Progress" },
  { status: "done", title: "Done" },
];

const state = {
  tasks: [],
  categories: [],
  settings: { person1: "Person 1", person2: "Person 2" },
  filter: { owner: "all", category: "all" },
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
  syncOwnerLabels();
  renderCategoryFilter();
  renderBoard();
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
  const tasks = visibleTasks();
  for (const col of COLUMNS) {
    const colTasks = tasks
      .filter((t) => t.status === col.status)
      .sort((a, b) => a.position - b.position);

    const el = document.createElement("section");
    el.className = "column";
    el.innerHTML = `
      <div class="column-head"><span>${col.title}</span><span class="count">${colTasks.length}</span></div>
      <div class="column-body" data-status="${col.status}"></div>`;
    const body = el.querySelector(".column-body");

    body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("drag-over"); });
    body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
    body.addEventListener("drop", (e) => { e.preventDefault(); body.classList.remove("drag-over"); onDrop(e, col.status, body); });

    colTasks.forEach((t) => body.appendChild(cardEl(t)));
    board.appendChild(el);
  }
}

function cardEl(t) {
  const cat = categoryById(t.category_id);
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
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
      <span class="tag owner ${t.owner === "unassigned" ? "unassigned" : ""}">${escapeHtml(ownerName(t.owner))}</span>
      ${due}
    </div>`;

  card.addEventListener("click", () => openTaskDialog(t));
  card.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    e.dataTransfer.setData("text/plain", String(t.id));
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
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
  $("#task-dialog").close();
  await loadAll();
});

$("#task-delete").addEventListener("click", async () => {
  const id = $("#task-id").value;
  if (id && confirm("Delete this task?")) {
    await api.send("DELETE", `/api/tasks/${id}`);
    $("#task-dialog").close();
    await loadAll();
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
  await api.send("PUT", "/api/settings", { person1: $("#set-p1").value, person2: $("#set-p2").value });
  $("#settings-dialog").close();
  await loadAll();
});

// ---------- Wiring ----------
$("#btn-add").addEventListener("click", () => openTaskDialog(null));
$("#btn-categories").addEventListener("click", () => { renderCategoryList(); $("#cat-dialog").showModal(); });
$("#btn-settings").addEventListener("click", () => {
  $("#set-p1").value = state.settings.person1;
  $("#set-p2").value = state.settings.person2;
  $("#settings-dialog").showModal();
});
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

loadAll();
