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
  // 503 from the proxy means the agent server is not running - it died, or has
  // not started yet. Re-show the startup screen and wait for it to come back
  // (the server restarts it automatically; the screen offers Try again if not).
  if (r.status === 503) recover();
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
  // A 503 (agent down) returns an {error} object, not a list. Storing it made
  // renderSessions throw on .filter and blanked the sidebar with no message;
  // recover() below is what actually brings the agent back.
  const list = r.data?.data ?? r.data;
  state.sessions = Array.isArray(list) ? list : [];
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
    const b = el(
      "button",
      "s-item" +
        (s.id === state.sessionID ? " active" : "") +
        (state.busy && s.id === state.sessionID ? " busy" : ""),
    );
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
  await openSession(id);
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
  // The directory is fetched BEFORE subscribing, because the agent's event bus
  // is scoped per folder: a stream opened without the session's directory
  // receives nothing for a conversation in any folder but the default one.
  // Measured 2026-09-02 - the whole "watch it work" experience was blank for
  // anyone who chose their own folder.
  const d = await ocall("GET", `/session/${id}`);
  if (state.sessionID !== id) return;
  state.sessionFolder = d.data?.directory ?? null;
  paintFolder();
  await refreshMessages();
  subscribe(id, state.sessionFolder);
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
  liveReset();
  box.replaceChildren();
  if (!list.length) {
    box.append(emptyState());
    return;
  }
  // A turn is a user message and the assistant messages that answer it. Its
  // end is where "what did that change?" and "is it finished?" get answered.
  let turn = null;
  for (const m of list) {
    const role = roleOf(m);
    if (role === "user") {
      finishTurn(turn);
      turn = { user: m, assistantBody: null, assistantInfo: null, parts: [] };
    }
    const wrap = el("div", `msg ${role === "user" ? "user" : "assistant"}`);
    wrap.append(el("div", "role", role === "user" ? "You" : "Omni Agent"));
    const body = el("div", "body");
    if (role !== "user" && turn) {
      turn.assistantBody = body;
      turn.assistantInfo = m.info ?? m;
      turn.parts.push(...partsOf(m));
    }

    for (const part of partsOf(m)) {
      if (part.type === "file") {
        // An attached file, shown as the chip the reader attached rather than
        // as machinery.
        const chip = el("span", "attachment");
        chip.append(el("b", null, part.filename ?? "file"));
        chip.append(el("small", null, "attached"));
        body.append(chip);
      } else if (part.synthetic) {
        // OpenCode expands an attachment into "Called the Read tool with…" and
        // an <path>…</path> block, and marks both `synthetic`. Useful to the
        // model, nonsense above the reader's own message - it reads as though
        // THEY called a tool.
        continue;
      } else if (part.type === "text" && part.text) {
        body.append(renderMarkdownish(part.text));
      } else if (part.type === "reasoning" && part.text) {
        // Hidden unless asked for. A reasoning block is longer than the answer
        // it precedes, so leaving it in the transcript buries the thing the
        // reader came for. Ctrl+O brings it back - see toggleReasoning.
        if (!state.showReasoning) continue;
        const d = el("details", "tool reasoning");
        d.append(el("summary", null, "Thinking"));
        d.append(Object.assign(el("pre"), { textContent: part.text }));
        body.append(d);
      } else if (part.type === "tool" || part.tool) {
        const d = el("details", "tool");
        const sum = el("summary");
        paintToolSummary(sum, part);
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
    if (err && (err.name === "MessageAbortedError" || /aborted/i.test(String(err.data?.message ?? err.message ?? err.name ?? "")))) {
      // The reader pressed Stop. Not a failure, and never a reason to blame the
      // model or offer "choose a different one".
      body.append(el("p", "turn-end", "Stopped by you"));
    } else if (err) {
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
  finishTurn(turn);
  watchThreadScroll();
  scrollToEnd();
}

/* ── what a turn did ───────────────────────────────────────────────────── */

const baseOf = (p) => (p ? (String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p)) : "");
const hostOf = (u) => {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, "");
  } catch {
    return String(u ?? "");
  }
};

/**
 * A tool call as a sentence: "Editing index.html", "Running: npm test".
 *
 * The raw tool name and its JSON stay inside the disclosure for anyone who
 * wants them. A beginner should never have to decode `bash` or
 * `{"filePath": ...}` to know what just happened to their files.
 */
function describeTool(name, input = {}) {
  const file = input.filePath ?? input.path ?? input.file ?? input.output ?? null;
  switch (String(name)) {
    case "read":
      return ["Reading", baseOf(file)];
    case "write":
      return ["Writing", baseOf(file)];
    case "edit":
    case "patch":
    case "multiedit":
      return ["Editing", baseOf(file)];
    case "bash":
      return ["Running", input.description || input.command || "a command"];
    case "glob":
    case "grep":
    case "list":
      return ["Looking through the files", input.pattern ?? baseOf(file)];
    case "webfetch":
    case "web_fetch":
      return ["Reading a web page", hostOf(input.url)];
    case "websearch":
    case "web_search":
      return ["Searching the web", input.query ?? ""];
    case "web_scrape":
      return ["Reading a website", hostOf(input.url)];
    case "browser":
      return ["Using the browser", input.action ? String(input.action) + (input.url ? " " + hostOf(input.url) : "") : ""];
    case "document_read":
      return ["Reading a document", baseOf(file)];
    case "document_write":
      return ["Writing a document", baseOf(file)];
    case "data_analyze":
      return ["Analysing the data", baseOf(file)];
    case "todowrite":
    case "todoread":
      return ["Planning the steps", ""];
    case "task":
      return ["Working on a sub-task", input.description ?? ""];
    case "skill":
      return ["Using a skill", input.name ?? ""];
    case "question":
      return ["Asking you a question", ""];
    case "agent_status":
      return ["Checking the model and usage", ""];
    case "gateway":
      return ["Talking to the model gateway", input.action ?? ""];
    default:
      return [String(name).replace(/[_-]+/g, " "), ""];
  }
}

