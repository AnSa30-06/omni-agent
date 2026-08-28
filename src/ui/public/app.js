// Omni Agent desktop UI.
//
// Two surfaces over one engine:
//   Chat  conversation. Runs the `plan` agent, which reads and searches but
//         does not edit files - so "just asking" cannot change anything.
//   Code  agentic work. Runs `build`, with a mode that decides how much it
//         does before checking with you.
//
// Everything else - routines, transcripts, tools, search, providers, token
// saving, usage, settings, dashboard - is a page in the same window.

const TOKEN = new URL(location.href).searchParams.get("t") ?? "";

/* ── plumbing ──────────────────────────────────────────────────────────── */

async function api(name, { method = "GET", body, query } = {}) {
  const qs = new URLSearchParams({ t: TOKEN, ...(query ?? {}) });
  const r = await fetch(`/x/${name}?${qs}`, {
    method,
    headers: { "content-type": "application/json", "x-omni-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

async function ocall(method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`/oc${path}${sep}t=${encodeURIComponent(TOKEN)}`, {
    method,
    headers: { "content-type": "application/json", "x-omni-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return { status: r.status, ok: r.ok, data: text ? JSON.parse(text) : null };
  } catch {
    return { status: r.status, ok: r.ok, data: text };
  }
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function toast(message, kind = "") {
  const t = el("div", `toast ${kind}`, message);
  $("toasts").append(t);
  setTimeout(() => t.remove(), 5200);
}

function fmtNum(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}
function fmtWhen(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ── state ─────────────────────────────────────────────────────────────── */

const MODES = {
  auto: {
    label: "Auto",
    agent: "build",
    blurb: "Gets on with it. Still stops for anything risky.",
  },
  plan: {
    label: "Plan",
    agent: "plan",
    blurb: "Works out an approach and shows you before doing anything.",
  },
  ask: {
    label: "Ask first",
    agent: "build",
    blurb: "Checks with you before each step that changes something.",
  },
};

const state = {
  surface: "chat", // chat | code
  page: null, // null = the conversation view
  sessionID: null,
  sessions: [],
  mode: "auto",
  model: null, // {providerID, id}
  models: [],
  stream: null,
  busy: false,
  kinds: {}, // sessionID -> "chat"|"code"
  // "providerID/id" -> { code, message, when } for models that have actually
  // failed here. Every model the gateway can serve is offered, because hiding
  // them was worse - but the gateway publishes no per-model health (theoldllm
  // reports active:true and answers 403), so the only honest signal is what
  // has already gone wrong on this machine.
  unhealthy: {},
  // The folder the NEXT conversation will work in. A session's folder is fixed
  // when it is created and cannot be moved afterwards, so an open conversation
  // shows its own folder instead of this one.
  folder: null,
  workspace: null,
  recentFolders: [],
  // The open conversation's own folder. Read from `GET /session/{id}` rather
  // than the sidebar list: the v2 list the sidebar uses carries `location` and
  // `subpath` but no `directory` at all.
  sessionFolder: null,
};

// Preferences live on disk, not in localStorage. The UI server takes a fresh
// port every launch, which makes the page a new browser origin each time, so
// anything kept in browser storage is silently empty on every restart - the
// Chat/Code tag of every conversation and the chosen model included.
async function savePrefs(patch) {
  Object.assign(state, patch.kinds ? {} : patch);
  await api("prefsSet", { method: "POST", body: patch });
}

function agentFor() {
  return state.surface === "chat" ? "plan" : MODES[state.mode].agent;
}

/* ── sessions ──────────────────────────────────────────────────────────── */

async function loadSessions() {
  const r = await ocall("GET", "/api/session");
  state.sessions = r.data?.data ?? r.data ?? [];
  renderSessions();
}

function renderSessions() {
  const box = $("session-list");
  box.replaceChildren();
  const mine = state.sessions.filter((s) => (state.kinds[s.id] ?? "chat") === state.surface);
  $("session-heading").textContent = state.surface === "chat" ? "Conversations" : "Projects";
  if (!mine.length) {
    box.append(el("div", "muted", `No ${state.surface === "chat" ? "conversations" : "coding sessions"} yet.`));
    return;
  }
  for (const s of mine) {
    const row = el("div", "s-row");
    const b = el("button", "s-item" + (s.id === state.sessionID ? " active" : ""));
    b.append(el("span", "s-dot"), el("span", "s-name", s.title || "Untitled"));
    b.append(el("span", "muted", fmtWhen(s.time?.updated)));
    b.onclick = () => openSession(s.id);
    const x = el("button", "s-del", "×");
    x.title = "Delete this conversation";
    x.onclick = async (e) => {
      e.stopPropagation();
      // Back it up first, so "delete" is always recoverable rather than
      // usually recoverable - the archiver otherwise runs on a one-minute
      // timer and a conversation deleted inside that window would be gone.
      x.disabled = true;
      await api("transcriptArchive", { method: "POST", body: { id: s.id } });
      // The legacy route. `DELETE /api/session/{id}` does not exist: it falls
      // through to the app shell and answers 200 with HTML, so the session
      // survives and the delete silently does nothing.
      const r = await ocall("DELETE", `/session/${s.id}`);
      if (!r.ok) return toast("Could not delete that conversation", "bad");
      if (state.sessionID === s.id) {
        state.sessionID = null;
        state.sessionFolder = null;
        renderMessages([]);
        $("title").textContent = state.surface === "chat" ? "New conversation" : "New project";
      }
      await loadSessions();
      toast("Deleted. You can get it back from Transcripts.");
    };
    row.append(b, x);
    box.append(row);
  }
}

/**
 * Start a conversation in the chosen folder.
 *
 * The LEGACY route, and the folder is why. Measured 2026-08-28:
 * `POST /api/session?directory=X` returns 200 and silently ignores the
 * directory - the session comes back rooted in the default workspace - while
 * `POST /session?directory=X` honours it. The directory is only settable at
 * creation; the session remembers it afterwards, so nothing else has to carry
 * it.
 */
async function newSession() {
  const dir = state.folder || state.workspace;
  const q = dir ? "?directory=" + encodeURIComponent(dir) : "";
  const r = await ocall("POST", "/session" + q, {});
  const id = r.data?.data?.id ?? r.data?.id;
  if (!id) return toast("Could not start a new session", "bad");
  state.kinds[id] = state.surface;
  savePrefs({ kinds: { [id]: state.surface } });
  await ocall("POST", `/api/session/${id}/agent`, { agent: agentFor() });
  if (state.model) await setSessionModel(id, state.model);
  await loadSessions();
  openSession(id);
}

async function openSession(id) {
  state.sessionID = id;
  state.page = null;
  showView("session");
  const s = state.sessions.find((x) => x.id === id);
  $("title").textContent = s?.title || "New conversation";
  renderSessions();
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  state.sessionFolder = null;
  paintFolder();
  ocall("GET", `/session/${id}`).then((d) => {
    if (state.sessionID !== id) return;
    state.sessionFolder = d.data?.directory ?? null;
    paintFolder();
  });
  await refreshMessages();
  subscribe(id);
  refreshUsage();
}

/* ── messages ──────────────────────────────────────────────────────────── */

// The message layer is the LEGACY api (`/session/{id}/message`), not the v2 one
// (`/api/session/{id}/message`), and the two are not views of the same data:
// messages sent through the legacy route do not appear in the v2 list at all.
// Measured 2026-08-27 - a reply that had demonstrably run (5 output tokens
// billed) came back as an empty transcript because the send and the read were
// on different halves of the API. Both halves are used consistently here.
//
// Legacy shape: { info: { id, role, time }, parts: [ {type, text, ...} ] }.
function roleOf(m) {
  return m.info?.role ?? m.role ?? "assistant";
}
function partsOf(m) {
  const p = m.parts ?? [];
  return Array.isArray(p) ? p : [];
}
function createdOf(m) {
  return m.info?.time?.created ?? m.time?.created ?? 0;
}

function renderMarkdownish(text) {
  // Deliberately tiny: fenced code, inline code, and paragraphs. Everything is
  // inserted as text nodes, never as HTML, so model output cannot inject markup.
  const frag = document.createDocumentFragment();
  const blocks = String(text).split(/```/);
  blocks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const pre = el("pre");
      const code = el("code");
      code.textContent = chunk.replace(/^[a-zA-Z0-9_-]*\n/, "");
      pre.append(code);
      frag.append(pre);
      return;
    }
    for (const para of chunk.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = el("p");
      const bits = para.split(/`([^`]+)`/);
      bits.forEach((b, j) => (j % 2 ? p.append(el("code", null, b)) : p.append(document.createTextNode(b))));
      frag.append(p);
    }
  });
  return frag;
}

function renderMessages(list) {
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  box.replaceChildren();
  if (!list.length) {
    box.append(emptyState());
    return;
  }
  for (const m of list) {
    const role = roleOf(m);
    const wrap = el("div", `msg ${role === "user" ? "user" : "assistant"}`);
    wrap.append(el("div", "role", role === "user" ? "You" : "Omni Agent"));
    const body = el("div", "body");

    for (const part of partsOf(m)) {
      if (part.type === "text" && part.text) {
        body.append(renderMarkdownish(part.text));
      } else if (part.type === "reasoning" && part.text) {
        const d = el("details", "tool");
        d.append(el("summary", null, "Thinking"));
        d.append(Object.assign(el("pre"), { textContent: part.text }));
        body.append(d);
      } else if (part.type === "tool" || part.tool) {
        const name = part.tool ?? part.name ?? "tool";
        const d = el("details", "tool");
        const sum = el("summary");
        const st = part.state?.status ?? part.status;
        sum.append(el("span", "tool-name", name));
        sum.append(el("span", "muted", st === "running" ? "running…" : (st ?? "done")));
        d.append(sum);
        const detail = part.state?.output ?? part.state?.input ?? part.output ?? part.input;
        if (detail != null) {
          d.append(
            Object.assign(el("pre"), {
              textContent: typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
            }),
          );
        }
        body.append(d);
      }
      // step-start and other bookkeeping parts carry nothing to show.
    }

    const err = m.info?.error ?? m.error;
    if (err) {
      // The legacy message carries the model flat on `info` as modelID +
      // providerID, and the real text at error.data.message - not error.message,
      // which is undefined and rendered as "[object Object]".
      const providerID = m.info?.providerID ?? m.providerID;
      const modelID = m.info?.modelID ?? m.modelID;
      const key = providerID && modelID ? `${providerID}/${modelID}` : null;
      const text = err.data?.message ?? err.message ?? String(err.name ?? err);
      const e = el("div", "perm");
      e.append(el("h3", null, "That model did not answer"));
      e.append(el("p", null, text));
      // Remember it, so the picker can warn the next person who scrolls past
      // it, and offer the obvious next move right here.
      if (key && !state.unhealthy[key]) {
        state.unhealthy[key] = { message: String(text).slice(0, 160), when: Date.now() };
        savePrefs({ unhealthy: state.unhealthy });
      }
      const pick = el("button", "btn primary", "Choose a different model");
      pick.onclick = () => $("model-btn").click();
      e.append(pick);
      body.append(e);
    }
    if (!body.childNodes.length) {
      if (role === "user") continue; // an empty user turn is not worth a bubble
      body.append(el("p", "muted", "…"));
    }
    wrap.append(body);
    box.append(wrap);
  }
  // Only chase the bottom if the reader was already there, so scrolling back
  // through a long answer is not yanked away every time a token arrives.
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function emptyState() {
  const wrap = el("div", "empty");
  const mark = el("img", "empty-mark");
  mark.src = "logo.svg";
  mark.alt = "Omni Agent";
  mark.width = 56;
  mark.height = 56;
  wrap.append(mark);
  const chat = state.surface === "chat";
  wrap.append(el("h2", null, chat ? "What would you like to know?" : "What should I build?"));
  wrap.append(
    el(
      "p",
      null,
      chat
        ? "Ask anything. In Chat the agent reads, searches the web and explains — it never edits your files."
        : "Describe what you want. The agent can write code, run commands and use the web, and asks before anything risky.",
    ),
  );
  const starters = el("div", "starters");
  const ideas = chat
    ? [
        "Explain what this app can do, in plain language",
        "Search the web and summarise what's new in AI this week",
        "What's the difference between the models I can choose from?",
      ]
    : [
        "Make me a simple website for my business",
        "Look at the files in my workspace and tell me what's there",
        "Write a script that renames all the photos in a folder by date",
      ];
  for (const idea of ideas) {
    const b = el("button", "starter", idea);
    b.onclick = () => {
      $("prompt").value = idea;
      $("prompt").focus();
      autosize();
    };
    starters.append(b);
  }
  wrap.append(starters);
  return wrap;
}

async function refreshMessages() {
  if (!state.sessionID) return;
  const r = await ocall("GET", `/session/${state.sessionID}/message`);
  const raw = r.data;
  const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
  // Ids are monotonic and always present, so they settle ties where two
  // messages share a millisecond.
  const ordered = [...list].sort(
    (a, b) => createdOf(a) - createdOf(b) || String(a.info?.id ?? "").localeCompare(String(b.info?.id ?? "")),
  );
  renderMessages(ordered);
}

/* ── live updates ──────────────────────────────────────────────────────── */

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshMessages();
    refreshUsage();
    checkPermissions();
  }, 150);
}

function subscribe(sessionID) {
  state.stream?.close();
  const es = new EventSource(`/oc/api/session/${sessionID}/event?t=${encodeURIComponent(TOKEN)}`);
  state.stream = es;
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    const t = ev.type ?? "";
    // Events are the trigger, not the payload. Re-reading the message list on
    // each one keeps rendering independent of an event schema that is still
    // marked experimental in places, at the cost of one cheap local request.
    if (t.startsWith("session.")) scheduleRefresh();
    if (t.includes("step.started") || t.includes("prompted")) setBusy(true);
    if (t.includes("step.completed") || t.includes("step.failed") || t.includes("idle")) setBusy(false);
    if (t.includes("permission") || t.includes("question")) checkPermissions();
  };
  es.onerror = () => {
    /* EventSource reconnects on its own; a closed session simply stops. */
  };
}

function setBusy(on) {
  state.busy = on;
  $("btn-stop").hidden = !on;
  $("send").disabled = on;
  document.querySelectorAll(".s-item.active").forEach((n) => n.classList.toggle("busy", on));
}

/* ── permissions ───────────────────────────────────────────────────────── */

async function checkPermissions() {
  if (!state.sessionID) return;
  const bar = $("permission-bar");
  const r = await ocall("GET", `/api/session/${state.sessionID}/permission`);
  const list = (r.data?.data ?? r.data ?? []).filter((p) => !p.resolved && !p.reply);
  if (!list.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const p = list[0];
  bar.replaceChildren();
  const card = el("div", "perm");
  card.append(el("h3", null, p.title ?? "The agent wants to do something"));
  card.append(el("p", null, p.description ?? p.metadata?.command ?? "It needs your go-ahead to continue."));
  const detail = p.metadata?.command ?? p.metadata?.filePath ?? null;
  if (detail) card.append(Object.assign(el("pre"), { textContent: String(detail) }));
  const actions = el("div", "perm-actions");
  const reply = async (response) => {
    await ocall("POST", `/api/session/${state.sessionID}/permission/${p.id ?? p.requestID}/reply`, { response });
    bar.hidden = true;
    scheduleRefresh();
  };
  const yes = el("button", "btn primary", "Allow once");
  yes.onclick = () => reply("once");
  const always = el("button", "btn", "Always allow this");
  always.onclick = () => reply("always");
  const no = el("button", "btn danger", "No");
  no.onclick = () => reply("reject");
  actions.append(yes, always, no);
  card.append(actions);
  bar.append(card);
  bar.hidden = false;
}

/* ── sending ───────────────────────────────────────────────────────────── */

/**
 * Send a message and let the event stream paint the reply.
 *
 * WHICH ROUTE, and this cost most of the debugging on this feature.
 * `POST /api/session/{id}/prompt` accepts the message, returns 200 with an
 * `admittedSeq`, and then nothing happens: no assistant message, no tokens
 * spent, and no request ever reaches the gateway. Measured 2026-08-27 across
 * both agents and four different models. `POST /session/{id}/message` - the
 * route the TUI itself uses - returns the finished reply in about five
 * seconds. So this uses that one.
 *
 * Note the model field differs between the two routes on the same server:
 * ModelRef (used by /api/session/{id}/model) is `{providerID, id}`, and this
 * route wants `{providerID, modelID}`. They are not interchangeable.
 */
/**
 * A conversation's name, taken from the first thing asked of it.
 *
 * OpenCode names a session "New session - 2026-08-27T21:59:59.949Z" until its
 * own summariser has run, which is both ugly and useless in a sidebar. This
 * puts a readable name there from the first keystroke onwards; if OpenCode
 * later writes its own summary it is a better one and simply wins.
 */
function nameFromPrompt(text) {
  const first = String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = first.split(/(?<=[.?!])\s/)[0] ?? first;
  const name = (sentence.length > 62 ? sentence.slice(0, 60).replace(/\s\S*$/, "") + "…" : sentence).trim();
  if (!name) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function isPlaceholderTitle(t) {
  return !t || /^New session\b/i.test(t) || /^Untitled$/i.test(t);
}

async function send(text) {
  if (!text.trim()) return;
  const fresh = !state.sessionID;
  if (!state.sessionID) await newSession();
  const id = state.sessionID;
  const current = state.sessions.find((s) => s.id === id);
  if (fresh || isPlaceholderTitle(current?.title)) {
    const name = nameFromPrompt(text);
    if (name) {
      await ocall("PATCH", `/session/${id}`, { title: name });
      $("title").textContent = name;
    }
  }
  setBusy(true);
  // Paint the question immediately rather than waiting for the round trip.
  scheduleRefresh();

  const body = {
    agent: agentFor(),
    parts: [{ type: "text", text }],
  };
  if (state.model) body.model = { providerID: state.model.providerID, modelID: state.model.id };

  // Deliberately not awaited for rendering: this route only returns once the
  // whole reply is finished, and the transcript should fill in as it arrives.
  ocall("POST", `/session/${id}/message`, body)
    .then((r) => {
      setBusy(false);
      if (!r.ok) toast(r.data?.message ?? `The agent could not answer (${r.status})`, "bad");
      scheduleRefresh();
      loadSessions();
    })
    .catch((e) => {
      setBusy(false);
      toast(e.message, "bad");
    });

  // The title is generated after the first exchange, so pick it up shortly.
  setTimeout(loadSessions, 6000);
}

function autosize() {
  const t = $("prompt");
  t.style.height = "auto";
  t.style.height = Math.min(220, t.scrollHeight) + "px";
}

/* ── usage ─────────────────────────────────────────────────────────────── */

async function refreshUsage() {
  const r = await api("usage", { query: state.sessionID ? { session: state.sessionID } : {} });
  const meter = $("context-meter");
  if (r?.context?.percent != null) {
    meter.hidden = false;
    $("context-fill").style.width = r.context.percent + "%";
    $("context-text").textContent = `${r.context.percent}% of context`;
    meter.classList.toggle("hot", r.context.percent >= 85);
  } else if (r?.context) {
    meter.hidden = false;
    $("context-fill").style.width = "0%";
    $("context-text").textContent = `${fmtNum(r.context.used)} tokens`;
  } else {
    meter.hidden = true;
  }

  const pill = $("usage-pill");
  const rows = (r?.quota ?? []).filter((q) => q.available);
  if (rows.length) {
    const worst = rows.reduce((a, b) => (a.percent > b.percent ? a : b));
    pill.textContent = `${worst.percent}% used`;
    pill.title = rows.map((q) => `${q.provider}: ${q.used}/${q.total}`).join("\n");
  } else {
    pill.textContent = "Free tier";
    pill.title =
      "No provider on this install publishes a machine-readable allowance, so there is no percentage to show. This is not an estimate.";
  }
}

/* ── model picker ──────────────────────────────────────────────────────── */

async function loadModels() {
  const r = await api("models");
  state.models = r.providers ?? [];
  const pref = state.models.find((p) => p.preferred) ?? state.models[0];
  const saved = state.model;
  const known = (m) =>
    m && state.models.some((p) => p.id === m.providerID && p.models.some((x) => x.id === m.id));
  // Order matters: what the user chose, then what setup configured, then the
  // provider's own default, then anything. The provider default is third
  // because it is not chosen with chat in mind.
  if (known(saved)) state.model = saved;
  else if (r.configured) state.model = r.configured;
  else if (pref?.default) state.model = { providerID: pref.id, id: pref.default };
  else if (pref?.models?.length) state.model = { providerID: pref.id, id: pref.models[0].id };
  paintModel();
}

/**
 * Pin a session to a model.
 *
 * The body shape is load-bearing and is not what it looks like: the route wants
 * `{ model: { providerID, id } }`. Sending `{ providerID, modelID }` - the
 * shape the session object itself reports - returns 400 and the session quietly
 * keeps OpenCode's own default, which is how a first message ended up on
 * "x-preview-f-free" instead of the gateway.
 */
async function setSessionModel(sessionID, model) {
  const r = await ocall("POST", `/api/session/${sessionID}/model`, {
    model: { providerID: model.providerID, id: model.id },
  });
  if (!r.ok) toast("Could not switch model: " + (r.data?.message ?? r.status), "bad");
  return r.ok;
}

function modelName() {
  if (!state.model) return "Choosing…";
  const p = state.models.find((x) => x.id === state.model.providerID);
  const m = p?.models.find((x) => x.id === state.model.id);
  return m?.name ?? state.model.id ?? "Model";
}
function paintModel() {
  $("model-label").textContent = modelName();
  $("foot-model").textContent = modelName();
}

/* ── the working folder ────────────────────────────────────────────────── */

const baseName = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : "");

/** The folder that applies right now: the open session's, or the next one's. */
function activeFolder() {
  if (state.sessionID && state.sessionFolder) return state.sessionFolder;
  return state.folder ?? state.workspace;
}

function paintFolder() {
  const f = activeFolder();
  $("folder-label").textContent = baseName(f) || "Workspace";
  $("folder-btn").title = f ? `Working in ${f}` : "The folder it works in";
  // The header chip used to show the default workspace and only that, which
  // read as a lie the moment a conversation was working somewhere else.
  const chip = $("workspace-chip");
  chip.textContent = baseName(f) || "";
  chip.title = f ?? "";
}

async function loadFolders() {
  const r = await api("folders");
  if (r.ok === false) return;
  state.folder = r.folder ?? null;
  state.workspace = r.workspace ?? null;
  state.recentFolders = r.recent ?? [];
  paintFolder();
}

async function chooseFolder(path) {
  const r = await api("folderSet", { method: "POST", body: { path } });
  if (r.ok === false) return toast(r.error, "bad");
  state.folder = r.folder;
  state.recentFolders = r.recent ?? [];
  $("pop-model").hidden = true;
  paintFolder();
  toast(
    state.sessionID
      ? `Your next conversation will work in ${baseName(r.folder)}.`
      : `Working in ${baseName(r.folder)}.`,
  );
}

/**
 * Pick where the agent works.
 *
 * The folder is fixed when a conversation starts, so this cannot move an open
 * one. Rather than offering a control that quietly does nothing, the popover
 * says which folder the current conversation is in and that a new one is what
 * changes it.
 */
function openFolderPicker(e) {
  const box = el("div", "pop-search-wrap");
  const here = activeFolder();

  if (state.sessionID) {
    box.append(el("div", "pop-head", "This conversation works in"));
    box.append(el("div", "pop-note", here || "the default workspace"));
    box.append(el("div", "pop-head", "Choosing another folder starts your next conversation there"));
  } else {
    box.append(el("div", "pop-head", "New conversations will work in"));
  }

  const row = (label, sub, path, active) => {
    const b = el("button", "pop-item" + (active ? " active" : ""));
    b.append(document.createTextNode(label));
    if (sub) b.append(el("small", null, sub));
    b.onclick = () => chooseFolder(path);
    return b;
  };

  if (state.workspace) {
    box.append(
      row("Default workspace", state.workspace, state.workspace, state.folder === state.workspace),
    );
  }
  for (const p of state.recentFolders) {
    if (p === state.workspace) continue;
    box.append(row(baseName(p), p, p, state.folder === p));
  }

  const pick = el("button", "pop-item primary");
  pick.append(document.createTextNode("Choose a folder…"));
  pick.append(el("small", null, "opens the Windows folder picker"));
  pick.onclick = async () => {
    pick.disabled = true;
    pick.replaceChildren(document.createTextNode("Waiting for the folder picker…"));
    const r = await api("folderPick", { method: "POST" });
    if (r.ok === false) return toast(r.error, "bad");
    if (r.cancelled) {
      $("pop-model").hidden = true;
      return;
    }
    state.folder = r.folder;
    state.recentFolders = r.recent ?? [];
    $("pop-model").hidden = true;
    paintFolder();
    toast(
      state.sessionID
        ? `Your next conversation will work in ${baseName(r.folder)}.`
        : `Working in ${baseName(r.folder)}.`,
    );
  };
  box.append(pick);

  popover(e.currentTarget, box);
}

function popover(anchor, node) {
  const pop = $("pop-model");
  pop.replaceChildren(node);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + "px";
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + "px";
  const close = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) {
      pop.hidden = true;
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

/**
 * Every model, searchable.
 *
 * The whole list is offered - not a curated slice - because the point of the
 * gateway is breadth: 180-odd free models across a dozen providers, and the
 * user is entitled to pick any of them. That only works with a filter box, so
 * there is one, and it is focused the moment the picker opens.
 */
function openModelPicker(e) {
  const box = el("div", "pop-search-wrap");
  const search = Object.assign(el("input", "pop-search"), {
    type: "text",
    placeholder: "Search models…",
    autocomplete: "off",
  });
  box.append(search);
  const results = el("div");
  box.append(results);

  const choose = async (p, m) => {
    state.model = { providerID: p.id, id: m.id };
    savePrefs({ model: state.model });
    paintModel();
    $("pop-model").hidden = true;
    if (state.sessionID) await setSessionModel(state.sessionID, state.model);
  };

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    results.replaceChildren();
    if (!state.models.length) {
      results.append(el("div", "pop-head", "No models available yet"));
      return;
    }
    let shown = 0;
    for (const p of state.models) {
      const hits = p.models.filter(
        (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
      );
      if (!hits.length) continue;
      results.append(el("div", "pop-head", `${p.name}${p.preferred ? " · included free" : ""} (${hits.length})`));
      // No practical cap: the whole point is that every model is pickable, and
      // 150-odd rows render instantly. The search box is for finding one fast,
      // not for reaching models the list would otherwise hide.
      for (const m of hits.slice(0, 500)) {
        const on = state.model?.id === m.id && state.model?.providerID === p.id;
        const b = el("button", "pop-item" + (on ? " active" : ""));
        b.append(document.createTextNode(m.name));
        const bits = [];
        const bad = state.unhealthy[`${p.id}/${m.id}`];
        if (bad) bits.push("failed here before");
        if (m.id.startsWith("auto/")) bits.push("picks for you");
        if (m.free) bits.push("free");
        if (m.context) bits.push(fmtNum(m.context) + " context");
        if (bits.length) b.append(el("small", null, bits.join(" · ")));
        if (bad) b.classList.add("unhealthy");
        b.onclick = () => choose(p, m);
        results.append(b);
        shown++;
      }
    }
    if (!shown) results.append(el("div", "pop-head", "Nothing matches that"));
  };

  search.addEventListener("input", paint);
  paint();
  popover(e.currentTarget, box);
  search.focus();
}

function openModePicker(e) {
  const box = el("div");
  box.append(el("div", "pop-head", "How much should it do on its own?"));
  for (const [id, m] of Object.entries(MODES)) {
    const b = el("button", "pop-item" + (state.mode === id ? " active" : ""));
    b.append(document.createTextNode(m.label));
    b.append(el("small", null, m.blurb));
    b.onclick = async () => {
      state.mode = id;
      savePrefs({ mode: id });
      $("mode-label").textContent = m.label;
      $("pop-model").hidden = true;
      if (state.sessionID) await ocall("POST", `/api/session/${state.sessionID}/agent`, { agent: agentFor() });
      toast(`Mode: ${m.label}`);
    };
    box.append(b);
  }
  popover(e.currentTarget, box);
}

/* ── views ─────────────────────────────────────────────────────────────── */

function showView(which) {
  $("view-session").classList.toggle("active", which === "session");
  $("view-page").classList.toggle("active", which === "page");
}

function setSurface(s) {
  state.surface = s;
  document.querySelectorAll(".seg-btn").forEach((b) => {
    const on = b.dataset.surface === s;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("prompt").placeholder = s === "chat" ? "Ask anything" : "Describe what you want done";
  $("fineprint").textContent =
    s === "chat"
      ? "Chat reads and searches. It never edits your files."
      : "The agent always asks before sending, buying, publishing or deleting anything.";
  $("mode-btn").hidden = s === "chat";
  state.sessionID = null;
  state.sessionFolder = null;
  paintFolder();
  renderSessions();
  showView("session");
  $("title").textContent = s === "chat" ? "New conversation" : "New project";
  renderMessages([]);
  refreshUsage();
}

/* ── pages ─────────────────────────────────────────────────────────────── */

const pages = {};

function page(title, lede) {
  const body = $("page-body");
  body.replaceChildren();
  const inner = el("div", "page-inner");
  inner.append(el("h2", null, title));
  if (lede) inner.append(el("p", "lede", lede));
  body.append(inner);
  return inner;
}

async function openPage(name) {
  state.page = name;
  showView("page");
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === name));
  const inner = page("Loading…");
  try {
    await pages[name](inner);
  } catch (err) {
    page("Something went wrong", err.message);
  }
}

/* Token saving ---------------------------------------------------------- */
pages.saving = async () => {
  const r = await api("savingList");
  const inner = page(
    "Token saving",
    "Free models come with limits. The gateway can shrink what gets sent so the same work costs far fewer tokens.",
  );
  if (!r.ok) {
    inner.append(el("p", "muted", r.error ?? "The gateway is not reachable."));
    return;
  }
  const note = el("div", "card");
  note.append(el("p", null, r.preserved));
  note.append(
    el(
      "p",
      "muted",
      r.measuredOn === "representative"
        ? "Percentages below were measured on a representative agent payload, not your own traffic."
        : "Percentages below were measured on your own recent requests.",
    ),
  );
  inner.append(note);

  for (const t of r.tiers) {
    const c = el("div", "card");
    const h = el("h3");
    h.append(document.createTextNode(t.label));
    if (t.id === r.current) h.append(el("span", "tag on", "in use"));
    h.append(el("span", "tag", t.axis));
    c.append(h);
    c.append(el("p", null, t.summary));
    c.append(el("p", "muted", t.costs));
    const row = el("div", "row");
    row.style.marginTop = "9px";
    const measured = el("span", "muted", t.savedPct == null ? "not measured" : `${t.savedPct}% smaller`);
    row.append(measured, el("span", "grow"));
    if (t.id !== r.current) {
      const b = el("button", "btn", "Use this");
      b.onclick = async () => {
        const res = await api("savingSet", { method: "POST", body: { tier: t.id } });
        if (res.ok) {
          toast(`Token saving: ${res.label}`, "good");
          openPage("saving");
        } else toast(res.error, "bad");
      };
      row.append(b);
    }
    c.append(row);
    if (t.savedPct != null) {
      const bar = el("div", "bar");
      bar.append(Object.assign(el("i"), { style: `width:${Math.max(1, t.savedPct)}%` }));
      c.append(bar);
    }
    inner.append(c);
  }
};

/* Free capacity --------------------------------------------------------- */
pages.providers = async () => {
  const r = await api("providers");
  const inner = page(
    "Free capacity",
    "The agent already works with no account at all. Everything here is an upgrade: more models, more speed, higher limits — and every one has a genuinely free tier.",
  );
  if (!r.ok) return inner.append(el("p", "muted", r.error));
  inner.append(el("p", "muted", r.note));

  const section = (label) => inner.append(el("h3", null, label));

  section("Paste a free key");
  for (const p of r.models) {
    const c = el("div", "card");
    const h = el("h3");
    h.append(document.createTextNode(p.label));
    h.append(el("span", p.connected ? "tag on" : "tag off", p.connected ? "connected" : "not connected"));
    c.append(h, el("p", null, p.gives));
    if (p.note) c.append(el("p", "muted", p.note));
    const row = el("div", "row");
    row.style.marginTop = "10px";
    const input = Object.assign(el("input"), { type: "password", placeholder: "Paste the key here" });
    row.append(input);
    const add = el("button", "btn primary", "Add");
    add.onclick = async () => {
      add.disabled = true;
      const res = await api("providerAdd", { method: "POST", body: { id: p.id, key: input.value.trim() } });
      add.disabled = false;
      if (res.ok) {
        toast(res.works === false ? `Saved, but: ${res.problem ?? "it did not answer"}` : `${p.label} connected`, res.works === false ? "bad" : "good");
        openPage("providers");
      } else toast(res.error, "bad");
    };
    row.append(add);
    const how = el("button", "btn", "How?");
    how.onclick = () => showSetup(p.id);
    row.append(how);
    c.append(row);
    inner.append(c);
  }

  section("Use a subscription you already pay for");
  for (const p of r.signIn) {
    const c = el("div", "card");
    const row = el("div", "row");
    const left = el("div", null);
    left.append(el("h3", null, p.label), el("p", null, p.gives + (p.note ? ` (${p.note})` : "")));
    row.append(left, el("span", "grow"));
    const b = el("button", "btn", p.connected ? "Signed in" : "Sign in");
    b.disabled = p.connected;
    b.onclick = async () => {
      const res = await api("providerSignin", { query: { id: p.id } });
      if (res.ok) toast("Approve the sign-in in the browser window that opened.");
      else toast(res.error, "bad");
    };
    row.append(b);
    c.append(row);
    inner.append(c);
  }
};

async function showSetup(id) {
  const r = await api("providerSetup", { query: { id } });
  const m = $("modal");
  m.replaceChildren();
  if (!r.ok) {
    m.append(el("h3", null, "No instructions"), el("p", null, r.error));
  } else {
    m.append(el("h3", null, r.label));
    m.append(el("p", "muted", r.gives));
    const ol = el("ol", "steps");
    for (const s of r.steps) {
      const li = el("li");
      // Steps name exact commands; show them as commands, not prose.
      const bits = String(s).split(/(omni-agent [^\s]+(?: [^\s]+)*|https?:\/\/\S+)/g);
      bits.forEach((b, i) => (i % 2 ? li.append(el("code", null, b)) : li.append(document.createTextNode(b))));
      ol.append(li);
    }
    m.append(ol);
    if (r.verify) m.append(el("p", "muted", `Check it worked: ${r.verify}`));
  }
  const acts = el("div", "modal-actions");
  const close = el("button", "btn", "Close");
  close.onclick = () => ($("modal-back").hidden = true);
  acts.append(close);
  m.append(acts);
  $("modal-back").hidden = false;
}

/* Search tools ---------------------------------------------------------- */
pages.search = async () => {
  const r = await api("search");
  const inner = page("Search tools", "How the agent looks things up on the web, in the order it tries them.");
  if (!r.ok) return inner.append(el("p", "muted", r.error));
  inner.append(el("p", "muted", r.note));
  r.providers.forEach((p, i) => {
    const c = el("div", "card");
    const h = el("h3");
    h.append(document.createTextNode(`${i + 1}. ${p.label}`));
    h.append(el("span", p.active ? "tag on" : "tag off", p.active ? "in use" : "needs a key"));
    if (!p.needsKey) h.append(el("span", "tag", "no key needed"));
    c.append(h);
    c.append(el("p", null, p.gives));
    if (p.note) c.append(el("p", "muted", p.note));
    if (p.needsKey && !p.hasKey) {
      const row = el("div", "row");
      row.style.marginTop = "10px";
      const input = Object.assign(el("input"), { type: "password", placeholder: "Paste the key here" });
      const add = el("button", "btn primary", "Add");
      add.onclick = async () => {
        const res = await api("providerAdd", { method: "POST", body: { id: p.id, key: input.value.trim() } });
        if (res.ok) {
          toast(`${p.label} key saved. It will be used first from now on.`, "good");
          openPage("search");
        } else toast(res.error, "bad");
      };
      const how = el("button", "btn", "How?");
      how.onclick = () => showSetup(p.id);
      row.append(input, add, how);
      c.append(row);
    }
    inner.append(c);
  });
  inner.append(el("h3", null, "Reading pages"));
  inner.append(el("p", "muted", `Tried in order: ${r.scrape.join(" → ")}`));
};

/* Usage ----------------------------------------------------------------- */
pages.usage = async () => {
  const r = await api("usage", { query: state.sessionID ? { session: state.sessionID } : {} });
  const inner = page("Usage", "What you have spent, and how much of each free allowance is left.");
  if (r.context) {
    const c = el("div", "card");
    c.append(el("h3", null, "This conversation"));
    c.append(
      el(
        "p",
        null,
        `${fmtNum(r.context.used)} tokens used` +
          (r.context.limit ? ` of ${fmtNum(r.context.limit)} (${r.context.percent}%)` : ""),
      ),
    );
    if (r.context.limit) {
      const bar = el("div", "bar");
      bar.append(Object.assign(el("i"), { style: `width:${r.context.percent}%` }));
      c.append(bar);
    }
    inner.append(c);
  }
  const q = el("div", "card");
  q.append(el("h3", null, "Free allowances"));
  if (!r.quota?.length) {
    q.append(el("p", "muted", "The gateway reported no allowance information."));
  } else {
    for (const row of r.quota) {
      const line = el("div", "row");
      line.style.marginTop = "8px";
      line.append(el("span", null, row.provider), el("span", "grow"));
      line.append(
        row.available
          ? el("span", null, `${row.used} / ${row.total} (${row.percent}%)`)
          : el("span", "tag warn", "Unavailable"),
      );
      q.append(line);
    }
  }
  inner.append(q);
  for (const n of r.notes ?? []) inner.append(el("p", "muted", n));
};

/* Transcripts ----------------------------------------------------------- */
pages.transcripts = async () => {
  const r = await api("transcripts");
  const inner = page(
    "Transcripts",
    "A copy of every conversation, kept outside the agent. If you delete a chat by accident, it is still here.",
  );
  const bar = el("div", "card");
  const row = el("div", "row");
  row.append(el("p", "grow", `Saved in ${r.archiveDir}`));
  const now = el("button", "btn", "Back up now");
  now.onclick = async () => {
    const res = await api("transcriptArchive", { method: "POST" });
    toast(res.ok ? `Backed up ${res.saved} conversation(s).` : res.error, res.ok ? "good" : "bad");
    openPage("transcripts");
  };
  const auto = el("button", "btn", "Restore everything deleted");
  auto.onclick = async () => {
    const res = await api("transcriptAutoImport", { method: "POST" });
    toast(res.ok ? `Restored ${res.restored.length} of ${res.considered}.` : res.error, res.ok ? "good" : "bad");
    loadSessions();
    openPage("transcripts");
  };
  row.append(now, auto);
  bar.append(row);
  inner.append(bar);

  if (!r.transcripts?.length) {
    inner.append(el("p", "muted", "Nothing archived yet. Conversations are backed up every minute while the app is open."));
    return;
  }
  for (const t of r.transcripts) {
    const c = el("div", "card");
    const h = el("h3");
    h.append(document.createTextNode(t.title));
    h.append(el("span", t.deleted ? "tag warn" : "tag on", t.deleted ? "deleted from the agent" : "live"));
    c.append(h);
    c.append(el("p", "muted", `${fmtWhen(t.updated)} · ${Math.round(t.bytes / 1024)} KB`));
    const row2 = el("div", "row");
    row2.style.marginTop = "9px";
    row2.append(el("span", "grow"));
    if (t.deleted) {
      const b = el("button", "btn primary", "Bring it back");
      b.onclick = async () => {
        const res = await api("transcriptRestore", { method: "POST", body: { id: t.id } });
        toast(res.ok ? "Restored." : res.error ?? res.reason, res.ok ? "good" : "bad");
        loadSessions();
        openPage("transcripts");
      };
      row2.append(b);
    }
    const del = el("button", "btn danger", "Delete the backup");
    del.onclick = async () => {
      await api("transcriptForget", { method: "POST", body: { id: t.id } });
      openPage("transcripts");
    };
    row2.append(del);
    c.append(row2);
    inner.append(c);
  }
};

/* Routines -------------------------------------------------------------- */
pages.routines = async () => {
  const r = await api("routines");
  const inner = page("Routines", "Work the agent does on a schedule, without you asking each time.");
  const add = el("button", "btn primary", "+ New routine");
  add.onclick = () => routineForm();
  inner.append(add);

  if (!r.routines?.length) {
    inner.append(el("p", "muted", "No routines yet."));
    return;
  }
  for (const rt of r.routines) {
    const c = el("div", "card");
    const h = el("h3");
    h.append(document.createTextNode(rt.name));
    h.append(el("span", rt.enabled ? "tag on" : "tag off", rt.enabled ? "on" : "paused"));
    h.append(el("span", "tag", rt.when === "always" ? "runs even when closed" : "runs while the app is open"));
    c.append(h);
    c.append(el("p", null, rt.prompt));
    const desc =
      rt.schedule.kind === "interval"
        ? `every ${rt.schedule.everyMinutes} minutes`
        : `${rt.schedule.kind} at ${rt.schedule.at}`;
    c.append(el("p", "muted", `${desc}${rt.nextRun ? ` · next ${new Date(rt.nextRun).toLocaleString()}` : ""}${rt.lastRun ? ` · last ${fmtWhen(rt.lastRun)} (${rt.lastResult})` : ""}`));
    const row = el("div", "row");
    row.style.marginTop = "9px";
    row.append(el("span", "grow"));
    const runNow = el("button", "btn", "Run now");
    runNow.onclick = async () => {
      const res = await api("routineRun", { method: "POST", body: { id: rt.id } });
      if (res.ok) {
        toast("Started.", "good");
        await loadSessions();
        state.kinds[res.sessionID] = "code";
        savePrefs({ kinds: { [res.sessionID]: "code" } });
      } else toast(res.error ?? res.reason, "bad");
    };
    const toggle = el("button", "btn", rt.enabled ? "Pause" : "Resume");
    toggle.onclick = async () => {
      await api("routineUpdate", { method: "POST", body: { id: rt.id, patch: { enabled: !rt.enabled } } });
      openPage("routines");
    };
    const del = el("button", "btn danger", "Delete");
    del.onclick = async () => {
      await api("routineDelete", { method: "POST", body: { id: rt.id } });
      openPage("routines");
    };
    row.append(runNow, toggle, del);
    c.append(row);
    inner.append(c);
  }
};

function routineForm() {
  const m = $("modal");
  m.replaceChildren();
  m.append(el("h3", null, "New routine"));
  const field = (label, node) => {
    const l = el("label", "f");
    l.append(el("span", null, label), node);
    m.append(l);
    return node;
  };
  const name = field("What is it called?", Object.assign(el("input"), { type: "text", placeholder: "Morning news summary" }));
  const prompt = field(
    "What should the agent do?",
    Object.assign(el("textarea", "field"), { rows: 3, placeholder: "Search the web for AI news from the last day and write me a short summary." }),
  );
  const kind = field(
    "How often?",
    (() => {
      const s = el("select");
      for (const [v, t] of [
        ["daily", "Every day"],
        ["weekdays", "Weekdays only"],
        ["weekly", "Once a week"],
        ["interval", "Every so many minutes"],
      ])
        s.append(Object.assign(el("option", null, t), { value: v }));
      return s;
    })(),
  );
  const grid = el("div", "grid2");
  const at = Object.assign(el("input"), { type: "time", value: "09:00" });
  const every = Object.assign(el("input"), { type: "number", value: "60", min: "5" });
  const l1 = el("label", "f");
  l1.append(el("span", null, "At what time?"), at);
  const l2 = el("label", "f");
  l2.append(el("span", null, "Every N minutes"), every);
  grid.append(l1, l2);
  m.append(grid);
  const when = field(
    "When should it be able to run?",
    (() => {
      const s = el("select");
      s.append(Object.assign(el("option", null, "Only while Omni Agent is open"), { value: "in-app" }));
      s.append(Object.assign(el("option", null, "Even when Omni Agent is closed"), { value: "always" }));
      return s;
    })(),
  );

  const acts = el("div", "modal-actions");
  const cancel = el("button", "btn", "Cancel");
  cancel.onclick = () => ($("modal-back").hidden = true);
  const save = el("button", "btn primary", "Create");
  save.onclick = async () => {
    const res = await api("routineCreate", {
      method: "POST",
      body: {
        name: name.value,
        prompt: prompt.value,
        when: when.value,
        schedule: { kind: kind.value, at: at.value, everyMinutes: Number(every.value) },
      },
    });
    if (res.ok) {
      $("modal-back").hidden = true;
      toast("Routine created.", "good");
      openPage("routines");
    } else toast(res.reason ?? res.error, "bad");
  };
  acts.append(cancel, save);
  m.append(acts);
  $("modal-back").hidden = false;
}

/* Tools and plugins ----------------------------------------------------- */
pages.tools = async () => {
  const r = await api("tools");
  const inner = page("Tools & plugins", "What the agent can actually do, and how to give it more.");
  const skills = r.skills ?? [];
  const tools = r.tools ?? [];
  const mcpRaw = r.mcp ?? {};
  const mcp = Array.isArray(mcpRaw) ? mcpRaw : Object.entries(mcpRaw).map(([name, v]) => ({ name, ...(v ?? {}) }));

  const c1 = el("div", "card");
  c1.append(el("h3", null, `Built-in tools (${tools.length})`));
  c1.append(
    el(
      "p",
      "muted",
      tools
        .map((t) => (typeof t === "string" ? t : (t.id ?? t.name)))
        .slice(0, 40)
        .join(" · ") || "None reported.",
    ),
  );
  inner.append(c1);

  const c2 = el("div", "card");
  c2.append(el("h3", null, `Skills (${skills.length})`));
  for (const s of skills.slice(0, 40)) {
    const line = el("p", "muted", `${s.name ?? s.id} — ${(s.description ?? "").slice(0, 130)}`);
    c2.append(line);
  }
  if (!skills.length) c2.append(el("p", "muted", "None installed."));
  inner.append(c2);

  const c3 = el("div", "card");
  c3.append(el("h3", null, `Connections (${mcp.length})`));
  c3.append(el("p", "muted", "MCP servers let the agent reach other apps and services."));
  for (const s of mcp) {
    const line = el("div", "row");
    line.style.marginTop = "6px";
    line.append(el("span", null, s.name), el("span", "grow"));
    line.append(el("span", s.status === "connected" || s.connected ? "tag on" : "tag off", s.status ?? (s.connected ? "connected" : "not connected")));
    c3.append(line);
  }
  const addRow = el("div", "row");
  addRow.style.marginTop = "10px";
  const nm = Object.assign(el("input"), { type: "text", placeholder: "Name" });
  const cmd = Object.assign(el("input"), { type: "text", placeholder: "Command, e.g. npx -y @some/mcp-server" });
  const addb = el("button", "btn primary", "Add");
  addb.onclick = async () => {
    const parts = cmd.value.trim().split(/\s+/);
    if (!nm.value.trim() || !parts.length) return toast("A name and a command are needed", "bad");
    const res = await api("mcpAdd", {
      method: "POST",
      body: { name: nm.value.trim(), type: "local", command: parts, enabled: true },
    });
    toast(res.ok ? "Connection added." : res.error, res.ok ? "good" : "bad");
    if (res.ok) openPage("tools");
  };
  addRow.append(nm, cmd, addb);
  c3.append(addRow);
  inner.append(c3);
};

/* Settings -------------------------------------------------------------- */
pages.settings = async () => {
  const r = await api("settingsGet");
  const inner = page("Settings", "Everything the app remembers. Secrets are stored separately and never appear here.");
  const cfg = r.config ?? {};

  const mk = (title, rows) => {
    const c = el("div", "card");
    c.append(el("h3", null, title));
    for (const row of rows) c.append(row);
    inner.append(c);
    return c;
  };

  const toggle = (label, value, onChange) => {
    const row = el("div", "row");
    row.style.marginTop = "7px";
    row.append(el("span", "grow", label));
    const b = el("button", "btn", value ? "On" : "Off");
    b.onclick = async () => {
      await onChange(!value);
      openPage("settings");
    };
    row.append(b);
    return row;
  };

  mk("Browsing", [
    toggle("Run the browser invisibly", cfg.browser?.headless, (v) =>
      api("settingsSet", { method: "POST", body: { browser: { ...cfg.browser, headless: v } } }),
    ),
    toggle("Allow the agent to submit web forms without asking", cfg.browser?.allowFormSubmit, (v) =>
      api("settingsSet", { method: "POST", body: { browser: { ...cfg.browser, allowFormSubmit: v } } }),
    ),
    el("p", "muted", "Sending, buying, publishing and deleting always ask, whatever this is set to."),
  ]);

  mk("Privacy", [
    toggle("Keep local usage statistics", cfg.telemetry?.enabled, (v) =>
      api("settingsSet", { method: "POST", body: { telemetry: { enabled: v } } }),
    ),
    el("p", "muted", "Nothing is ever sent off this machine."),
  ]);

  const permRow = el("div", "row");
  permRow.append(el("span", "grow", "How much it asks before acting"));
  const sel = el("select");
  for (const p of ["cautious", "standard", "trusting"]) {
    const o = Object.assign(el("option", null, p), { value: p });
    if (cfg.permissions?.profile === p) o.selected = true;
    sel.append(o);
  }
  sel.onchange = async () => {
    await api("settingsSet", { method: "POST", body: { permissions: { profile: sel.value } } });
    toast("Saved. It applies to new sessions.", "good");
  };
  permRow.append(sel);
  mk("Permissions", [permRow]);

  mk("Where things live", [
    el("p", "muted", `Your files: ${cfg.workspace ?? r.config?.workspace ?? ""}`),
    el("p", "muted", `Stored credentials: ${(r.secretsStored ?? []).join(", ") || "none"}`),
  ]);
};

/* Dashboard ------------------------------------------------------------- */
pages.dashboard = async () => {
  const r = await api("dashboard");
  const inner = page(
    "Advanced dashboard",
    "The model gateway has its own full web dashboard — 140-odd pages of providers, analytics and settings. This is the door to it.",
  );
  if (!r.ok) return inner.append(el("p", "muted", r.error));
  const pw = el("div", "card");
  pw.append(el("h3", null, "Your password"));
  pw.append(el("p", "muted", r.note));
  const row = el("div", "row");
  row.style.marginTop = "8px";
  const box = Object.assign(el("input"), { type: "text", value: r.password ?? "(not set)", readOnly: true });
  const copy = el("button", "btn", "Copy");
  copy.onclick = async () => {
    await navigator.clipboard.writeText(r.password ?? "");
    toast("Copied.", "good");
  };
  row.append(box, copy);
  pw.append(row);
  inner.append(pw);

  for (const p of r.pages) {
    const c = el("div", "card");
    const row2 = el("div", "row");
    row2.append(el("span", "grow", p.label));
    const b = el("button", "btn", "Open");
    b.onclick = () => api("dashboard", { query: { page: p.id, open: "1" } });
    row2.append(b);
    c.append(row2);
    inner.append(c);
  }
};

/* ── wiring ────────────────────────────────────────────────────────────── */

function wire() {
  document.querySelectorAll(".seg-btn").forEach(
    (b) =>
      (b.onclick = () => {
        setSurface(b.dataset.surface);
        savePrefs({ surface: b.dataset.surface });
      }),
  );
  document.querySelectorAll(".nav-item").forEach((b) => (b.onclick = () => openPage(b.dataset.page)));
  $("new-session").onclick = () => {
    state.page = null;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    newSession();
  };
  $("toggle-side").onclick = () => $("app").classList.add("collapsed");
  $("show-side").onclick = () => $("app").classList.remove("collapsed");
  $("model-btn").onclick = openModelPicker;
  $("folder-btn").onclick = openFolderPicker;
  $("mode-btn").onclick = openModePicker;
  $("btn-stop").onclick = async () => {
    if (state.sessionID) await ocall("POST", `/api/session/${state.sessionID}/interrupt`, {});
    setBusy(false);
  };
  $("attach-btn").onclick = () =>
    toast("Drop a file into your workspace folder and mention it by name — the agent can read it from there.");

  const t = $("prompt");
  t.addEventListener("input", autosize);
  t.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = t.value;
    t.value = "";
    autosize();
    send(text);
  });
  $("modal-back").addEventListener("mousedown", (e) => {
    if (e.target === $("modal-back")) $("modal-back").hidden = true;
  });
}

async function boot() {
  wire();
  // Preferences first: the surface, the saved model and the Chat/Code tagging
  // all come from disk, and loadModels/renderSessions below depend on them.
  const p = await api("prefsGet");
  const prefs = p.prefs ?? {};
  state.kinds = prefs.kinds ?? {};
  state.mode = MODES[prefs.mode] ? prefs.mode : "auto";
  state.model = prefs.model ?? null;
  state.unhealthy = prefs.unhealthy ?? {};
  setSurface(prefs.surface === "code" ? "code" : "chat");
  $("mode-label").textContent = MODES[state.mode].label;
  const st = await api("status");
  if (!st.agent?.running) toast("The agent server is not running — restart Omni Agent.", "bad");
  await Promise.all([loadModels(), loadSessions(), loadFolders()]);
  refreshUsage();
  setInterval(loadSessions, 20_000);
}

boot();
