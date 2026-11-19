// Ops desk front end. No framework, no innerHTML: every piece of user text goes through textContent.

const LOCALE = "en-GB";
const fmtDay = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "short" });
const fmtDayTime = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtTime = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
const fmtMoney = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

const KIND_LABEL = { repair: "Repair", purchase: "Purchase", task: "Task" };
const STATUS_LABEL = { pending: "Awaiting approval", approved: "Approved", rejected: "Rejected", done: "Done" };
const ROLE_LABEL = { staff: "Staff", manager: "Manager", owner: "Owner", system: "System" };
const ACTION_LABEL = {
  "request.created": "Filed",
  "request.approved": "Approved",
  "request.rejected": "Rejected",
  "checklist.ticked": "Ticked",
  "checklist.unticked": "Unticked",
  "request.completed": "Marked done",
  "sandbox.seeded": "Demo data loaded",
};
const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "pending", label: "Awaiting approval", test: (r) => r.status === "pending" },
  { id: "open", label: "Open", test: (r) => r.status === "approved" },
  { id: "overdue", label: "Overdue", test: (r) => r.overdue },
  { id: "done", label: "Done", test: (r) => r.status === "done" },
  { id: "rejected", label: "Rejected", test: (r) => r.status === "rejected" },
];
const NAV = [
  { id: "requests", href: "#/requests", label: "Requests", roles: ["staff", "manager", "owner"], icon: "list" },
  { id: "new", href: "#/new", label: "New request", roles: ["staff", "manager"], icon: "plus" },
  { id: "dashboard", href: "#/dashboard", label: "Dashboard", roles: ["manager", "owner"], icon: "chart" },
  { id: "log", href: "#/log", label: "Audit log", roles: ["manager", "owner"], icon: "log" },
  { id: "alerts", href: "#/alerts", label: "Alerts", roles: ["staff", "manager", "owner"], icon: "bell" },
];
const ICONS = {
  list: ["M4 6h16", "M4 12h16", "M4 18h10"],
  plus: ["M12 5v14", "M5 12h14"],
  chart: ["M5 19V11", "M10 19V5", "M15 19v-6", "M20 19V9"],
  log: ["M6 4h12v16H6z", "M9 9h6", "M9 13h6", "M9 17h3"],
  bell: ["M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z", "M10 20.5h4"],
};

const $ = (id) => document.getElementById(id);
const main = $("main");
let session = null;
let renderToken = 0;
let lastHash = null;
let freshStamp = null;
let firstRender = true; // ref whose stamp was just applied, for the one stamp animation

// ---------- tiny DOM helper ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "value") el.value = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v === "boolean") el.toggleAttribute(k, v);
      else el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function icon(name) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of ICONS[name]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

// ---------- API ----------

class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error?.code === "no_sandbox" && path !== "/session") {
    await startSession();
    toast("Your sandbox expired, so a fresh one was created.");
    location.hash = "#/requests";
    throw new ApiError(401, "no_sandbox", data.error.message);
  }
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? "error", data.error?.message ?? "The request failed. Try again.", data.error?.field);
  return data;
}

const tz = () => new Date().getTimezoneOffset();

// ---------- formatting ----------

function relDue(r, now) {
  const diff = r.dueAt - now;
  const days = Math.round(Math.abs(diff) / 86_400_000);
  const hours = Math.round(Math.abs(diff) / 3_600_000);
  if (r.overdue) return days >= 1 ? `Overdue by ${days} ${days === 1 ? "day" : "days"}` : `Overdue by ${Math.max(hours, 1)} h`;
  if (r.status === "done") return r.completedAt ? `Done ${fmtDay.format(r.completedAt)}` : "Done";
  if (r.status === "rejected") return r.decidedAt ? `Rejected ${fmtDay.format(r.decidedAt)}` : "Rejected";
  if (hours < 24) return `Due in ${Math.max(hours, 1)} h`;
  return `Due ${fmtDay.format(r.dueAt)}`;
}

function dueFact(r, now) {
  const day = fmtDay.format(r.dueAt);
  if (r.overdue) return `${day} (${relDue(r, now).toLowerCase()})`;
  const hours = (r.dueAt - now) / 3_600_000;
  if ((r.status === "pending" || r.status === "approved") && hours < 24) return `${day} (in ${Math.max(Math.round(hours), 1)} h)`;
  return day;
}