/** Fill a tool block summary line: what it is doing, to what, and whether it is done. */
function paintToolSummary(sum, part) {
  const name = part.tool ?? part.name ?? "tool";
  const status = part.state?.status ?? part.status;
  const [verb, what] = describeTool(name, part.state?.input ?? part.input ?? {});
  sum.replaceChildren();
  sum.title = name;
  sum.append(el("span", "tool-verb", verb));
  if (what) sum.append(el("span", "tool-what", String(what)));
  const running = status === "running" || status === "pending";
  const failed = status === "error";
  sum.append(el("span", "muted status" + (failed ? " failed" : ""), running ? "working…" : failed ? "failed" : "done"));
}

/**
 * The files a turn touched.
 *
 * OpenCode writes a diff summary onto the USER message once the turn settles
 * (`info.summary.diffs`, with before/after and line counts), and that is the
 * authority. The tool calls are the fallback for a turn whose summary has not
 * landed yet - and never a second opinion on a file the summary covers.
 */
function changesOf(turn) {
  const out = new Map();
  const summary = turn.user?.info?.summary ?? turn.user?.summary;
  for (const d of summary?.diffs ?? []) {
    const file = d.file ?? d.path ?? d.filename;
    if (!file) continue;
    const kind = d.before === "" ? "new" : d.after === "" ? "gone" : "changed";
    out.set(file, { file, kind, additions: d.additions, deletions: d.deletions });
  }
  for (const p of turn.parts) {
    if (p.type !== "tool") continue;
    if ((p.state?.status ?? p.status) !== "completed") continue;
    const input = p.state?.input ?? p.input ?? {};
    const file = input.filePath ?? input.path ?? input.output;
    if (!file || out.has(file)) continue;
    const name = p.tool ?? p.name;
    if (name === "write" || name === "document_write") out.set(file, { file, kind: "new" });
    else if (name === "edit" || name === "patch" || name === "multiedit") out.set(file, { file, kind: "changed" });
  }
  return [...out.values()];
}

function changesCard(diffs) {
  const card = el("div", "changes");
  card.append(el("h4", null, diffs.length === 1 ? "1 file changed" : `${diffs.length} files changed`));
  const ul = el("ul");
  for (const d of diffs) {
    const li = el("li");
    li.append(el("span", "kind " + d.kind, d.kind === "new" ? "new" : d.kind === "gone" ? "deleted" : "changed"));
    li.append(el("b", null, baseOf(d.file)));
    const where = el("span", "where", String(d.file));
    where.title = String(d.file);
    li.append(where);
    if (d.additions != null || d.deletions != null) li.append(el("span", "muted", `+${d.additions ?? 0} \u2212${d.deletions ?? 0}`));
    ul.append(li);
  }
  card.append(ul);
  // Where it all is, and a button that opens it - the answer to "where did it
  // put my project?" without a path having to be understood or typed.
  const folder = activeFolder();
  const row = el("div", "row");
  const where = el("span", "muted grow", folder ? `in ${folder}` : "");
  where.title = folder ?? "";
  row.append(where);
  if (folder) {
    const open = el("button", "btn", "Open folder");
    open.onclick = async () => {
      const r = await api("openFolder", { method: "POST", body: { path: folder } });
      if (r.ok === false) toast(r.error, "bad");
    };
    row.append(open);
  }
  card.append(row);
  return card;
}