function duration(ms) {
  if (ms === null || ms === undefined) return "No decisions yet";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "Under 1 h";
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function money(cents) {
  return cents === null || cents === undefined ? null : fmtMoney.format(cents / 100);
}

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function personRole(name, role) {
  return role && role !== "system" ? `${name}, ${ROLE_LABEL[role].toLowerCase()}` : name;
}

// ---------- chrome: header, role switcher, nav, demo strip ----------

function renderChrome() {
  $("workspace").textContent = session.mode === "demo" ? `${session.workspace} (demo data)` : session.workspace;
  const who = $("who");
  if (session.mode === "demo") {
    const fs = h("fieldset", { class: "roles" }, h("legend", { class: "visually-hidden" }, "Viewing as"));
    for (const role of ["staff", "manager", "owner"]) {
      const id = `role-${role}`;
      fs.append(
        h(
          "div",
          { class: "role-opt" },
          h("input", { type: "radio", name: "role", id, value: role, checked: session.role === role, onchange: () => switchRole(role) }),
          h("label", { for: id }, h("b", {}, ROLE_LABEL[role]), h("span", {}, session.personas[role])),
        ),
      );
    }
    who.replaceChildren(h("span", { class: "who-label", "aria-hidden": "true" }, "Viewing as"), fs);
  } else {
    who.replaceChildren(h("p", { class: "signed-in" }, `Signed in as ${session.actor} (${ROLE_LABEL[session.role].toLowerCase()})`));
  }

  const strip = $("demo-strip");
  if (session.mode === "demo" && session.sandbox) {
    strip.hidden = false;
    strip.replaceChildren(
      h(
        "p",
        {},
        `Public demo. This is your private sandbox (${session.sandbox.tag}) with generic demo data. Nobody else can see it, and it is deleted ${session.sandbox.ttlHours} h after it was created (${fmtDayTime.format(session.sandbox.expiresAt)}).`,
      ),
      h("button", { type: "button", class: "btn small", id: "reset", onclick: resetSandbox }, "Reset sandbox"),
    );
  } else {
    strip.hidden = true;
  }
  renderNav();
}

function renderNav() {
  const view = parseHash().view;
  const ul = h("ul");
  for (const item of NAV) {
    if (!item.roles.includes(session.role)) continue;
    const current = item.id === view || (item.id === "requests" && view === "request");
    const badge =
      item.id === "alerts" && session.unread > 0
        ? h("span", { class: "badge" }, String(session.unread), h("span", { class: "visually-hidden" }, " unread"))
        : null;
    ul.append(
      h(
        "li",
        {},
        h("a", { href: item.href, "aria-current": current ? "page" : null, "data-nav": item.id }, icon(item.icon), h("span", {}, item.label), badge),
      ),
    );
  }
  $("nav").replaceChildren(ul);
}

async function switchRole(role) {
  try {
    session = await api("/role", { method: "POST", body: { role } });
    renderChrome();
    toast(`Now viewing as ${session.actor}, ${ROLE_LABEL[role].toLowerCase()}.`);
    await render({ keepFocus: true });
  } catch (err) {
    toast(err.message);
  }
}

async function resetSandbox() {
  if (!window.confirm("Reset the sandbox? Everything you changed is deleted and the demo data starts over.")) return;
  try {
    session = await api("/sandbox/reset", { method: "POST", body: {} });
    renderChrome();
    toast("Fresh sandbox ready.");
    if (location.hash === "#/requests") await render();
    else location.hash = "#/requests";
  } catch (err) {
    toast(err.message);
  }
}

async function refreshUnread() {
  try {
    const s = await api("/session");
    session = s;
    renderNav();
  } catch {
    /* keep the old badge */
  }
}

// ---------- routing ----------

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "r" && parts[1]) return { view: "request", ref: Number(parts[1]), filter: params.get("f") ?? "all" };
  const view = ["requests", "new", "dashboard", "log", "alerts"].includes(parts[0]) ? parts[0] : "requests";
  return { view, filter: params.get("f") ?? "all" };
}

const VIEWS = {
  requests: (r) => viewRequests(r.filter, null),
  request: (r) => viewRequests(r.filter, r.ref),
  new: () => viewNew(),
  dashboard: () => viewDashboard(),
  log: () => viewLog(),
  alerts: () => viewAlerts(),
};

async function render({ keepFocus = false } = {}) {
  const route = parseHash();
  const nav = NAV.find((n) => n.id === route.view);
  if (nav && !nav.roles.includes(session.role)) {
    location.replace("#/requests");
    return;
  }
  renderNav();
  const token = ++renderToken;
  // The first render leaves focus at the top of the page; later route changes move it to the new heading.
  const hashChanged = lastHash !== location.hash && !firstRender;
  firstRender = false;
  lastHash = location.hash;
  const focusId = keepFocus || !hashChanged ? document.activeElement?.id : null;
  let node;
  try {
    node = await VIEWS[route.view](route);
  } catch (err) {
    if (err instanceof ApiError && err.code === "no_sandbox") return;
    node = errorView(err);
  }
  if (token !== renderToken) return;
  main.replaceChildren(node);
  const keep = focusId ? document.getElementById(focusId) : null;
  if (keep) keep.focus();
  else if (hashChanged) (main.querySelector("h1") ?? main).focus();
}

function errorView(err) {
  return h(
    "section",
    { class: "empty", role: "alert" },
    h("h1", { tabindex: "-1" }, err.status === 404 ? "Not found" : "Something went wrong"),
    h("p", {}, err.message),
    h("button", { type: "button", class: "btn", onclick: () => render() }, "Try again"),
  );
}

// ---------- requests list + detail ----------

async function viewRequests(filterId, ref) {
  const [list, detail] = await Promise.all([api("/requests"), ref ? api(`/requests/${ref}`).catch((e) => e) : null]);
  const { requests, now } = list;
  const filter = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];
  const shown = requests.filter(filter.test);

  const filters = h(
    "nav",
    { class: "filters", "aria-label": "Filter requests" },
    FILTERS.map((f) => {
      const n = requests.filter(f.test).length;
      return h("a", { href: `#/requests?f=${f.id}`, "aria-current": f.id === filter.id ? "true" : null }, `${f.label} (${n})`);
    }),
  );

  const listItems = shown.length
    ? h("ul", { class: "tickets", "aria-label": `${filter.label} requests` }, shown.map((r) => h("li", {}, ticketCard(r, now, filter.id, ref))))
    : h(
        "div",
        { class: "empty" },
        h("p", {}, filter.id === "all" ? "No requests yet." : `Nothing in “${filter.label}” right now.`),
        ["staff", "manager"].includes(session.role) ? h("a", { class: "btn", href: "#/new" }, "File a request") : null,
      );

  const listPane = h(
    "section",
    { class: "list-pane", "aria-labelledby": "list-h" },
    h(
      "div",
      { class: "view-head" },
      h("div", {}, ref ? h("h2", { id: "list-h" }, "Requests") : h("h1", { id: "list-h", tabindex: "-1" }, "Requests"), h("p", {}, introFor(session.role))),
    ),
    filters,
    listItems,
  );

  let detailPane = h("section", { class: "detail-pane", "aria-label": "Request details" });
  if (detail instanceof Error) {
    detailPane.append(errorView(detail));
  } else if (detail) {
    detailPane.append(detailSheet(detail, filter.id));
  } else {
    detailPane.append(
      h(
        "div",
        { class: "detail-empty" },
        h("h2", {}, "How a request moves"),
        h(
          "ol",
          { class: "steps" },
          h("li", {}, h("b", {}, "Staff"), " file it with a checklist."),
          h("li", {}, h("b", {}, "A manager"), " approves it, or rejects it with a note."),
          h("li", {}, h("b", {}, "Staff"), " tick every step and finish with a proof photo."),
          h("li", {}, h("b", {}, "The owner"), " sees it on the dashboard; every step is in the audit log."),
        ),
        h("p", {}, "Pick a request on the left to open it."),
      ),
    );
  }
  return h("div", { class: `split${ref ? " has-detail" : ""}` }, listPane, detailPane);
}

function introFor(role) {
  if (role === "staff") return "File repairs, purchases and tasks. Once approved, tick the checklist and add a proof photo.";
  if (role === "manager") return "Approve or reject what staff file. Anything awaiting approval is at the top.";
  return "Everything on the desk. Approve or reject, or open the dashboard for the week.";
}

function ticketCard(r, now, filterId, selectedRef) {
  const q = filterId && filterId !== "all" ? `?f=${filterId}` : "";
  return h(
    "a",
    { class: `ticket kind-${r.kind}`, href: `#/r/${r.ref}${q}`, "aria-current": r.ref === selectedRef ? "page" : null, "data-ref": r.ref },
    h("span", { class: "ticket-top" }, h("span", { class: "ref" }, `R-${r.ref}`), h("span", { class: "tag" }, KIND_LABEL[r.kind]), h("span", { class: `status status-${r.status}` }, STATUS_LABEL[r.status])),
    h("span", { class: "ticket-title" }, r.title),
    h(
      "span",
      { class: "ticket-meta" },
      h("span", { class: r.overdue ? "late" : null }, relDue(r, now)),
      r.location ? h("span", {}, r.location) : null,
      typeof r.checklistTotal === "number" ? h("span", {}, `${r.checklistDone}/${r.checklistTotal} ticked`) : null,
    ),
  );
}

function stampFor(r) {
  if (r.status === "pending") return null;
  const who = r.status === "done" ? r.completedBy : r.decidedBy;
  const at = r.status === "done" ? r.completedAt : r.decidedAt;
  const fresh = freshStamp === r.ref;
  if (fresh) freshStamp = null;
  return h(
    "div",
    { class: `stamp stamp-${r.status}${fresh ? " fresh" : ""}`, "data-testid": "stamp" },
    h("b", {}, STATUS_LABEL[r.status]),
    h("small", {}, `${who}, ${fmtDay.format(at)}`),
  );
}