const fmtSecs = (s) => (s >= 90 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s}s`);

/** Close a turn: what it changed, and that it finished. */
function finishTurn(turn) {
  if (!turn?.assistantBody) return;
  const diffs = changesOf(turn);
  if (diffs.length) turn.assistantBody.append(changesCard(diffs));
  const info = turn.assistantInfo ?? {};
  const started = turn.user?.info?.time?.created ?? turn.user?.time?.created;
  const done = info.time?.completed;
  // A turn that errored already carries its own explanation and a way out
  // (see the error block above); a turn still running has no end to state.
  if (!done || info.error) return;
  const secs = started ? Math.max(1, Math.round((done - started) / 1000)) : null;
  turn.assistantBody.append(el("p", "turn-end", secs ? `Finished in ${fmtSecs(secs)}` : "Finished"));
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

/* ── following the bottom ──────────────────────────────────────────────── */

/**
 * Whether new content should pull the view down with it.
 *
 * Starts true and is only turned off when the reader deliberately scrolls UP.
 *
 * ⚠️ The obvious alternative - measuring "am I near the bottom?" each time
 * something arrives - is subtly broken, and this app had it. A conversation
 * with any history starts far from the bottom, so the answer is always "no"
 * and the view never follows the answer being written. Measured in creator-os
 * as 1141px from the bottom, unchanged, for an entire turn.
 */
let stickToBottom = true;

function scrollToEnd(force = false) {
  const box = $("messages");
  if (!box || (!force && !stickToBottom)) return;
  // `auto`, never smooth: a smooth scroll re-triggered on every token restarts
  // before it arrives, so the view lags behind the text and drifts.
  box.scrollTo({ top: box.scrollHeight, behavior: "auto" });
}

function watchThreadScroll() {
  const box = $("messages");
  if (!box || box.dataset.watched) return;
  box.dataset.watched = "1";
  box.addEventListener(
    "scroll",
    () => {
      stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    },
    { passive: true },
  );
}

/* ── live updates ──────────────────────────────────────────────────────── */

/**
 * The turn currently being written into.
 *
 * ⭐ Rendering here is SURGICAL, not wholesale. Re-rendering the transcript on
 * every event - which is what this used to do - restarts every fade animation
 * on every frame and makes the text strobe, so the assistant turn is built
 * once and streamed into.
 */
const live = { messageID: null, turn: null, body: null, parts: new Map() };

function liveReset() {
  live.messageID = null;
  live.turn = null;
  live.body = null;
  live.parts.clear();
}

/** The assistant bubble being streamed into, created on first content. */
function liveTurn(messageID) {
  if (live.turn?.isConnected && live.messageID === messageID) return live.turn;
  liveReset();
  const box = $("messages");
  box.querySelector(".empty")?.remove();
  const wrap = el("div", "msg assistant writing");
  wrap.append(el("div", "role", "Omni Agent"));
  const body = el("div", "body");
  // Announced as it is written, not re-read from the top on every token.
  body.setAttribute("aria-live", "polite");
  wrap.append(body);
  box.append(wrap);
  Object.assign(live, { messageID, turn: wrap, body });
  watchThreadScroll();
  scrollToEnd(true);
  return wrap;
}

/** The node a streaming text part writes into. */
function liveTextPart(messageID, partID) {
  const known = live.parts.get(partID);
  if (known?.isConnected) return known;
  liveTurn(messageID);
  const node = el("div", "stream-text");
  live.body.append(node);
  live.parts.set(partID, node);
  return node;
}

/**
 * A tool call, updated in place as it runs.
 *
 * Keyed by part id so `pending → running → completed` reuses one block instead
 * of stacking three, and so the reader's expand/collapse survives the update.
 */
function liveToolPart(messageID, part) {
  liveTurn(messageID);
  let d = live.parts.get(part.id);
  if (!d?.isConnected) {
    d = el("details", "tool");
    d.append(el("summary"));
    live.body.append(d);
    live.parts.set(part.id, d);
  }
  const status = part.state?.status ?? part.status;
  paintToolSummary(d.querySelector("summary"), part);
  d.classList.toggle("running", status === "running" || status === "pending");
  const detail = part.state?.output ?? part.state?.input ?? part.output ?? part.input;
  let pre = d.querySelector("pre");
  if (detail != null) {
    if (!pre) {
      pre = el("pre");
      d.append(pre);
    }
    pre.textContent = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
  }
  scrollToEnd();
}

/** Settle the streamed turn against what the server actually stored. */
function endTurn() {
  live.turn?.classList.remove("writing");
  setBusy(false);

  // A model that refused is worth one more try on a different model, because on
  // a keyless install the offered catalogue includes models that need a key and
  // nothing publishes which. The failed model is already recorded by the
  // renderer, so each attempt narrows the field rather than guessing again.
  // Partial text means the model DID answer and merely stopped; swapping models
  // and re-asking would throw away what the reader already has.
  const gotText = !!live.body?.querySelector(".stream-text")?.textContent?.trim();
  if (inFlight?.error && isModelFailure(inFlight.error, gotText)) {
    const err = inFlight.error;
    inFlight.error = null;
    if (retryOnAnotherModel()) return;
    toast(`No model would answer: ${String(err?.data?.message ?? err?.message ?? err).slice(0, 120)}`, "bad");
  } else if (gotText && !inFlight?.error && inFlight?.tries > 0 && state.model) {
    // The retry worked. NOW remember the model that answered - never the one
    // that failed - so the next conversation opens on something that works.
    savePrefs({ model: state.model });
  }
  // `inFlight` is deliberately NOT cleared here. endTurn runs for BOTH
  // session.error and session.idle, so the idle that follows a failure would
  // otherwise wipe the retry's own bookkeeping the moment it started - and the
  // retry's failure would then have nowhere to record itself. It is replaced
  // wholesale by the next send, and its `error` is consumed above.
  // One authoritative re-render: the streamed text is deliberately literal, and
  // this is what turns it into rendered markdown - the same trade creator-os
  // makes. It also flattens the hundreds of per-fragment spans, which make
  // selection and scrolling gritty once the animation is over.
  scheduleRefresh();
  refreshUsage();
  loadSessions();
  // A full re-render drops focus to <body>, so the next message would need a
  // click before it could be typed.
  $("prompt")?.focus();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshMessages();
    checkPermissions();
  }, 150);
}

/**
 * Subscribe to the agent's event stream.
 *
 * ⚠️ The GLOBAL `/event`, filtered by session id - not `/api/session/{id}/event`,
 * which this app used to subscribe to. Measured 2026-08-28: that route never
 * sends response headers at all. The EventSource sat there forever, no event
 * ever arrived, and the transcript only ever updated when the send request
 * finally returned - which is exactly why answers landed in one lump instead
 * of streaming.
 */
function subscribe(sessionID, directory) {
  state.stream?.close();
  // Scoped to the conversation's folder. The agent publishes streaming tokens,
  // tool calls and permission requests onto a bus keyed by directory; without
  // this the stream is silent for every folder but the default one, and a
  // permission prompt never reaches the page, so the agent waits forever.
  const qs = new URLSearchParams({ t: TOKEN });
  if (directory) qs.set("directory", directory);
  const es = new EventSource(`/oc/event?${qs.toString()}`);
  state.stream = es;
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    const t = ev.type ?? "";
    const q = ev.properties ?? ev.data ?? {};
    // The stream is global, so everything for another conversation is noise.
    if (q.sessionID && q.sessionID !== state.sessionID) return;

    if (t === "message.part.delta") {
      // Deltas are INCREMENTAL fragments, and they only ever belong to an
      // assistant text part - the user's own part is complete when created and
      // never gets one. That is what makes it safe to open a live turn here
      // without first working out whose message this is.
      if (q.field !== "text" || typeof q.delta !== "string") return;
      setBusy("streaming");
      const node = liveTextPart(q.messageID, q.partID);
      // One span per fragment: this is what produces the fade as it is written.
      node.append(el("span", "tok", q.delta));
      scrollToEnd();
      return;
    }

    if (t === "message.part.updated" && q.part) {
      if (q.part.type === "tool") {
        setBusy("streaming");
        liveToolPart(q.part.messageID, q.part);
      }
      return;
    }

    if (t === "session.error") {
      // Kept, not acted on here: the turn is not over until session.idle, and
      // deciding to retry before then would race the transcript.
      if (inFlight) inFlight.error = q.error ?? q;
      endTurn();
      return;
    }
    if (t === "session.idle") {
      endTurn();
      return;
    }
    if (t.includes("permission") || t.includes("question")) checkPermissions();
    // Anything else only matters when nothing is being written; mid-stream a
    // re-render would destroy the turn being streamed into.
    if (t.startsWith("session.") && !live.turn) scheduleRefresh();
  };
  es.onerror = () => {
    /* EventSource reconnects on its own; a closed session simply stops. */
  };
}

/**
 * Busy has two states and conflating them is what makes a working app look
 * frozen: `sending` is "the request is in flight and unacknowledged",
 * `streaming` is "the server has it and is answering".
 */
function setBusy(kind) {
  state.busy = kind || false;
  const on = !!kind;
  $("btn-stop").hidden = !on;
  $("send").disabled = on;
  $("btn-stop").title = kind === "sending" ? "Cancel" : "Stop the agent";
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

/**
 * Did the turn fail in a way another model might survive?
 *
 * ⭐ ANY error, unless the reader caused it. This started as a list of status
 * codes and that was the wrong shape: three consecutive attempts on a clean
 * keyless install produced three DIFFERENT failures -
 *   [401] Model north-mini-code-free is not supported ... invalid_api_key
 *   [502] fetch failed                     (gateway could not reach it)
 *   [418] DuckDuckGo anti-abuse challenge failed: ERR_BN_LIMIT
 * - and each time the enumeration had to grow. Predicting the taxonomy of a
 * free model pool is a losing game.
 *
 * The reader's question is not "which code was it" but "did I get an answer".
 * So: an errored turn that produced no text is a model that did not answer,
 * whatever it called itself. The exclusions are the cases where trying a
 * different model would be wrong or rude - the reader pressed stop, or the
 * model did answer and merely stopped early.
 */
function isModelFailure(err, gotText = false) {
  if (!err) return false;
  if (gotText) return false;
  const msg = String(err?.data?.message ?? err?.message ?? err?.name ?? err ?? "");
  if (/abort|cancell?ed|stopped by (the )?user/i.test(msg)) return false;
  return true;
}

/**
 * The next model worth trying after one has refused.
 *
 * ⚠️ Concrete models only, never an `auto/` combo. A combo resolves to some
 * other model at request time, so when it fails we cannot tell WHICH model
 * refused - recording the combo as unhealthy blames the wrong thing and would
 * blacklist a router that works perfectly well next time. It is also how this
 * bug presented: the default `auto/coding` resolved to a gated model and the
 * first message of every fresh keyless install died on it.
 */
function nextModel(exclude = []) {
  const bad = new Set([...Object.keys(state.unhealthy), ...exclude]);
  // The vendor is the first segment of the model id - `ddgw/gpt-5.4-nano`,
  // `oc/north-mini-code-free` - because the gateway serves every vendor under
  // one provider id of its own.
  const vendor = (id) => (id.includes("/") ? id.slice(0, id.indexOf("/")) : id);
  const spent = new Set([...bad].map((k) => vendor(k.slice(k.indexOf("/") + 1))));

  // Two passes. The first refuses to try a vendor that has already failed this
  // turn, because the interesting failures are per-VENDOR, not per-model:
  // measured, a rate-limited DuckDuckGo returned the identical
  // "[418] anti-abuse challenge failed: ERR_BN_LIMIT" for two different models
  // in a row, so the second attempt was spent before it was made. The second
  // pass drops that preference rather than giving up entirely.
  for (const strict of [true, false]) {
    for (const p of state.models) {
      for (const m of p.models) {
        if (m.id.startsWith("auto/") || !m.free) continue;
        if (bad.has(`${p.id}/${m.id}`)) continue;
        if (strict && spent.has(vendor(m.id))) continue;
        return { providerID: p.id, id: m.id, name: m.name };
      }
    }
  }
  return null;
}

/** What is in flight, so a model refusal can be retried with another model. */
let inFlight = null;

/** POST the message. Split out of send() so a retry does not re-create anything. */
function postMessage(id, text, extra) {
  const files = extra?.parts ?? [];
  const body = { agent: agentFor(), parts: [...files, { type: "text", text: text + (extra?.note ?? "") }] };
  if (state.model) body.model = { providerID: state.model.providerID, modelID: state.model.id };
  setBusy("sending");
  // Sending is an explicit "show me the answer": follow it wherever the view
  // happened to be, and keep following until the reader scrolls away.
  stickToBottom = true;
  scheduleRefresh();

  // Deliberately not awaited for rendering: this route only returns once the
  // whole reply is finished, and the transcript should fill in as it arrives.
  ocall("POST", `/session/${id}/message`, body)
    .then((r) => {
      if (!r.ok) toast(r.data?.message ?? `The agent could not answer (${r.status})`, "bad");
      // `session.idle` normally settles the turn well before this resolves.
      // This is the backstop for a model that streamed nothing at all.
      endTurn();
    })
    .catch((e) => {
      setBusy(false);
      toast(e.message, "bad");
    });
}

/**
 * Try the same question again on a different model.
 *
 * Bounded at two retries: past that the free pool is refusing generally rather
 * than this one model being gated, and silently working through a hundred
 * models would spend the user's time without telling them anything.
 */
function retryOnAnotherModel() {
  if (!inFlight || inFlight.tries >= 2) return false;
  // Never resurrect a prompt from a conversation the reader has since left.
  if (inFlight.id !== state.sessionID) return false;
  const failed = state.model ? `${state.model.providerID}/${state.model.id}` : null;
  const next = nextModel(failed ? [failed, ...inFlight.tried] : inFlight.tried);
  if (!next) return false;

  const was = modelName();
  inFlight.tries += 1;
  if (failed) inFlight.tried.push(failed);
  state.model = { providerID: next.providerID, id: next.id };
  // NOT persisted here: this model has not answered yet, and saving it made a
  // fresh install remember a model that had just FAILED, so the next
  // conversation opened on it and failed the same way. endTurn persists the
  // model that actually produces an answer instead.
  paintModel();
  toast(`${was} would not answer. Retrying with ${next.name}.`);
  setSessionModel(inFlight.id, state.model).finally(() =>
    postMessage(inFlight.id, inFlight.text, inFlight.extra),
  );
  return true;
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
  // Resolved once and kept on `inFlight`: a retry must send the SAME files,
  // and the chips are cleared below so a second message does not re-send them.
  const extra = attachmentParts();
  attachments = [];
  paintAttachments();
  inFlight = { id, text, extra, tries: 0, tried: [], error: null };
  postMessage(id, text, extra);

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

/**
 * The model list, which is not necessarily there when the page first loads.
 *
 * The gateway takes up to a minute on a cold first run, and this used to be
 * fetched exactly once at boot - so a page that opened first showed "No models
 * available yet" permanently, and only a manual reload fixed it. Retried until
 * the catalogue arrives.
 */
async function loadModels(retries = 10) {
  const r = await api("models");
  state.models = r.providers ?? [];
  state.connections = r.connections ?? [];
  state.connectionsKnown = r.connectionsKnown === true;
  if (!state.models.length && retries > 0) {
    paintModel();
    setTimeout(() => loadModels(retries - 1), 3000);
    return;
  }
  const pref = state.models.find((p) => p.preferred) ?? state.models[0];
  const saved = state.model;
  const known = (m) =>
    m && state.models.some((p) => p.id === m.providerID && p.models.some((x) => x.id === m.id));
  // A model that has already failed on this machine is not a good place to
  // start the next conversation - measured 2026-09-02, a fresh install opened
  // its second project on the model that had just failed the first.
  const healthy = (m) => m && !state.unhealthy[`${m.providerID}/${m.id}`];
  // Order matters: what the user chose, then what setup configured, then the
  // provider's own default, then anything. The provider default is third
  // because it is not chosen with chat in mind.
  // A model the setup wizard actually got an answer from on this machine beats
  // anything published, and it is the reason a fresh install's first message no
  // longer fails. Only consulted when the user has not chosen for themselves.
  const verified = state.verifiedModel
    ? state.models
        .flatMap((p) => p.models.map((m) => ({ providerID: p.id, id: m.id })))
        .find((m) => m.id === state.verifiedModel)
    : null;
  if (known(saved) && healthy(saved)) state.model = saved;
  else if (verified && healthy(verified)) state.model = verified;
  else if (r.configured) state.model = r.configured;
  else if (known(saved)) state.model = saved;
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

/* -- reasoning ----------------------------------------------------------- */

/**
 * Show or hide the model's thinking. Ctrl+O.
 *
 * Off by default and remembered. Reasoning is usually several times longer than
 * the answer, so shown by default it pushes the answer off the screen - and it
 * is the answer, not the deliberation, that the reader asked for. Ctrl+O
 * because Ctrl+R reloads the page and Ctrl+T opens a tab.
 */
function toggleReasoning() {
  state.showReasoning = !state.showReasoning;
  savePrefs({ showReasoning: state.showReasoning });
  toast(state.showReasoning ? "Showing the model's thinking. Ctrl+O hides it." : "Thinking hidden. Ctrl+O shows it.");
  // Re-render from what the server stored: hidden reasoning is dropped at
  // render time, so the only way back is to render again.
  refreshMessages();
}

/* -- files given to the agent -------------------------------------------- */

/**
 * Files the next message should carry.
 *
 * Two mechanisms, decided per file by the server (see `describeFile`): a text
 * file small enough to inline is sent as a real `file` part, which puts its
 * CONTENTS in front of the model with no tool call; anything else has its path
 * named in the message so the agent opens it with its own readers.
 *
 * Before this, the + button showed a toast telling the reader to go and put the
 * file in the workspace folder themselves. That is not attaching a file.
 */
let attachments = [];

function paintAttachments() {
  const box = $("attachments");
  box.replaceChildren();
  box.hidden = attachments.length === 0;
  for (const f of attachments) {
    const chip = el("span", "attachment");
    chip.append(el("b", null, f.name));
    chip.append(el("small", null, f.why));
    const x = el("button", "attachment-x", "\u00d7");
    x.type = "button";
    x.title = `Remove ${f.name}`;
    x.onclick = () => {
      attachments = attachments.filter((a) => a.path !== f.path);
      paintAttachments();
    };
    chip.append(x);
    box.append(chip);
  }
}

function addAttachments(files) {
  const seen = new Set(attachments.map((a) => a.path));
  for (const f of files ?? []) {
    if (!seen.has(f.path)) attachments.push(f);
  }
  paintAttachments();
}

/**
 * The + button: the Windows file dialog, or a pasted path.
 *
 * Both, because a browser cannot hand the server a real path and a native
 * dialog is the only way to get one - and because when that dialog misbehaves,
 * as it did for the whole of 1.1.2, a typed path is the only way through.
 */
function openFilePicker(e) {
  const box = el("div", "pop-search-wrap");
  box.append(el("div", "pop-head", "Give the agent a file"));

  const pick = el("button", "pop-item primary");
  pick.append(document.createTextNode("Choose files\u2026"));
  pick.append(el("small", null, "opens the Windows file picker"));
  pick.onclick = async () => {
    pick.disabled = true;
    pick.replaceChildren(document.createTextNode("Waiting for the file picker\u2026"));
    const r = await api("filePick", { method: "POST" });
    $("pop-model").hidden = true;
    if (r.ok === false) return toast(r.error, "bad");
    if (!r.cancelled) addAttachments(r.files);
  };
  box.append(pick);

  const typed = Object.assign(el("input", "pop-search"), {
    type: "text",
    placeholder: "\u2026or paste a file path and press Enter",
    autocomplete: "off",
  });
  typed.onkeydown = async (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const v = typed.value.trim();
    if (!v) return;
    const r = await api("fileDescribe", { method: "POST", body: { paths: [v] } });
    if (r.ok === false) return toast(r.error, "bad");
    addAttachments(r.files);
    $("pop-model").hidden = true;
  };
  box.append(typed);

  popover(e.currentTarget, box);
}

/**
 * The parts and the extra prompt text a message needs to carry its files.
 *
 * Named paths go in the text rather than a part because there is no part type
 * for "look at this yourself" - the agent has to be told, in words, which files
 * to open.
 */
function attachmentParts() {
  const parts = [];
  const named = [];
  for (const f of attachments) {
    if (f.inline) {
      parts.push({
        type: "file",
        mime: f.mime,
        filename: f.name,
        url: "file://" + f.path.replace(/\\/g, "/"),
      });
    } else {
      named.push(f.path);
    }
  }
  const note = named.length
    ? `\n\nUse these files, reading them yourself:\n${named.map((p) => "- " + p).join("\n")}`
    : "";
  return { parts, note };
}

/* -- the working folder -───────────────────────────────────────────────── */

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

  // The escape hatch, and it earns its place: when the dialog misbehaves - it
  // opened behind the app for the whole of 1.1.2 - a typed path is the only way
  // through, and a pasted path from Explorer is faster than browsing anyway.
  const typed = Object.assign(el("input", "pop-search"), {
    type: "text",
    placeholder: "…or paste a folder path and press Enter",
    autocomplete: "off",
  });
  typed.onkeydown = async (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const v = typed.value.trim();
    if (v) await chooseFolder(v);
  };
  box.append(typed);

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

  // Three views of the same list, because "every model" and "the models my key
  // unlocked" are different questions and the second one had no answer at all:
  // the gateway serves everything under one provider id, so a key's models were
  // simply mixed into the same 115 rows with nothing to distinguish them.
  //
  // The split is on the gateway's connection list, NOT on price. A free-tier
  // key - Mistral's, Cerebras', GitHub Models' - costs nothing per token, so
  // splitting on cost put exactly the models the reader had just added under
  // "Free" and left this lens empty. Free means "here without an account";
  // From your keys means "here because you added one".
  let lens = "all";
  const lensRow = el("div", "pop-lens");
  const lensBtn = (id, label) => {
    const b = el("button", "pop-tab" + (lens === id ? " on" : ""), label);
    b.onclick = () => {
      lens = id;
      paint();
    };
    return b;
  };

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    results.replaceChildren();
    lensRow.replaceChildren(lensBtn("all", "All"), lensBtn("free", "Free"), lensBtn("keys", "From your keys"));
    if (!state.models.length) {
      // Almost always the gateway still warming up rather than a machine with
      // no models, and saying "none" invites the reader to go looking for a
      // problem that will fix itself. loadModels keeps retrying behind this.
      results.append(el("div", "pop-head", "Still starting the model gateway…"));
      results.append(el("div", "pop-note", "The first run can take a minute. This fills in on its own."));
      return;
    }
    let shown = 0;
    for (const p of state.models) {
      const hits = p.models.filter((m) => {
        if (lens === "free" && (!m.free || m.fromKey)) return false;
        if (lens === "keys" && !m.fromKey) return false;
        if (!q) return true;
        return (
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (m.vendor ?? "").toLowerCase().includes(q)
        );
      });
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
        if (m.fromKey) bits.push(m.vendor ? `from your ${m.vendor} key` : "from a key you added");
        else if (m.free) bits.push("free");
        if (m.vendor && !m.fromKey) bits.push(m.vendor);
        if (m.context) bits.push(fmtNum(m.context) + " context");
        if (bits.length) b.append(el("small", null, bits.join(" · ")));
        if (bad) b.classList.add("unhealthy");
        b.onclick = () => choose(p, m);
        results.append(b);
        shown++;
      }
    }
    if (!shown) {
      results.append(el("div", "pop-head", "Nothing matches that"));
      if (lens === "keys") {
        results.append(
          el(
            "div",
            "pop-note",
            state.connectionsKnown
              ? "Nothing here yet. Add a provider key in Providers and its models appear in this list."
              : "The gateway did not answer when asked which keys are connected, so this view may be missing models.",
          ),
        );
      } else if (q) {
        // Naming the route rather than leaving a dead end: a model that is not
        // in the catalogue is not broken, it is unpaid for.
        results.append(
          el("div", "pop-note", `No model called "${search.value.trim()}" is available yet. Adding the provider's key in Providers puts its models in this list.`),
        );
      }
    }
  };

  box.insertBefore(lensRow, results);
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

  const toolIds = tools.map((t) => (typeof t === "string" ? t : (t.id ?? t.name))).filter(Boolean);
  // A connection's tools are namespaced by its name, so they can be attributed
  // back to it. The separator is not guaranteed to be an underscore, hence the
  // character class rather than a hard-coded "_".
  const toolsOf = (name) => toolIds.filter((id) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z0-9]`, "i").test(id));
  const mcpToolIds = new Set(mcp.flatMap((sv) => toolsOf(sv.name)));
  const builtIn = toolIds.filter((id) => !mcpToolIds.has(id));

  const c1 = el("div", "card");
  c1.append(el("h3", null, `Built-in tools (${builtIn.length})`));
  c1.append(el("p", "muted", builtIn.join(" · ") || "None reported."));
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
    const rm = el("button", "btn", "Remove");
    rm.onclick = async () => {
      const res = await api("mcpRemove", { method: "POST", body: { name: s.name } });
      toast(res.ok ? `${s.name} removed. It stops after the next restart.` : res.error, res.ok ? "good" : "bad");
      if (res.ok) openPage("tools");
    };
    line.append(rm);
    c3.append(line);
    // What this connection gave the agent - when it can be known.
    //
    // ⚠️ It usually cannot, and the honest wording matters here. OpenCode's
    // tool inventory (/experimental/tool/ids) does NOT enumerate MCP tools:
    // measured 2026-08-28, adding a server took the list from 24 entries to 24
    // while the agent itself, asked to name its tools, listed thirteen
    // `everything_*` ones it had just been given. Printing "no tools" from that
    // endpoint would say a working connection is broken.
    const mine = toolsOf(s.name);
    c3.append(
      el(
        "p",
        "muted",
        mine.length
          ? `${mine.length} tool${mine.length === 1 ? "" : "s"}: ${mine.join(" · ")}`
          : "Its tools go to the agent directly - ask it what tools it has to see them. They are not in the built-in list above, which does not cover connections.",
      ),
    );
  }
  const addRow = el("div", "row");
  addRow.style.marginTop = "10px";
  const nm = Object.assign(el("input"), { type: "text", placeholder: "Name" });
  const cmd = Object.assign(el("input"), {
    type: "text",
    placeholder: "Command (npx -y @some/mcp-server), or the URL of a remote server",
  });
  const addb = el("button", "btn primary", "Add");
  addb.onclick = async () => {
    const v = cmd.value.trim();
    if (!nm.value.trim() || !v) return toast("A name and a command or URL are needed", "bad");
    // A URL is a remote server, anything else is a command to run. The server
    // wraps whichever it gets in the `config` object OpenCode requires.
    const res = await api("mcpAdd", {
      method: "POST",
      // `^https?:` rather than the full scheme-and-slashes: the page is checked
      // for remote references by pattern, and a literal one here trips it.
      body: /^https?:/i.test(v) ? { name: nm.value.trim(), url: v } : { name: nm.value.trim(), command: v },
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

/* ── starting up ───────────────────────────────────────────────────────── */

/**
 * Hold the page on its startup screen until the gateway and the agent answer.
 *
 * The window opens before either of them is started (see launch.mjs), so for
 * the first half-minute of a cold start there is nothing behind this page. It
 * used to boot regardless: toast "the agent server is not running - restart
 * Omni Agent" at someone who had started it seconds earlier, and fetch the
 * model list into a 503. Now it shows each step as it happens and boots when
 * they are done. A failed step is shown with the one thing the reader can do.
 */
let recovering = false;

/**
 * The agent stopped after the app was already running. Show the startup screen
 * again and wait for it to come back - launch.mjs restarts it automatically,
 * and shows a "Try again" problem if it keeps failing - then reload everything
 * and reopen the conversation the reader was in.
 */
async function recover() {
  if (recovering) return;
  recovering = true;
  try {
    $("startup").hidden = false;
    await waitForReady();
    await Promise.all([loadModels(), loadSessions(), loadFolders()]);
    if (state.sessionID) {
      const id = state.sessionID;
      state.sessionID = null;
      await openSession(id);
    }
  } finally {
    recovering = false;
  }
}

async function waitForReady() {
  const box = $("startup");
  for (;;) {
    let st = null;
    try {
      st = await api("status");
    } catch {
      /* the server is there - the page came from it - so keep asking */
    }
    const s = st?.startup;
    if (s?.ready) {
      box.hidden = true;
      return;
    }
    paintStartup(s);
    await new Promise((r) => setTimeout(r, s?.problem ? 2500 : 800));
  }
}

const STEP_MARKS = { pending: "·", running: "●", done: "✓", failed: "✕" };

function paintStartup(s) {
  const list = $("startup-steps");
  list.replaceChildren();
  const secs = s ? Math.round(s.elapsedMs / 1000) : 0;
  for (const step of s?.steps ?? []) {
    const li = el("li", step.status);
    li.append(el("span", "mark", STEP_MARKS[step.status] ?? STEP_MARKS.pending));
    li.append(el("span", null, step.label));
    // The seconds are the "it is not stuck" signal: a number that keeps
    // changing is the difference between waiting and worrying.
    if (step.status === "running" && secs >= 5) li.append(el("span", "note", `${secs}s`));
    list.append(li);
  }
  $("startup-sub").textContent =
    secs > 90
      ? "Still going. A slow disk or the very first start can take a few minutes."
      : "The first start after installing can take a minute.";

  const prob = $("startup-problem");
  if (!s?.problem) {
    prob.hidden = true;
    return;
  }
  // Repainting the problem on every poll would reset a button the reader has
  // just pressed, so it is drawn once per problem and left alone - except that
  // its buttons follow the retry: disabled while one runs, back when it ends.
  // Without that, a retry that fails the same way left the button dead.
  const key = `${s.problem.title}|${s.problem.detail ?? ""}`;
  if (prob.dataset.key === key && !prob.hidden) {
    for (const b of prob.querySelectorAll("button")) b.disabled = s.retrying === true;
    return;
  }
  prob.dataset.key = key;
  prob.replaceChildren();
  prob.append(el("h3", null, s.problem.title));
  if (s.problem.detail) prob.append(el("p", null, s.problem.detail));
  const acts = el("div", "startup-actions");
  if (s.problem.action === "setup") {
    const go = el("button", "btn primary", s.problem.actionLabel ?? "Finish setup");
    go.onclick = async () => {
      go.disabled = true;
      const r = await api("setupRun", { method: "POST" });
      if (r.ok === false) toast(r.error, "bad");
      else toast("Setup opened in its own window. Come back here when it says it is ready.", "good");
      go.disabled = false;
    };
    acts.append(go);
  }
  const again = el("button", s.problem.action === "setup" ? "btn" : "btn primary", s.problem.action === "setup" ? "I have finished setup" : (s.problem.actionLabel ?? "Try again"));
  again.disabled = s.retrying === true;
  again.onclick = async () => {
    again.disabled = true;
    const r = await api("startupRetry", { method: "POST" });
    if (r.ok === false) {
      toast(r.error, "bad");
      again.disabled = false;
    }
  };
  acts.append(again);
  prob.append(acts);
  prob.hidden = false;
}

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
    if (!state.sessionID) return;
    // The route that actually stops a turn started on the legacy message
    // route. `/api/session/{id}/interrupt` (v2) answers 204 and does nothing to
    // it - measured 2026-09-02: files kept being written after "Stop". `/abort`
    // ends the run with MessageAbortedError within ~1 s. setBusy(false) is NOT
    // called here: the turn is left to settle (session.idle, or the message
    // POST returning) so the button follows what really happened, and the
    // stored MessageAbortedError renders as "Stopped by you".
    const btn = $("btn-stop");
    btn.disabled = true;
    if (inFlight) inFlight.stopped = true;
    const r = await ocall("POST", `/session/${state.sessionID}/abort`, {});
    btn.disabled = false;
    if (!r.ok) toast(`Could not stop the agent (${r.status})`, "bad");
  };
  $("attach-btn").onclick = openFilePicker;

  document.addEventListener("keydown", (e) => {
    // Ctrl+O / Cmd+O, and only when the reader is not typing into something -
    // a shortcut that fires mid-sentence is a shortcut that gets turned off.
    if (e.key !== "o" && e.key !== "O") return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
    e.preventDefault();
    toggleReasoning();
  });

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
  state.verifiedModel = prefs.verifiedModel ?? null;
  state.showReasoning = prefs.showReasoning === true;
  setSurface(prefs.surface === "code" ? "code" : "chat");
  $("mode-label").textContent = MODES[state.mode].label;
  // Nothing below can answer until the gateway and the agent are up, and on
  // a cold start that is half a minute after this page first paints.
  await waitForReady();
  await Promise.all([loadModels(), loadSessions(), loadFolders()]);
  refreshUsage();
  setInterval(loadSessions, 20_000);
}

boot();