function detailSheet(d, filterId) {
  const r = d.request;
  const now = Date.now();
  const back = h("a", { class: "back", href: `#/requests${filterId && filterId !== "all" ? `?f=${filterId}` : ""}` }, "All requests");
  const facts = h(
    "dl",
    { class: "facts" },
    r.location ? [h("dt", {}, "Where"), h("dd", {}, r.location)] : null,
    r.costCents !== null ? [h("dt", {}, "Estimated cost"), h("dd", {}, money(r.costCents))] : null,
    h("dt", {}, "Due"),
    h("dd", { class: r.overdue ? "late" : null }, dueFact(r, now)),
    h("dt", {}, "Filed by"),
    h("dd", {}, `${r.createdBy}, ${fmtDayTime.format(r.createdAt)}`),
  );

  const note =
    r.decidedBy && (r.decisionNote || r.status === "rejected")
      ? h(
          "div",
          { class: `note stamp-${r.status === "done" ? "approved" : r.status}` },
          h("p", {}, h("b", {}, `Note from ${r.decidedBy}`)),
          h("p", { class: "details" }, r.decisionNote || "No note."),
        )
      : null;

  const sheet = h(
    "article",
    { class: `sheet kind-${r.kind}`, "aria-labelledby": "sheet-h" },
    h(
      "div",
      { class: "sheet-stub" },
      h("p", { class: "sheet-ref" }, `R-${r.ref}`),
      h(
        "p",
        { class: "ticket-top" },
        h("span", { class: "tag" }, KIND_LABEL[r.kind]),
        h("span", { class: `status status-${r.status}`, "data-testid": "status" }, STATUS_LABEL[r.status]),
        r.overdue ? h("span", { class: "late" }, "Overdue") : null,
      ),
      h("h1", { class: "sheet-title", id: "sheet-h", tabindex: "-1" }, r.title),
    ),
    stampFor(r),
    h("div", { class: "sheet-body" }, r.details ? h("p", { class: "details" }, r.details) : h("p", { class: "muted" }, "No details given."), facts, note),
  );

  return h("div", {}, back, sheet, decisionPanel(r), checklistPanel(d), proofPanel(r), trailPanel(d.trail));
}

function decisionPanel(r) {
  if (r.status !== "pending") return null;
  if (!["manager", "owner"].includes(session.role)) {
    return h("section", { class: "panel" }, h("h2", {}, "Waiting for a decision"), h("p", { class: "muted" }, "A manager or the owner approves or rejects this. You will get an alert either way."));
  }
  const max = session.limits.note;
  const err = h("p", { class: "field-error", id: "note-error", role: "alert" });
  const count = h("p", { class: "count", id: "note-count", "aria-live": "polite" }, `0/${max}`);
  const ta = h("textarea", {
    class: "input",
    id: "note",
    name: "note",
    rows: "3",
    maxlength: String(max),
    "aria-describedby": "note-hint note-count",
    oninput: () => (count.textContent = `${ta.value.length}/${max}`),
  });
  const submit = async (decision, button) => {
    err.textContent = "";
    ta.removeAttribute("aria-invalid");
    if (decision === "reject" && ta.value.trim().length < 3) {
      err.textContent = "Add a note so staff know why it was rejected.";
      ta.setAttribute("aria-invalid", "true");
      ta.focus();
      return;
    }
    button.disabled = true;
    try {
      await api(`/requests/${r.ref}/decision`, { method: "POST", body: { decision, note: ta.value } });
      freshStamp = r.ref;
      toast(decision === "approve" ? `Approved R-${r.ref}.` : `Rejected R-${r.ref}.`);
      await render();
      main.querySelector("#sheet-h")?.focus();
    } catch (e) {
      err.textContent = e.message;
      button.disabled = false;
    }
  };
  const approve = h("button", { type: "button", class: "btn approve", id: "approve", onclick: () => submit("approve", approve) }, "Approve");
  const reject = h("button", { type: "button", class: "btn reject", id: "reject", onclick: () => submit("reject", reject) }, "Reject");
  return h(
    "section",
    { class: "panel", "aria-labelledby": "decide-h" },
    h("h2", { id: "decide-h" }, "Decision"),
    h(
      "div",
      { class: "field" },
      h("label", { for: "note" }, "Note for staff"),
      ta,
      h("div", { class: "field-foot" }, h("p", { class: "hint", id: "note-hint" }, "Optional when approving. Required when rejecting."), count),
      err,
    ),
    h("div", { class: "actions" }, approve, reject),
  );
}

function checklistPanel(d) {
  const r = d.request;
  const canTick = session.role === "staff" && r.status === "approved";
  let hint = null;
  if (r.status === "pending") hint = "The checklist opens once a manager approves this request.";
  else if (r.status === "approved" && session.role !== "staff") hint = "Staff tick these off as they work.";
  else if (r.status === "rejected") hint = "This request was rejected, so the checklist is closed.";

  const items = d.checklist.map((item) => {
    const id = `chk-${item.pos}`;
    const box = h("input", {
      type: "checkbox",
      id,
      checked: item.doneAt !== null,
      disabled: !canTick,
      onchange: async () => {
        box.disabled = true;
        try {
          await api(`/requests/${r.ref}/checklist/${item.pos}`, { method: "POST", body: { done: box.checked } });
          await render({ keepFocus: true });
        } catch (e) {
          box.checked = !box.checked;
          box.disabled = false;
          toast(e.message);
        }
      },
    });
    return h(
      "li",
      { class: `check${item.doneAt !== null ? " is-done" : ""}` },
      box,
      h("label", { for: id }, h("span", {}, item.label), item.doneAt !== null ? h("span", { class: "by" }, `${item.doneBy}, ${fmtDayTime.format(item.doneAt)}`) : null),
    );
  });
  const done = d.checklist.filter((i) => i.doneAt !== null).length;
  return h(
    "section",
    { class: "panel", "aria-labelledby": "check-h" },
    h("h2", { id: "check-h" }, `Checklist (${done} of ${d.checklist.length})`),
    hint ? h("p", { class: "hint", id: "check-hint" }, hint) : null,
    h("ul", { class: "checklist" }, items),
  );
}

function proofPanel(r) {
  if (r.status === "done") {
    return h(
      "section",
      { class: "panel", "aria-labelledby": "proof-h" },
      h("h2", { id: "proof-h" }, "Proof"),
      h(
        "figure",
        { class: "proof" },
        h("img", { src: `/photos/${r.proofPhoto}.svg`, alt: `Sample photo: ${session.photos[r.proofPhoto]}`, width: "400", height: "300" }),
        h("figcaption", {}, `${session.photos[r.proofPhoto]}. Added by ${r.completedBy}, ${fmtDayTime.format(r.completedAt)}.`),
      ),
    );
  }
  if (r.status !== "approved" || session.role !== "staff") return null;

  const allTicked = r.checklistDone === r.checklistTotal;
  const hint = h("p", { class: "hint", id: "done-hint" });
  const err = h("p", { class: "field-error", role: "alert" });
  const button = h("button", { type: "button", class: "btn primary", id: "mark-done" }, "Mark done");
  const update = () => {
    const picked = form.querySelector('input[name="photo"]:checked');
    button.disabled = !allTicked || !picked;
    hint.textContent = !allTicked
      ? `Tick all ${r.checklistTotal} checklist items first (${r.checklistDone} done).`
      : !picked
        ? "Pick a proof photo to finish."
        : "Ready to mark done.";
  };
  const form = h(
    "fieldset",
    { class: "photos" },
    h("legend", {}, "Proof photo"),
    Object.entries(session.photos).map(([id, caption]) =>
      h(
        "div",
        { class: "photo-opt" },
        h("input", { type: "radio", name: "photo", id: `photo-${id}`, value: id, onchange: update }),
        h("label", { for: `photo-${id}` }, h("img", { src: `/photos/${id}.svg`, alt: "", width: "400", height: "300", loading: "lazy" }), h("span", {}, caption)),
      ),
    ),
  );
  button.addEventListener("click", async () => {
    const picked = form.querySelector('input[name="photo"]:checked');
    if (!picked) return;
    button.disabled = true;
    try {
      await api(`/requests/${r.ref}/complete`, { method: "POST", body: { photo: picked.value } });
      freshStamp = r.ref;
      toast(`R-${r.ref} marked done.`);
      await render();
      main.querySelector("#sheet-h")?.focus();
    } catch (e) {
      err.textContent = e.message;
      button.disabled = false;
    }
  });
  update();
  button.setAttribute("aria-describedby", "done-hint");
  return h(
    "section",
    { class: "panel", "aria-labelledby": "finish-h" },
    h("h2", { id: "finish-h" }, "Finish with photo proof"),
    h("p", { class: "hint" }, session.mode === "demo" ? "Uploads are switched off in the public demo. Pick one of the six sample photos." : "Pick the photo that shows the finished work."),
    form,
    h("div", { class: "actions" }, button),
    hint,
    err,
  );
}

function trailPanel(trail) {
  if (!trail?.length) return null;
  return h(
    "section",
    { class: "panel", "aria-labelledby": "trail-h" },
    h("h2", { id: "trail-h" }, "History"),
    h(
      "ol",
      { class: "trail" },
      trail.map((e) =>
        h("li", {}, h("time", { datetime: new Date(e.at).toISOString() }, fmtDayTime.format(e.at)), h("span", { class: "what" }, h("b", {}, personRole(e.actor, e.role)), ` ${e.detail}`)),
      ),
    ),
  );
}

// ---------- new request ----------

function viewNew() {
  const L = session.limits;
  const errors = h("div", { id: "form-errors" });
  const fieldErr = (id) => h("p", { class: "field-error", id: `${id}-error` });
  const counter = (input, max) => {
    const c = h("p", { class: "count", id: `${input.id}-count` }, `0/${max}`);
    input.addEventListener("input", () => (c.textContent = `${input.value.length}/${max}`));
    input.setAttribute("aria-describedby", `${input.id}-count`);
    return c;
  };

  const kinds = h(
    "fieldset",
    { class: "kinds" },
    h("legend", {}, "Type"),
    ["repair", "purchase", "task"].map((k) =>
      h(
        "div",
        { class: `kind-opt kind-${k}` },
        h("input", { type: "radio", name: "kind", id: `kind-${k}`, value: k, checked: k === "repair", onchange: () => (costField.hidden = k === "task") }),
        h("label", { for: `kind-${k}` }, KIND_LABEL[k]),
      ),
    ),
  );
  const title = h("input", { class: "input", id: "title", name: "title", maxlength: String(L.title), required: true, autocomplete: "off" });
  const details = h("textarea", { class: "input", id: "details", name: "details", maxlength: String(L.details), rows: "4" });
  const location_ = h("input", { class: "input", id: "location", name: "location", maxlength: String(L.location), autocomplete: "off" });
  const cost = h("input", { class: "input", id: "cost", name: "cost", inputmode: "decimal", autocomplete: "off", placeholder: "0.00" });
  const due = h("input", { class: "input", id: "dueDate", name: "dueDate", type: "date", min: today(0), value: today(2), required: true });
  const costField = h("div", { class: "field" }, h("label", { for: "cost" }, "Estimated cost in euros ", h("span", { class: "opt" }, "(optional)")), cost, fieldErr("cost"));

  const items = h("ol", { class: "items", id: "items" });
  const addBtn = h("button", { type: "button", class: "btn small", id: "add-item" }, "Add item");
  const itemsHint = h("p", { class: "hint", id: "items-hint" });
  const renumber = () => {
    const rows = [...items.children];
    rows.forEach((row, i) => {
      row.querySelector(".num").textContent = `${i + 1}.`;
      const input = row.querySelector("input");
      input.id = `item-${i + 1}`;
      input.setAttribute("aria-label", `Checklist item ${i + 1}`);
      row.querySelector("button").setAttribute("aria-label", `Remove item ${i + 1}`);
      row.querySelector("button").disabled = rows.length === 1;
    });
    addBtn.disabled = rows.length >= L.checklistItems;
    itemsHint.textContent = rows.length >= L.checklistItems ? `That is the maximum of ${L.checklistItems} items.` : `Up to ${L.checklistItems} items, ${L.checklistLabel} characters each.`;
  };
  const addItem = (value = "") => {
    const input = h("input", { class: "input", maxlength: String(L.checklistLabel), value, autocomplete: "off" });
    const row = h(
      "li",
      { class: "item-row" },
      h("span", { class: "num", "aria-hidden": "true" }),
      input,
      h("button", {
        type: "button",
        class: "btn small",
        onclick: () => {
          const next = row.nextElementSibling ?? row.previousElementSibling;
          row.remove();
          renumber();
          next?.querySelector("input")?.focus();
        },
      }, "Remove"),
    );
    items.append(row);
    renumber();
    return input;
  };
  addBtn.addEventListener("click", () => addItem().focus());
  addItem();

  const submitBtn = h("button", { type: "submit", class: "btn primary", id: "file" }, "File request");
  const form = h(
    "form",
    { class: "form", novalidate: true, "aria-labelledby": "new-h" },
    errors,
    kinds,
    h("div", { class: "field" }, h("label", { for: "title" }, "What needs doing?"), title, h("div", { class: "field-foot" }, h("span"), counter(title, L.title)), fieldErr("title")),
    h("div", { class: "field" }, h("label", { for: "details" }, "Details ", h("span", { class: "opt" }, "(optional)")), details, h("div", { class: "field-foot" }, h("span"), counter(details, L.details)), fieldErr("details")),
    h("div", { class: "field" }, h("label", { for: "location" }, "Where ", h("span", { class: "opt" }, "(optional)")), location_, fieldErr("location")),
    costField,
    h("div", { class: "field" }, h("label", { for: "dueDate" }, "Due date"), due, fieldErr("dueDate")),
    h("div", { class: "field" }, h("span", { class: "label", id: "items-label" }, "Checklist"), h("p", { class: "hint" }, "The steps staff tick off before marking it done."), items, itemsHint, h("div", { class: "actions" }, addBtn), fieldErr("checklist")),
    h("div", { class: "actions" }, submitBtn),
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errors.replaceChildren();
    for (const el of form.querySelectorAll(".field-error")) el.textContent = "";
    for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    const kind = form.querySelector('input[name="kind"]:checked').value;
    const body = {
      kind,
      title: title.value,
      details: details.value,
      location: location_.value,
      cost: kind === "task" ? "" : cost.value,
      dueDate: due.value,
      checklist: [...items.querySelectorAll("input")].map((i) => i.value),
      tz: tz(),
    };
    if (!body.title.trim()) return showFieldError("title", "Title is required.");
    if (!body.checklist.some((s) => s.trim())) return showFieldError("checklist", "Add at least one checklist item.", items.querySelector("input"));
    submitBtn.disabled = true;
    try {
      const { ref } = await api("/requests", { method: "POST", body });
      toast(`Filed R-${ref}. It is waiting for approval.`);
      location.hash = `#/r/${ref}`;
    } catch (err) {
      submitBtn.disabled = false;
      if (err.field) showFieldError(err.field, err.message, err.field === "checklist" ? items.querySelector("input") : null);
      else errors.replaceChildren(h("p", { class: "form-error", role: "alert" }, err.message));
    }
  });

  function showFieldError(field, message, focusEl) {
    const slot = form.querySelector(`#${field}-error`);
    if (slot) slot.textContent = message;
    const input = focusEl ?? form.querySelector(`#${field}`);
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", [input.getAttribute("aria-describedby"), `${field}-error`].filter(Boolean).join(" "));
      input.focus();
    }
    if (!slot) errors.replaceChildren(h("p", { class: "form-error", role: "alert" }, message));
  }

  return h(
    "section",
    {},
    h("div", { class: "view-head" }, h("div", {}, h("h1", { id: "new-h", tabindex: "-1" }, "New request"), h("p", {}, "A manager approves it before work starts."))),
    form,
  );
}

// ---------- dashboard ----------

async function viewDashboard() {
  const d = await api(`/dashboard?tz=${tz()}`);
  const c = d.counts;
  const figure = (n, label, href, alarm = false) =>
    h("a", { class: `figure${alarm && n > 0 ? " alarm" : ""}`, href, "data-figure": label }, h("span", { class: "figure-n" }, String(n)), h("span", { class: "figure-l" }, label));
  const maxKind = Math.max(1, ...Object.values(d.openByKind));
  const bars = h(
    "div",
    { class: "bars" },
    ["repair", "purchase", "task"].map((k) => {
      const fill = h("div", { class: "bar-fill" });
      fill.style.width = `${(d.openByKind[k] / maxKind) * 100}%`;
      return h("div", { class: `bar-row kind-${k}` }, h("span", {}, KIND_LABEL[k]), h("div", { class: "bar-track", role: "presentation" }, fill), h("span", { class: "n" }, String(d.openByKind[k])));
    }),
  );
  const overdue = d.overdue.length
    ? h("ul", { class: "overdue-list" }, d.overdue.map((r) => h("li", {}, ticketCard({ ...r, overdue: true }, d.now, "overdue"))))
    : h("p", { class: "empty" }, "Nothing is overdue.");

  const exports =
    session.role === "owner"
      ? h(
          "section",
          { class: "section", "aria-labelledby": "export-h" },
          h("h2", { id: "export-h" }, "Export"),
          h("p", { class: "muted" }, "CSV files open in Excel, Numbers or Google Sheets."),
          h(
            "div",
            { class: "actions" },
            h("a", { class: "btn", href: "/api/export/requests.csv", download: "", id: "export-requests" }, "Download requests (CSV)"),
            h("a", { class: "btn", href: "/api/export/audit.csv", download: "", id: "export-audit" }, "Download audit log (CSV)"),
          ),
        )
      : null;

  return h(
    "section",
    {},
    h("div", { class: "view-head" }, h("div", {}, h("h1", { tabindex: "-1" }, `This week at ${session.workspace}`), h("p", {}, `Week starting ${fmtDay.format(d.weekStart)}.`))),
    h(
      "div",
      { class: "figures" },
      figure(c.awaitingApproval, "Awaiting approval", "#/requests?f=pending"),
      figure(c.open, "Open", "#/requests?f=open"),
      figure(c.doneThisWeek, "Done this week", "#/requests?f=done"),
      figure(c.overdue, "Overdue", "#/requests?f=overdue", true),
    ),
    h(
      "div",
      { class: "cols section" },
      h("section", { "aria-labelledby": "overdue-h" }, h("h2", { id: "overdue-h" }, "Overdue"), overdue),
      h(
        "div",
        {},
        h("section", { "aria-labelledby": "kind-h" }, h("h2", { id: "kind-h" }, "Open and awaiting, by type"), bars),
        h(
          "section",
          { class: "section", "aria-labelledby": "median-h" },
          h("h2", { id: "median-h" }, "Typical time to a decision"),
          h("p", {}, h("span", { class: "figure-n" }, duration(d.medianDecisionMs))),
          h("p", { class: "hint" }, "Median from filing to approval or rejection, last 50 decisions."),
        ),
      ),
    ),
    h(
      "section",
      { class: "section", "aria-labelledby": "recent-h" },
      h("h2", { id: "recent-h" }, "Latest activity"),
      logList(d.recent),
      h("p", { class: "hint" }, h("a", { href: "#/log" }, "Open the full audit log")),
    ),
    exports,
  );
}

// ---------- audit log ----------

function logList(entries) {
  return h(
    "ol",
    { class: "log" },
    entries.map((e) =>
      h(
        "li",
        { "data-seq": e.seq },
        h("span", { class: "seq" }, `#${e.seq}`),
        h(
          "div",
          { class: "entry-main" },
          h("span", { class: "entry-what" }, `${ACTION_LABEL[e.action] ?? e.action}${e.ref ? ` R-${e.ref}` : ""}`),
          h("span", { class: "entry-detail" }, e.detail),
          h(
            "span",
            { class: "entry-meta" },
            h("span", {}, personRole(e.actor, e.role)),
            h("time", { datetime: new Date(e.at).toISOString() }, fmtDayTime.format(e.at)),
            e.hash ? h("span", { class: "hash", title: e.hash }, `hash ${e.hash.slice(0, 12)}`) : null,
          ),
        ),
      ),
    ),
  );
}

async function viewLog() {
  const [check, page] = await Promise.all([api("/audit/verify"), api("/audit?limit=50")]);
  const list = logList(page.entries);
  let nextBefore = page.nextBefore;
  const more = h("button", { type: "button", class: "btn", id: "load-older", hidden: !nextBefore }, "Load older entries");
  more.addEventListener("click", async () => {
    more.disabled = true;
    const next = await api(`/audit?limit=50&before=${nextBefore}`);
    for (const li of logList(next.entries).children) list.append(li);
    nextBefore = next.nextBefore;
    more.disabled = false;
    more.hidden = !nextBefore;
  });
  const chain = h(
    "div",
    { class: `chain${check.ok ? "" : " broken"}`, "data-testid": "chain" },
    h(
      "div",
      {},
      h("strong", {}, check.ok ? `Chain intact: ${check.count} entries` : `Chain broken at entry #${check.brokenAt}`),
      check.head ? h("span", { class: "hash" }, `Latest hash ${check.head}`) : null,
    ),
  );
  return h(
    "section",
    {},
    h(
      "div",
      { class: "view-head" },
      h(
        "div",
        {},
        h("h1", { tabindex: "-1" }, "Audit log"),
        h("p", {}, "Every action on the desk, newest first. Entries cannot be edited or deleted, and each one carries the hash of the one before it, so a changed entry breaks the chain."),
      ),
      session.role === "owner" ? h("a", { class: "btn", href: "/api/export/audit.csv", download: "" }, "Download CSV") : null,
    ),
    chain,
    h("div", { class: "section" }, list),
    h("div", { class: "actions" }, more),
  );
}

// ---------- alerts ----------

async function viewAlerts() {
  const data = await api("/alerts");
  session.unread = data.unread;
  renderNav();
  const markBtn = h("button", { type: "button", class: "btn", id: "mark-read", disabled: data.unread === 0 }, "Mark all as read");
  markBtn.addEventListener("click", async () => {
    markBtn.disabled = true;
    try {
      await api("/alerts/read", { method: "POST", body: {} });
    } catch (err) {
      markBtn.disabled = false;
      toast(err.message);
      return;
    }
    await refreshUnread();
    await render({ keepFocus: true });
    toast("All alerts marked as read.");
  });
  const who = { staff: "staff", manager: "managers", owner: "the owner" }[session.role];
  const adapter = data.outbound.adapter;
  return h(
    "section",
    {},
    h(
      "div",
      { class: "view-head" },
      h("div", {}, h("h1", { tabindex: "-1" }, `Alerts for ${who}`), h("p", {}, data.unread ? `${data.unread} unread.` : "You are all caught up.")),
      markBtn,
    ),
    h(
      "div",
      { class: "outbound", "data-testid": "outbound" },
      h("p", {}, h("b", {}, adapter === "stub" ? "Outbound messages are stubbed in this demo." : `Outbound messages go out by ${adapter}.`)),
      h(
        "p",
        { class: "muted" },
        adapter === "stub"
          ? "In production each alert can also go to a Telegram chat or a webhook. Here nothing leaves the desk: open an alert to see the message that would have been sent."
          : "Each alert below shows whether it was delivered.",
      ),
    ),
    data.items.length
      ? h(
          "ul",
          { class: "alerts section" },
          data.items.map((a) =>
            h(
              "li",
              { class: `alert${a.read ? "" : " unread"}` },
              h("p", { class: "alert-text" }, a.ref ? h("a", { href: `#/r/${a.ref}` }, a.text) : a.text),
              h(
                "p",
                { class: "alert-meta" },
                h("span", {}, a.read ? "Read" : "Unread"),
                h("time", { datetime: new Date(a.at).toISOString() }, fmtDayTime.format(a.at)),
                h("span", {}, a.delivery === "stub" ? "Not sent (stub)" : a.delivery.startsWith("sent") ? "Delivered" : "Delivery failed"),
              ),
              h("details", {}, h("summary", {}, adapter === "stub" ? "Message that would be sent" : "Message sent"), h("pre", {}, prettyJson(a.payload))),
            ),
          ),
        )
      : h("p", { class: "empty section" }, "No alerts yet."),
  );
}

function prettyJson(s) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// ---------- toast ----------

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ---------- boot ----------

async function startSession() {
  session = await api("/session");
  renderChrome();
}

async function boot() {
  try {
    await startSession();
  } catch (err) {
    main.replaceChildren(
      h("section", { class: "empty", role: "alert" }, h("h1", {}, err.status === 429 ? "The demo is busy" : "The desk could not open"), h("p", {}, err.message), h("button", { type: "button", class: "btn", onclick: () => location.reload() }, "Try again")),
    );
    return;
  }
  window.addEventListener("hashchange", () => render());
  document.querySelector(".skip").addEventListener("click", (e) => {
    e.preventDefault();
    main.focus();
  });
  await render();
  document.documentElement.dataset.ready = "true";
}

boot();
