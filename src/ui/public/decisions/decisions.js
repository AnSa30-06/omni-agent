// Decisions: the page.
//
// A second product surface served by the same server as the chat app, with the
// same per-launch token. It is deliberately NOT part of app.js: the unit here
// is a decision queue, not a conversation, and app.js is already 3,000 lines
// with no exports.
//
// The five helpers below (api, $, el, toast, fmtWhen) are copied from app.js
// rather than imported, because that file boots itself on import and exports
// nothing. They are five lines each; sharing them would mean restructuring a
// working file for no benefit.
//
// 🔴 EVERY STRING FROM THE MODEL IS INSERTED WITH textContent. Nothing on this
// page uses innerHTML. The rule is the same one app.js follows and it is not
// negotiable: model output and imported customer names are untrusted text.

const TOKEN = new URL(location.href).searchParams.get("t") ?? "";

async function api(name, { method = "GET", body, query } = {}) {
  const qs = new URLSearchParams({ t: TOKEN, ...(query ?? {}) });
  const r = await fetch(`/x/${name}?${qs}`, {
    method,
    headers: { "content-type": "application/json", "x-omni-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
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
  setTimeout(() => t.remove(), 5600);
}
function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

const state = { status: null, running: false, pollTimer: null, renderToken: 0 };

/**
 * Every view fetches before it paints, so two navigations in quick succession
 * race: the slower response can land after the newer view has already drawn and
 * overwrite it. Each render takes a token and checks it is still the current
 * one before touching the DOM.
 */
function stale(token) {
  return token !== state.renderToken;
}

/* ── small shared pieces ────────────────────────────────────────────────── */

function sevChip(sev) {
  return el("span", `sev ${sev}`, sev);
}

function kindChip(kind) {
  const map = {
    fact: ["fact", "Observed fact"],
    ai: ["ai", "AI interpretation"],
    guess: ["guess", "Hypothesis"],
    rec: ["rec", "Recommendation"],
  };
  const [cls, label] = map[kind] ?? map.fact;
  return el("span", `kind ${cls}`, label);
}

function button(label, cls, onClick) {
  const b = el("button", cls, label);
  b.onclick = onClick;
  return b;
}

function field(parent, label, node, hint) {
  const l = el("label", "f");
  l.append(el("span", null, label), node);
  if (hint) l.append(el("div", "hint", hint));
  parent.append(l);
  return node;
}

function select(options, value) {
  const s = el("select");
  for (const [v, t] of options) {
    const o = el("option", null, t);
    o.value = v;
    if (v === value) o.selected = true;
    s.append(o);
  }
  return s;
}

function modal(title) {
  const m = $("modal");
  m.replaceChildren();
  m.append(el("h3", null, title));
  $("modal-back").hidden = false;
  return m;
}
function closeModal() {
  $("modal-back").hidden = true;
}
function modalActions(m, primaryLabel, onPrimary) {
  const acts = el("div", "modal-actions");
  acts.append(button("Cancel", "btn", closeModal));
  const p = button(primaryLabel, "btn primary", onPrimary);
  acts.append(p);
  m.append(acts);
  return p;
}

function blank(title, message, ctaLabel, onCta) {
  const w = el("div", "blank");
  w.append(el("h3", null, title));
  w.append(el("p", null, message));
  if (ctaLabel) w.append(button(ctaLabel, "btn primary", onCta));
  return w;
}

function skeleton(n = 3) {
  const w = el("div", null);
  for (let i = 0; i < n; i++) w.append(el("div", "skel"));
  return w;
}

function page(titleText, actions = []) {
  $("title").textContent = titleText;
  const acts = $("topbar-actions");
  acts.replaceChildren();
  for (const a of actions) acts.append(a);
  const v = $("view");
  v.replaceChildren();
  const wrap = el("div", "wrap");
  v.append(wrap);
  return wrap;
}

/* ── the decision card ──────────────────────────────────────────────────── */

function decisionCard(d, { onChange } = {}) {
  const c = el("div", `dcard sev-${d.severity}`);

  const row1 = el("div", "row1");
  row1.append(sevChip(d.severity));
  const t = el("button", "dtitle", d.title);
  t.onclick = () => go(`#/decisions/${d.id}`);
  row1.append(t);
  if (d.impactLabel) {
    const imp = el("div", "impact");
    imp.append(el("b", null, d.impactLabel));
    imp.append(document.createTextNode(d.impactBasis ?? ""));
    row1.append(imp);
  }
  c.append(row1);

  if (d.evidence?.length) {
    const ul = el("ul", "ev");
    for (const e of d.evidence) ul.append(el("li", null, e));
    c.append(ul);
  }

  if (d.recommendation) {
    const r = el("div", "rec");
    r.append(el("b", null, "Recommended: "));
    r.append(document.createTextNode(d.recommendation));
    c.append(r);
  }

  const foot = el("div", "foot");
  const bits = [];
  if (d.ageDays != null) bits.push(d.ageDays === 0 ? "raised today" : `raised ${d.ageDays} day${d.ageDays === 1 ? "" : "s"} ago`);
  bits.push(d.owner ? `owner: ${d.owner}` : "no owner yet");
  if (d.status !== "new") bits.push(d.statusLabel.toLowerCase());
  if (d.snoozedUntil) bits.push(`back on ${d.snoozedUntil}`);
  foot.append(el("span", "meta", bits.join(" · ")));

  if (d.overdueDays != null) {
    const o = el("span", "sev high", `You have not handled this yet — ${d.overdueDays} day${d.overdueDays === 1 ? "" : "s"} overdue`);
    foot.append(o);
  }
  if (d.signalsEased) foot.append(el("span", "tag warn", "signals eased"));
  if (d.ruleOnly) foot.append(el("span", "tag", "no AI explanation"));

  foot.append(el("span", "grow"));

  if (["new", "accepted", "in_progress", "waiting", "snoozed"].includes(d.status)) {
    foot.append(button("Handle", "btn primary", () => go(`#/decisions/${d.id}`)));
    foot.append(button("Snooze", "btn", () => snoozeDialog(d, onChange)));
    foot.append(button("Dismiss", "btn danger", () => dismissDialog(d, onChange)));
  } else {
    foot.append(button("Open", "btn", () => go(`#/decisions/${d.id}`)));
  }
  c.append(foot);
  return c;
}

/* ── dialogs ────────────────────────────────────────────────────────────── */

function snoozeDialog(d, onChange) {
  const m = modal("Snooze this decision");
  m.append(el("p", "note", "It comes back on the date you choose, and it wakes up early if the situation gets worse."));
  const today = state.status?.asOf ?? new Date().toISOString().slice(0, 10);
  const plus = (n) => {
    const x = new Date(today + "T00:00:00Z");
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const when = field(m, "Bring it back on", Object.assign(el("input"), { type: "date", value: plus(7) }));
  const quick = el("div", "pill-row");
  for (const [label, days] of [["In 3 days", 3], ["In a week", 7], ["In a month", 30]]) {
    quick.append(button(label, "btn", () => (when.value = plus(days))));
  }
  m.append(quick);
  modalActions(m, "Snooze", async () => {
    const r = await api("decisionsSnooze", { method: "POST", body: { id: d.id, until: when.value } });
    if (!r.ok) return toast(r.error, "bad");
    closeModal();
    toast(`Snoozed until ${when.value}.`, "good");
    onChange?.();
  });
}

function dismissDialog(d, onChange) {
  const m = modal("Dismiss this decision");
  m.append(
    el(
      "p",
      "note",
      "It will not be raised again for two weeks unless the situation gets worse. Your reason is kept, and the AI is shown it next time so it does not repeat itself.",
    ),
  );
  const why = field(m, "Why are you dismissing it?", Object.assign(el("textarea", "field"), { placeholder: "We already know about this, the customer is mid-migration." }));
  modalActions(m, "Dismiss", async () => {
    const r = await api("decisionsDismiss", { method: "POST", body: { id: d.id, reason: why.value } });
    if (!r.ok) return toast(r.error, "bad");
    closeModal();
    toast("Dismissed.");
    onChange?.();
  });
}

function resolveDialog(d, outcomes, onChange) {
  const m = modal("Record what happened");
  m.append(el("p", "note", "This is the part that makes the next decision better. Say what actually happened."));
  const result = field(m, "Outcome", select(Object.entries(outcomes), "renewed"));
  const note = field(m, "Notes (optional)", Object.assign(el("textarea", "field"), { placeholder: "Ran a technical review; they had a broken integration and we fixed it." }));
  const arr = field(m, "Their ARR now (optional)", Object.assign(el("input"), { type: "number", placeholder: "" }));
  modalActions(m, "Resolve", async () => {
    const r = await api("decisionsResolve", {
      method: "POST",
      body: { id: d.id, result: result.value, note: note.value, arrAfter: arr.value === "" ? null : Number(arr.value) },
    });
    if (!r.ok) return toast(r.error, "bad");
    closeModal();
    toast("Resolved. It is in the record now.", "good");
    onChange?.();
  });
}

async function draftDialog(d, onChange, force = false) {
  const m = modal("Draft an email");
  m.append(el("p", "note", "Writing the draft…"));
  const r = await api("decisionsActionPrepare", { method: "POST", body: { id: d.id, kind: "draft_email", force } });
  if (!r.ok) {
    if (r.conflict) {
      m.replaceChildren();
      m.append(el("h3", null, "There is already an email for this customer"));
      m.append(el("p", "note", r.error));
      const acts = el("div", "modal-actions");
      acts.append(button("Cancel", "btn", closeModal));
      if (r.decisionId) acts.append(button("Open that decision", "btn", () => { closeModal(); go(`#/decisions/${r.decisionId}`); }));
      acts.append(button("Write one anyway", "btn primary", () => draftDialog(d, onChange, true)));
      m.append(acts);
      return;
    }
    closeModal();
    return toast(r.error, "bad");
  }
  showDraft(r.action, d, onChange);
}

function showDraft(action, d, onChange) {
  const m = modal("Draft an email");
  m.append(
    el(
      "p",
      "note",
      action.payload.source === "template"
        ? "The model was not available, so this is the standard wording. Edit it before you send it."
        : "Written by the AI from this decision. Nothing is sent by this app — you send it from your own mail program.",
    ),
  );
  const to = field(m, "To", Object.assign(el("input"), { type: "text", value: action.payload.to ?? "", placeholder: "their email address" }));
  const subject = field(m, "Subject", Object.assign(el("input"), { type: "text", value: action.payload.subject ?? "" }));
  const body = field(m, "Message", Object.assign(el("textarea", "field"), { value: action.payload.body ?? "", rows: 10 }));
  body.style.minHeight = "180px";

  const save = async (status) =>
    api("decisionsActionUpdate", {
      method: "POST",
      body: { actionId: action.id, status, payload: { to: to.value, subject: subject.value, body: body.value } },
    });

  const acts = el("div", "modal-actions");
  acts.append(
    button("Copy", "btn", async () => {
      await navigator.clipboard.writeText(`${subject.value}\n\n${body.value}`).catch(() => {});
      await save("prepared");
      toast("Copied.");
    }),
  );
  acts.append(
    button("Open in my mail app", "btn", async () => {
      await save("prepared");
      const href = `mailto:${encodeURIComponent(to.value)}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(body.value)}`;
      location.href = href;
    }),
  );
  acts.append(
    button("Mark as sent", "btn primary", async () => {
      const r = await save("done");
      if (!r.ok) return toast(r.error, "bad");
      closeModal();
      toast("Marked as sent.", "good");
      onChange?.();
    }),
  );
  m.append(acts);
  m.append(el("div", "hint", "Nothing here sends an email. This app has no way to send one."));
}

function taskDialog(d, owners, onChange) {
  const m = modal("Create a task");
  const title = field(m, "What needs doing?", Object.assign(el("input"), { type: "text", value: d.recommendation ?? "" }));
  const owner = field(m, "Who is doing it?", select([["", "Nobody yet"], ...owners.map((o) => [o, o])], d.owner ?? ""));
  const due = field(m, "By when?", Object.assign(el("input"), { type: "date", value: d.dueAt ?? "" }));
  const note = field(m, "Notes (optional)", Object.assign(el("textarea", "field"), {}));
  m.append(el("div", "hint", "This is kept here, in the decision's history. It does not go to another system."));
  modalActions(m, "Create task", async () => {
    const r = await api("decisionsActionPrepare", {
      method: "POST",
      body: { id: d.id, kind: "task", task: { title: title.value, owner: owner.value, dueAt: due.value, note: note.value } },
    });
    if (!r.ok) return toast(r.error, "bad");
    closeModal();
    toast("Task created.", "good");
    onChange?.();
  });
}

/* ── running the analysis ───────────────────────────────────────────────── */

async function runAnalysis() {
  if (state.running) return toast("An analysis is already running.");
  state.running = true;
  const btn = $("run-btn");
  btn.disabled = true;
  btn.textContent = "Analysing…";
  renderRoute();

  // Poll while it runs, so the progress card is not a lie about what is happening.
  state.pollTimer = setInterval(async () => {
    const s = await api("decisionsRunStatus");
    if (s.ok && s.run?.progress) paintProgress(s.run.progress);
  }, 1200);

  const r = await api("decisionsRun", { method: "POST" });
  clearInterval(state.pollTimer);
  state.running = false;
  btn.disabled = false;
  btn.textContent = "Run analysis";

  if (!r.ok) {
    toast(r.error, "bad");
  } else {
    const s = r.summary;
    toast(
      s.created || s.updated
        ? `${s.created} new decision${s.created === 1 ? "" : "s"}, ${s.updated} updated. ${s.accounts} customers checked.`
        : `Nothing new. ${s.accounts} customers checked.`,
      "good",
    );
  }
  await loadStatus();
  renderRoute();
}

function paintProgress(p) {
  const box = $("run-progress");
  if (!box) return;
  const phase = { reading: "Reading the data", signals: "Working out what changed", situations: "Looking for situations", reasoning: "Asking the AI about the important ones", done: "Finishing" }[p.phase] ?? p.phase;
  box.querySelector(".p1").textContent = phase;
  const bits = [`${p.accounts ?? 0} customers`, `${p.signals ?? 0} signals`, `${p.candidates ?? 0} situations`];
  if (p.phase === "reasoning" && p.of) bits.push(`explaining ${p.reasoned ?? 0} of ${p.of}`);
  if (p.tokens) bits.push(`${p.tokens} tokens`);
  box.querySelector(".p2").textContent = bits.join(" · ");
}

function progressCard() {
  const box = el("div", "progress");
  box.id = "run-progress";
  box.append(el("div", "p1", "Starting…"));
  box.append(el("div", "p2", "Free models can take a minute. You can keep using the app."));
  return box;
}

/* ── views ──────────────────────────────────────────────────────────────── */

const views = {};

views.onboarding = async () => {
  const wrap = page("Welcome");
  wrap.replaceChildren();
  const o = el("div", "onb");
  wrap.append(o);

  const dots = el("div", "steps-dots");
  const d1 = el("i", "on"), d2 = el("i"), d3 = el("i");
  dots.append(d1, d2, d3);
  o.append(dots);

  o.append(el("h2", null, "Turn your customer data into decisions"));
  o.append(
    el(
      "p",
      "lede",
      "This looks at every customer you import, works out what has changed, and gives you a short list of things that need a decision — with the evidence behind each one. Three steps, about two minutes.",
    ),
  );

  const step = el("div", null);
  o.append(step);

  const stepOne = () => {
    step.replaceChildren();
    step.append(el("h3", null, "1. Name your workspace"));
    const name = field(step, "What is this company called?", Object.assign(el("input"), { type: "text", value: "My company" }));
    const go1 = button("Continue", "btn primary", async () => {
      const r = await api("decisionsWorkspaceCreate", { method: "POST", body: { name: name.value } });
      if (!r.ok) return toast(r.error, "bad");
      await loadStatus();
      d2.classList.add("on");
      stepTwo();
    });
    step.append(go1);
    name.onkeydown = (e) => {
      if (e.key === "Enter") go1.click();
    };
  };

  const stepTwo = () => {
    step.replaceChildren();
    step.append(el("h3", null, "2. Add some data"));
    step.append(el("p", "hint", "You can change this later, and you can have both."));

    const demo = el("button", "choice");
    demo.append(el("b", null, "Load the demo company"));
    demo.append(el("span", null, "48 made-up customers with real-looking problems in them. Nothing of yours is used. This is the fastest way to see what the product does."));
    demo.onclick = async () => {
      demo.disabled = true;
      demo.querySelector("span").textContent = "Loading…";
      const r = await api("decisionsSeedDemo", { method: "POST", body: { variant: "demo" } });
      if (!r.ok) {
        demo.disabled = false;
        return toast(r.error, "bad");
      }
      await loadStatus();
      d3.classList.add("on");
      stepThree(`${r.accounts} demo customers loaded.`);
    };

    const own = el("button", "choice");
    own.append(el("b", null, "Import my own data"));
    own.append(el("span", null, "A folder with five CSV files: accounts, daily usage, contacts, support tickets and invoices. You can download blank templates first."));
    own.onclick = () => importDialog(async () => {
      await loadStatus();
      d3.classList.add("on");
      stepThree("Your data is imported.");
    });

    step.append(demo, own);
    step.append(button("Back", "btn", stepOne));
  };

  const stepThree = (msg) => {
    step.replaceChildren();
    step.append(el("h3", null, "3. Run the first analysis"));
    step.append(el("p", "hint", msg + " The analysis works out what changed for every customer, then asks the AI about the ones that matter. It costs nothing to run again."));
    step.append(
      button("Run the analysis", "btn primary", async () => {
        location.hash = "#/today";
        await runAnalysis();
      }),
    );
  };

  stepOne();
};

views.today = async (params, token) => {
  const wrap = page("Today", [button("Run analysis", "btn", runAnalysis)]);
  wrap.append(skeleton(3));

  const r = await api("decisionsOverview");
  if (stale(token)) return;
  wrap.replaceChildren();
  if (!r.ok) return wrap.append(blank("Something went wrong", r.error, "Try again", renderRoute));

  if (state.running) wrap.append(progressCard());

  const st = state.status;
  if (st?.lastRun?.status === "failed") {
    const b = el("div", "banner bad");
    b.append(el("span", "grow", `The last analysis failed: ${st.lastRun.error ?? "no reason given"}`));
    b.append(button("Try again", "btn", runAnalysis));
    wrap.append(b);
  }

  const t = r.tiles;
  const tiles = el("div", "tiles");
  const tile = (n, k, cls, href) => {
    const b = el("button", `tile ${cls ?? ""}`);
    b.append(el("div", "n", String(n)));
    b.append(el("div", "k", k));
    if (href) b.onclick = () => go(href);
    tiles.append(b);
  };
  tile(t.attention, "Need a decision", "", "#/decisions?status=new");
  tile(t.overdue, "Overdue", t.overdue ? "hot" : "", "#/decisions?status=open");
  tile(t.waiting, "Being handled", "", "#/decisions?status=open");
  tile(t.snoozed, "Snoozed", "", "#/decisions?status=snoozed");
  tile(t.resolvedThisMonth, "Resolved this month", "", "#/decisions?status=resolved");
  const money = el("button", "tile money");
  money.append(el("div", "n", t.arrUnderReviewLabel));
  money.append(el("div", "k", "Revenue under review"));
  money.onclick = () => go("#/decisions?status=open");
  tiles.append(money);
  wrap.append(tiles);

  const sections = [
    ["attention", "Needs a decision", "New, not looked at yet. Most serious first."],
    ["overdue", "Overdue", "You said you would handle these by a date that has passed."],
    ["waiting", "Being handled", "Accepted or in progress."],
    ["snoozed", "Snoozed", "Coming back on the date shown."],
    ["resolved", "Resolved this month", "With what happened recorded."],
  ];
  let any = false;
  for (const [key, label, why] of sections) {
    const list = r.sections[key] ?? [];
    if (!list.length) continue;
    any = true;
    const h = el("div", "sec-head");
    h.append(document.createTextNode(label));
    h.append(el("span", "count", String(list.length)));
    h.append(el("span", "why", why));
    wrap.append(h);
    for (const d of list) wrap.append(decisionCard(d, { onChange: renderRoute }));
  }

  if (!any) {
    if (!st?.lastRun) {
      wrap.append(
        blank(
          "No analysis yet",
          `There ${st?.workspace?.accounts === 1 ? "is" : "are"} ${st?.workspace?.accounts ?? 0} customer${st?.workspace?.accounts === 1 ? "" : "s"} imported. Run the analysis to see what needs a decision.`,
          "Run analysis",
          runAnalysis,
        ),
      );
    } else {
      wrap.append(
        blank(
          "Nothing needs a decision",
          `${st.lastRun.accounts ?? 0} customers were checked and nothing crossed the line. Single signals that are being watched are on the Customers page.`,
          "Run it again",
          runAnalysis,
        ),
      );
    }
  }
};

views.decisions = async (params, token) => {
  const wrap = page("Decisions");
  wrap.append(skeleton(4));
  const query = {
    status: params.get("status") ?? "open",
    severity: params.get("severity") ?? "all",
    kind: params.get("kind") ?? "all",
    owner: params.get("owner") ?? "all",
    sort: params.get("sort") ?? "priority",
  };
  const r = await api("decisionsList", { query });
  if (stale(token)) return;
  wrap.replaceChildren();
  if (!r.ok) return wrap.append(blank("Something went wrong", r.error, "Try again", renderRoute));

  const f = el("div", "filters");
  const setParam = (k, v) => {
    const p = new URLSearchParams(query);
    p.set(k, v);
    go(`#/decisions?${p.toString()}`);
  };
  const add = (label, key, options) => {
    const s = select(options, query[key]);
    s.onchange = () => setParam(key, s.value);
    const l = el("label", null);
    l.append(el("span", "meta", label + " "), s);
    l.style.display = "flex";
    l.style.alignItems = "center";
    l.style.gap = "6px";
    f.append(l);
  };
  add("Status", "status", [
    ["open", "Open"], ["new", "New"], ["accepted", "Accepted"], ["in_progress", "In progress"],
    ["waiting", "Waiting"], ["snoozed", "Snoozed"], ["resolved", "Resolved"], ["dismissed", "Dismissed"], ["all", "Everything"],
  ]);
  add("Severity", "severity", [["all", "Any"], ["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]]);
  add("Kind", "kind", [["all", "Any"], ["churn_risk", "Churn risk"], ["expansion", "Expansion"], ["payment_risk", "Payment"], ["cohort_shift", "Company-wide"]]);
  add("Owner", "owner", [["all", "Anyone"], ["unassigned", "Nobody yet"], ...(r.owners ?? []).map((o) => [o, o])]);
  add("Sort", "sort", [["priority", "Most serious"], ["newest", "Newest"], ["due", "Due first"]]);
  f.append(el("span", "grow"));
  f.append(el("span", "meta", `${r.total} shown`));
  wrap.append(f);

  if (!r.decisions.length) {
    return wrap.append(blank("Nothing matches", "No decisions match these filters.", "Show open decisions", () => go("#/decisions?status=open")));
  }
  for (const d of r.decisions) wrap.append(decisionCard(d, { onChange: renderRoute }));
};

views.decision = async (id, token) => {
  const wrap = page("Decision");
  wrap.append(skeleton(3));
  const r = await api("decisionsGet", { query: { id } });
  if (stale(token)) return;
  wrap.replaceChildren();
  if (!r.ok) return wrap.append(blank("Not found", r.error, "Back to decisions", () => go("#/decisions")));

  const d = r.decision;
  $("title").textContent = d.title;

  const crumb = el("div", "meta");
  const back = button("Decisions", "linkish", () => go("#/decisions"));
  crumb.append(back, document.createTextNode(" / "), document.createTextNode(d.accountName));
  wrap.append(crumb);

  const head = el("div", "filters");
  head.style.marginTop = "10px";
  head.append(sevChip(d.severity));
  head.append(el("span", "tag", d.statusLabel));
  if (d.overdueDays != null) head.append(el("span", "sev high", `${d.overdueDays} days overdue`));
  if (d.signalsEased) head.append(el("span", "tag warn", "the signals have eased"));
  head.append(el("span", "meta", `raised ${d.ageDays === 0 ? "today" : `${d.ageDays} days ago`}`));
  wrap.append(head);

  const grid = el("div", "detail");
  wrap.append(grid);
  const main = el("div", null);
  const rail = el("div", "rail");
  grid.append(main, rail);

  const refresh = () => renderRoute();

  // 1. Why this matters
  const b1 = el("div", "block");
  const h1 = el("h3");
  h1.append(document.createTextNode("Why this matters"), kindChip("ai"));
  b1.append(h1);
  if (d.whyItMatters) {
    b1.append(el("p", null, d.whyItMatters));
  } else {
    b1.append(el("p", "note", `The AI could not explain this one${d.reasoningError ? `: ${d.reasoningError}` : ""}. The decision below still stands — it came from the rules and the figures are computed, not written by a model.`));
    b1.append(
      button("Try the AI again", "btn", async (e) => {
        e.target.disabled = true;
        e.target.textContent = "Asking…";
        const rr = await api("decisionsRereason", { method: "POST", body: { id } });
        toast(rr.ok ? "Done." : rr.error, rr.ok ? "good" : "bad");
        refresh();
      }),
    );
  }
  main.append(b1);

  // 2. What changed
  const cited = r.evidence ?? [];
  const b2 = el("div", "block");
  const h2 = el("h3");
  h2.append(document.createTextNode("What changed"), kindChip("fact"));
  b2.append(h2);
  for (const e of cited) {
    const row = el("div", "sig-row");
    row.append(el("div", "s", e.statement));
    row.append(el("div", "band", ""));
    b2.append(row);
  }
  if (!cited.length) b2.append(el("p", "note", "No evidence was recorded for this decision."));
  main.append(b2);

  // 3. Everything we looked at
  if (r.allSignals?.length) {
    const b3 = el("div", "block");
    const h3 = el("h3");
    h3.append(document.createTextNode("Everything we looked at"), kindChip("fact"));
    b3.append(h3);
    b3.append(el("p", "note", "Every signal on this customer in the last analysis, including the ones the recommendation did not use. Each was computed from your data, not written by the AI."));
    const bandWord = ["", "notable", "significant", "severe"];
    for (const s of r.allSignals) {
      const row = el("div", `sig-row${s.cited ? "" : " uncited"}`);
      row.append(el("div", "s", s.statement));
      const meta = el("div", "band", bandWord[s.band] ?? "");
      row.append(meta);
      if (s.threshold != null) {
        row.append(el("div", "t", `${s.label} — the rule flags this at ${Math.abs(s.threshold)}${s.kind.includes("renewal") || s.kind.includes("champion") || s.kind.includes("stale") ? " days" : s.kind.includes("payment") || s.kind.includes("pricing") ? "" : "%"}`));
      }
      b3.append(row);
    }
    main.append(b3);
  }

  // 4. Hypotheses
  const b4 = el("div", "block");
  const h4 = el("h3");
  h4.append(document.createTextNode("What might be causing it"), kindChip("guess"));
  b4.append(h4);
  b4.append(el("p", "note", "These are possible explanations, not findings. The AI wrote them from the evidence above and nothing else."));
  if (r.hypotheses?.length) {
    for (const h of r.hypotheses) {
      const box = el("div", "hyp");
      const hh = el("div", "h");
      hh.append(el("span", `sev ${h.confidence === "high" ? "high" : h.confidence === "medium" ? "medium" : "low"}`, `${h.confidence} confidence`));
      box.append(hh);
      box.append(el("p", null, h.text));
      if (h.evidence?.length) box.append(el("div", "from", `based on ${h.evidence.join(", ")}`));
      b4.append(box);
    }
  } else {
    b4.append(el("p", "note", "None were produced."));
  }
  main.append(b4);

  // 5. Recommended action
  const b5 = el("div", "block");
  const h5 = el("h3");
  h5.append(document.createTextNode("Recommended action"), kindChip("rec"));
  b5.append(h5);
  b5.append(el("p", null, d.recommendation ?? "—"));
  if (d.rationale) b5.append(el("p", "note", d.rationale));
  if (r.businessContext) {
    const det = el("details");
    det.append(el("summary", "note", "Context you gave the model"));
    det.append(el("p", "note", r.businessContext));
    b5.append(det);
  }
  const acts = el("div", "pill-row");
  acts.style.marginTop = "10px";
  acts.append(button("Draft an email", "btn primary", () => draftDialog(d, refresh)));
  acts.append(button("Create a task", "btn", () => taskDialog(d, r.owners ?? [], refresh)));
  b5.append(acts);
  main.append(b5);

  // 6. Impact
  const b6 = el("div", "block");
  const h6 = el("h3");
  h6.append(document.createTextNode("Business impact"), kindChip("fact"));
  b6.append(h6);
  const kv = el("dl", "kv");
  const pair = (k, v) => {
    kv.append(el("dt", null, k), el("dd", null, v ?? "—"));
  };
  pair("Money at stake", d.impactLabel ? `${d.impactLabel} — ${d.impactBasis}` : d.impactBasis ?? "not estimated");
  if (r.account) {
    pair("Their ARR", r.account.arrLabel ?? "—");
    pair("Plan", r.account.plan ?? "—");
    pair("Renewal", r.account.renewal_date ? `${r.account.renewal_date} (${r.account.daysToRenewal} days)` : "not set");
    pair("Seats", r.account.seats_purchased ?? "—");
    pair("Customer since", r.account.created_at ? `${r.account.created_at} (${r.account.tenureDays} days)` : "—");
  }
  b6.append(kv);
  b6.append(el("div", "hint", "These are figures from your imported data. This is not a prediction."));
  main.append(b6);

  // 7. History
  const b7 = el("div", "block");
  b7.append(el("h3", null, "History"));
  const tl = el("div", "tl");
  for (const e of r.events ?? []) {
    const row = el("div", "tl-row");
    row.append(el("div", "when", fmtWhen(e.at)));
    const what = el("div", null);
    what.append(el("div", null, describeEvent(e)));
    what.append(el("div", "who", e.actor === "system" ? "by the system" : "by you"));
    row.append(what);
    tl.append(row);
  }
  b7.append(tl);
  const noteRow = el("div", "filters");
  noteRow.style.marginTop = "10px";
  const noteIn = Object.assign(el("input"), { type: "text", placeholder: "Add a note…" });
  noteRow.append(noteIn);
  noteRow.append(
    button("Add", "btn", async () => {
      const rr = await api("decisionsNote", { method: "POST", body: { id, text: noteIn.value } });
      if (!rr.ok) return toast(rr.error, "bad");
      refresh();
    }),
  );
  b7.append(noteRow);
  main.append(b7);

  // 8. Actions taken
  const b8 = el("div", "block");
  b8.append(el("h3", null, "Actions taken"));
  if (r.actions?.length) {
    for (const a of r.actions) {
      const box = el("div", "act");
      const hh = el("div", "h");
      hh.append(document.createTextNode(a.kind === "draft_email" ? "Email draft" : "Task"));
      hh.append(el("span", `tag ${a.status === "done" ? "on" : a.status === "cancelled" ? "off" : ""}`, a.status));
      hh.append(el("span", "grow"));
      hh.style.display = "flex";
      hh.style.gap = "8px";
      if (a.status === "prepared") {
        if (a.kind === "draft_email") hh.append(button("Open", "btn", () => showDraft(a, d, refresh)));
        hh.append(
          button("Mark done", "btn", async () => {
            await api("decisionsActionUpdate", { method: "POST", body: { actionId: a.id, status: "done" } });
            refresh();
          }),
        );
        hh.append(
          button("Cancel", "btn danger", async () => {
            await api("decisionsActionUpdate", { method: "POST", body: { actionId: a.id, status: "cancelled" } });
            refresh();
          }),
        );
      }
      box.append(hh);
      box.append(el("pre", null, a.kind === "draft_email" ? `${a.payload.subject ?? ""}\n\n${a.payload.body ?? ""}` : `${a.payload.title ?? ""}${a.payload.owner ? `\nOwner: ${a.payload.owner}` : ""}${a.payload.dueAt ? `\nBy: ${a.payload.dueAt}` : ""}${a.payload.note ? `\n${a.payload.note}` : ""}`));
      b8.append(box);
    }
  } else {
    b8.append(el("p", "note", "Nothing yet. Draft an email or create a task above."));
  }
  main.append(b8);

  // 9. Outcome
  const b9 = el("div", "block");
  b9.append(el("h3", null, "Outcome"));
  if (r.outcome) {
    b9.append(el("p", null, `${r.outcomes[r.outcome.result] ?? r.outcome.result}${r.outcome.note ? ` — ${r.outcome.note}` : ""}`));
    b9.append(el("div", "hint", `Recorded ${fmtWhen(r.outcome.recorded_at)}.`));
  } else {
    b9.append(el("p", "note", "Not resolved yet. When you finish with this, record what actually happened — that is what makes the next decision better."));
  }
  main.append(b9);

  // --- the rail ---
  const rb = el("div", "block");
  rb.append(el("h3", null, "This decision"));
  const nextLabels = {
    accepted: "Accept and assign",
    in_progress: "Start work",
    waiting: "Waiting on the customer",
    resolved: "Record the outcome",
    dismissed: "Dismiss",
    snoozed: "Snooze",
  };
  for (const next of d.allowedNext) {
    if (next === "snoozed") {
      rb.append(button("Snooze", "btn", () => snoozeDialog(d, refresh)));
      continue;
    }
    if (next === "dismissed") {
      rb.append(button("Dismiss", "btn danger", () => dismissDialog(d, refresh)));
      continue;
    }
    if (next === "resolved") {
      rb.append(button("Record the outcome", "btn", () => resolveDialog(d, r.outcomes, refresh)));
      continue;
    }
    rb.append(
      button(nextLabels[next] ?? next, next === "accepted" ? "btn primary" : "btn", async () => {
        const rr = await api("decisionsUpdate", { method: "POST", body: { id, status: next } });
        if (!rr.ok) return toast(rr.error, "bad");
        toast(next === "accepted" ? "Accepted. A due date was set for you." : "Updated.", "good");
        refresh();
      }),
    );
  }
  if (["resolved", "dismissed"].includes(d.status)) {
    rb.append(
      button("Reopen", "btn", async () => {
        await api("decisionsReopen", { method: "POST", body: { id } });
        refresh();
      }),
    );
  }
  rail.append(rb);

  const rb2 = el("div", "block");
  rb2.append(el("h3", null, "Owner and date"));
  const ownerSel = select([["", "Nobody yet"], ...(r.owners ?? []).map((o) => [o, o])], d.owner ?? "");
  ownerSel.onchange = async () => {
    await api("decisionsUpdate", { method: "POST", body: { id, owner: ownerSel.value } });
    toast("Owner saved.");
  };
  field(rb2, "Owner", ownerSel, (r.owners ?? []).length ? null : "Add names in Settings first.");
  const dueIn = Object.assign(el("input"), { type: "date", value: d.dueAt ?? "" });
  dueIn.onchange = async () => {
    await api("decisionsUpdate", { method: "POST", body: { id, dueAt: dueIn.value } });
    toast("Date saved.");
  };
  field(rb2, "Handle it by", dueIn);
  rail.append(rb2);

  if (d.accountId) {
    const rb3 = el("div", "block");
    rb3.append(el("h3", null, "Customer"));
    rb3.append(button(d.accountName, "linkish", () => go(`#/customers/${d.accountId}`)));
    rail.append(rb3);
  }

  const rb4 = el("div", "block");
  rb4.append(el("h3", null, "How this was made"));
  const kv2 = el("dl", "kv");
  kv2.append(el("dt", null, "Figures"), el("dd", null, "computed from your data"));
  kv2.append(el("dt", null, "Words"), el("dd", null, d.reasoningSource === "model" ? "written by the AI" : "not available"));
  if (d.model) kv2.append(el("dt", null, "Model"), el("dd", null, d.model));
  if (d.confidence) kv2.append(el("dt", null, "AI confidence"), el("dd", null, d.confidence));
  rb4.append(kv2);
  rb4.append(
    button("Ask the AI again", "btn", async (e) => {
      e.target.disabled = true;
      const rr = await api("decisionsRereason", { method: "POST", body: { id } });
      toast(rr.ok ? "Done." : rr.error, rr.ok ? "good" : "bad");
      refresh();
    }),
  );
  rail.append(rb4);
};

function describeEvent(e) {
  const d = e.data ?? {};
  switch (e.kind) {
    case "created": return `Raised as ${d.severity}${d.source === "rule_only" ? " (from the rules; the AI was not available)" : ""}`;
    case "updated": return `Updated — severity ${d.from} to ${d.to}`;
    case "escalated": return `Got worse — severity ${d.from} to ${d.to}`;
    case "status": return `Status: ${d.from} to ${d.to}${d.because ? ` (${d.because})` : ""}`;
    case "owner": return `Owner set to ${d.to ?? "nobody"}`;
    case "due": return `Due date set to ${d.to ?? "none"}`;
    case "snoozed": return `Snoozed until ${d.until}`;
    case "unsnoozed": return `Came back — ${d.reason}`;
    case "dismissed": return `Dismissed: ${d.reason}`;
    case "resolved": return `Resolved: ${d.result}`;
    case "outcome": return `Outcome recorded: ${d.result}`;
    case "reminder": return d.daysOverdue != null ? `Reminder — ${d.daysOverdue} days overdue` : `Reminder — waiting ${d.waitingDays} days`;
    case "action_prepared": return `${d.kind === "task" ? "Task created" : "Email drafted"}${d.source === "template" ? " (standard wording; the AI was not available)" : ""}`;
    case "action_done": return `${d.kind === "task" ? "Task" : "Email"} marked done`;
    case "action_cancelled": return `${d.kind === "task" ? "Task" : "Email"} cancelled`;
    case "note": return d.text ?? "Note";
    default: return e.kind;
  }
}

views.customers = async (params, token) => {
  const wrap = page("Customers");
  wrap.append(skeleton(3));
  const q = params.get("q") ?? "";
  const label = params.get("label") ?? "all";
  const r = await api("decisionsCustomers", { query: { q, label, sort: params.get("sort") ?? "arr" } });
  if (stale(token)) return;
  wrap.replaceChildren();
  if (!r.ok) return wrap.append(blank("Something went wrong", r.error, "Try again", renderRoute));

  const f = el("div", "filters");
  const search = Object.assign(el("input"), { type: "text", placeholder: "Search customers…", value: q });
  search.onkeydown = (e) => {
    if (e.key === "Enter") go(`#/customers?q=${encodeURIComponent(search.value)}&label=${label}`);
  };
  f.append(search);
  const labelSel = select([["all", "Any state"], ...Object.entries(r.labels)], label);
  labelSel.onchange = () => go(`#/customers?q=${encodeURIComponent(q)}&label=${labelSel.value}`);
  f.append(labelSel);
  f.append(el("span", "grow"));
  f.append(el("span", "meta", `${r.total} customers`));
  wrap.append(f);

  if (!r.hasRun) {
    const b = el("div", "banner");
    b.append(el("span", "grow", "The analysis has not run yet, so nobody has a state or signals."));
    b.append(button("Run analysis", "btn", runAnalysis));
    wrap.append(b);
  }

  if (!r.customers.length) return wrap.append(blank("No customers", "Import data or load the demo company from Settings.", "Open Settings", () => go("#/settings")));

  const tbl = el("table", "tbl");
  const head = el("tr");
  for (const h of ["State", "Customer", "ARR", "Plan", "Renewal", "Owner", "Open", "Watching"]) {
    head.append(el("th", h === "ARR" || h === "Open" || h === "Watching" ? "num" : null, h));
  }
  // NOT `tbl.append(el("thead")).lastChild`: Node.append() returns undefined,
  // so that chain throws and takes the whole page down with it.
  const thead = el("thead");
  thead.append(head);
  tbl.append(thead);
  const body = el("tbody");
  for (const c of r.customers) {
    const tr = el("tr");
    const lab = el("td");
    if (c.label) lab.append(el("span", `label-chip ${c.label}`, c.labelText));
    tr.append(lab);
    const nameTd = el("td");
    nameTd.append(button(c.name, "link", () => go(`#/customers/${c.id}`)));
    if (c.staleData) nameTd.append(el("span", "tag warn", "stale data"));
    tr.append(nameTd);
    tr.append(el("td", "num", c.arrLabel));
    tr.append(el("td", null, c.plan ?? "—"));
    tr.append(el("td", null, c.renewalDate ? `${c.renewalDate}${c.daysToRenewal != null ? ` (${c.daysToRenewal}d)` : ""}` : "—"));
    tr.append(el("td", null, c.owner || "—"));
    tr.append(el("td", "num", String(c.openDecisions)));
    tr.append(el("td", "num", String(c.watching)));
    body.append(tr);
  }
  tbl.append(body);
  wrap.append(tbl);
};

views.customer = async (id, token) => {
  const wrap = page("Customer");
  wrap.append(skeleton(2));
  const r = await api("decisionsCustomer", { query: { id } });
  if (stale(token)) return;
  wrap.replaceChildren();
  if (!r.ok) return wrap.append(blank("Not found", r.error, "All customers", () => go("#/customers")));

  const a = r.account;
  $("title").textContent = a.name;
  const crumb = el("div", "meta");
  crumb.append(button("Customers", "linkish", () => go("#/customers")), document.createTextNode(` / ${a.name}`));
  wrap.append(crumb);

  const facts = el("div", "block");
  facts.style.marginTop = "12px";
  const fh = el("h3");
  fh.append(document.createTextNode("The facts"));
  if (a.label) fh.append(el("span", `label-chip ${a.label}`, a.labelText));
  facts.append(fh);
  const kv = el("dl", "kv");
  const pair = (k, v) => kv.append(el("dt", null, k), el("dd", null, v ?? "—"));
  pair("ARR", a.arrLabel);
  pair("Plan", a.plan);
  pair("Seats bought", a.seats_purchased);
  pair("Renewal", a.renewal_date ? `${a.renewal_date} (${a.daysToRenewal} days)` : "not set");
  pair("Owner", a.owner);
  pair("Segment", a.segment);
  pair("Industry", a.industry);
  pair("Customer since", a.created_at ? `${a.created_at} (${a.tenureDays} days)` : null);
  facts.append(kv);
  wrap.append(facts);

  if (r.contacts?.length) {
    const cb = el("div", "block");
    cb.append(el("h3", null, "People"));
    for (const c of r.contacts) {
      const row = el("div", "sig-row");
      row.append(el("div", "s", `${c.name ?? "Unnamed"}${c.role ? ` — ${c.role}` : ""}${Number(c.is_champion) === 1 ? " (main contact)" : ""}`));
      row.append(el("div", "band", c.quietDays == null ? "" : c.quietDays === 0 ? "active today" : `quiet ${c.quietDays}d`));
      cb.append(row);
    }
    wrap.append(cb);
  }

  const sb = el("div", "block");
  const sh = el("h3");
  sh.append(document.createTextNode("Signals in the last analysis"), kindChip("fact"));
  sb.append(sh);
  const watching = (r.signals ?? []).filter((s) => s.isWatch);
  if (r.signals?.length) {
    for (const s of r.signals) {
      const row = el("div", "sig-row");
      row.append(el("div", "s", s.statement));
      row.append(el("div", "band", ["", "notable", "significant", "severe"][s.band] ?? ""));
      if (s.isWatch) row.append(el("div", "t", "watching only — one signal on its own is never a decision"));
      if (s.detail?.unreliable) row.append(el("div", "t", "the usage data is out of date, so this is not being acted on"));
      sb.append(row);
    }
  } else {
    sb.append(el("p", "note", "No signals. Either nothing has changed, or the analysis has not run."));
  }
  if (watching.length) sb.append(el("div", "hint", `${watching.length} signal${watching.length === 1 ? " is" : "s are"} being watched but ha${watching.length === 1 ? "s" : "ve"} not become a decision.`));
  wrap.append(sb);

  const db2 = el("div", "block");
  db2.append(el("h3", null, "Decisions"));
  if (r.decisions?.length) {
    for (const d of r.decisions) db2.append(decisionCard(d, { onChange: renderRoute }));
  } else {
    db2.append(el("p", "note", "None yet."));
  }
  wrap.append(db2);

  const dd = el("div", "block");
  dd.append(el("h3", null, "The data behind this"));
  const kv2 = el("dl", "kv");
  kv2.append(el("dt", null, "Usage runs to"), el("dd", null, r.data.lastUsageDay ?? "no usage data"));
  kv2.append(el("dt", null, "Usage rows"), el("dd", null, String(r.data.usageRows)));
  kv2.append(el("dt", null, "Tickets"), el("dd", null, String(r.data.tickets)));
  kv2.append(el("dt", null, "Invoices"), el("dd", null, String(r.data.invoices)));
  kv2.append(el("dt", null, "Events"), el("dd", null, String(r.data.events)));
  dd.append(kv2);
  wrap.append(dd);
};

views.activity = async (params, token) => {
  const filter = params.get("filter") ?? "all";
  const wrap = page("Activity");
  wrap.append(skeleton(2));
  const r = await api("decisionsActivity", { query: { filter } });
  if (stale(token)) return;
  wrap.replaceChildren();
  if (!r.ok) return wrap.append(blank("Something went wrong", r.error, "Try again", renderRoute));

  const f = el("div", "filters");
  const s = select([["all", "Everything"], ["system", "What the system did"], ["me", "What I did"]], filter);
  s.onchange = () => go(`#/activity?filter=${s.value}`);
  f.append(s);
  wrap.append(f);

  if (!r.entries.length) return wrap.append(blank("Nothing yet", "Once you run the analysis and handle a decision, everything shows up here.", "Run analysis", runAnalysis));

  const block = el("div", "block");
  const tl = el("div", "tl");
  for (const e of r.entries) {
    const row = el("div", "tl-row");
    row.append(el("div", "when", fmtWhen(e.at)));
    const what = el("div", null);
    if (e.kind === "run") {
      const d = e.data;
      what.append(
        el(
          "div",
          null,
          d.status === "failed"
            ? `Analysis failed: ${d.error ?? "no reason given"}`
            : `Analysis: ${d.accounts ?? 0} customers, ${d.candidates ?? 0} situations, ${d.created ?? 0} new decisions, ${d.updated ?? 0} updated`,
        ),
      );
      const bits = [];
      if (d.reasoned != null) bits.push(`${d.reasoned} explained by the AI`);
      if (d.cached) bits.push(`${d.cached} unchanged, so not sent`);
      if (d.failures) bits.push(`${d.failures} model failures`);
      if (d.tokens) bits.push(`${d.tokens} tokens`);
      if (d.model) bits.push(d.model);
      what.append(el("div", "who", bits.join(" · ")));
    } else {
      const line = el("div", null);
      line.append(document.createTextNode(describeEvent(e) + " — "));
      const link = button(e.title ?? "a decision", "linkish", () => go(`#/decisions/${e.decisionId}`));
      line.append(link);
      what.append(line);
      what.append(el("div", "who", e.actor === "system" ? "by the system" : "by you"));
    }
    row.append(what);
    tl.append(row);
  }
  block.append(tl);
  wrap.append(block);
};

views.settings = async (params, token) => {
  const wrap = page("Settings");
  wrap.append(skeleton(2));
  const r = await api("decisionsSettingsGet");
  if (stale(token)) return;
  wrap.replaceChildren();
  if (!r.ok) return wrap.append(blank("Something went wrong", r.error, "Try again", renderRoute));
  const s = r.settings;
  const save = async (patch, msg = "Saved.") => {
    const rr = await api("decisionsSettingsSet", { method: "POST", body: patch });
    toast(rr.ok ? msg : rr.error, rr.ok ? "good" : "bad");
    return rr.ok;
  };

  // Workspace
  const b0 = el("div", "block");
  b0.append(el("h3", null, "Workspace"));
  const wsName = field(b0, "Name", Object.assign(el("input"), { type: "text", value: r.workspace.name }));
  b0.append(
    button("Save name", "btn", async () => {
      const rr = await api("decisionsWorkspaceRename", { method: "POST", body: { id: r.workspace.id, name: wsName.value } });
      toast(rr.ok ? "Saved." : rr.error, rr.ok ? "good" : "bad");
      loadStatus();
    }),
  );
  b0.append(el("div", "hint", `Your data is in ${r.dataDir}`));
  wrap.append(b0);

  // Data
  const b1 = el("div", "block");
  b1.append(el("h3", null, "Data"));
  b1.append(el("p", "note", "Importing replaces the customer data. Your decisions, notes and outcomes are kept."));
  const row1 = el("div", "pill-row");
  row1.append(button("Import a folder", "btn primary", () => importDialog(renderRoute)));
  row1.append(
    button("Download blank templates", "btn", async () => {
      const rr = await api("decisionsTemplates", { method: "POST" });
      toast(rr.ok ? `Six files written to ${rr.folder}` : rr.error, rr.ok ? "good" : "bad");
    }),
  );
  b1.append(row1);
  const demoRow = el("div", "pill-row");
  demoRow.style.marginTop = "10px";
  for (const [k, desc] of Object.entries(r.variants)) {
    demoRow.append(
      button(`Load "${k}"`, "btn", async () => {
        if (!confirm(`Replace the customer data with the "${k}" demo company?\n\n${desc}`)) return;
        const rr = await api("decisionsSeedDemo", { method: "POST", body: { variant: k } });
        toast(rr.ok ? `Loaded ${rr.accounts} demo customers.` : rr.error, rr.ok ? "good" : "bad");
        loadStatus();
      }),
    );
  }
  b1.append(demoRow);
  b1.append(el("div", "hint", Object.entries(r.variants).map(([k, v]) => `${k}: ${v}`).join(" · ")));
  wrap.append(b1);

  // Owners
  const b2 = el("div", "block");
  b2.append(el("h3", null, "Who can own a decision"));
  const owners = [...(s.owners ?? [])];
  const list = el("div", "pill-row");
  const paintOwners = () => {
    list.replaceChildren();
    if (!owners.length) list.append(el("span", "note", "Nobody yet. Add a name so decisions can be assigned."));
    owners.forEach((o, i) => {
      const chip = el("span", "tag");
      chip.append(document.createTextNode(o + " "));
      chip.append(
        button("×", "linkish", async () => {
          owners.splice(i, 1);
          if (await save({ owners })) paintOwners();
        }),
      );
      list.append(chip);
    });
  };
  paintOwners();
  b2.append(list);
  const addRow = el("div", "filters");
  addRow.style.marginTop = "10px";
  const newOwner = Object.assign(el("input"), { type: "text", placeholder: "A name" });
  addRow.append(newOwner);
  addRow.append(
    button("Add", "btn", async () => {
      const v = newOwner.value.trim();
      if (!v) return;
      owners.push(v);
      if (await save({ owners })) {
        newOwner.value = "";
        paintOwners();
      }
    }),
  );
  b2.append(addRow);
  wrap.append(b2);

  // Business context
  const b3 = el("div", "block");
  b3.append(el("h3", null, "Business context"));
  b3.append(
    el(
      "p",
      "note",
      "The AI reads this with every decision. Say what your data cannot: how your contracts work, when your quiet season is, anything unusual going on. Do not put numbers here — they are not treated as facts about a customer.",
    ),
  );
  const ctx = field(b3, "", Object.assign(el("textarea", "field"), { value: s.businessContext ?? "", maxLength: r.limits.businessContextMaxChars }));
  const count = el("div", "charcount", `${(s.businessContext ?? "").length} / ${r.limits.businessContextMaxChars}`);
  ctx.oninput = () => (count.textContent = `${ctx.value.length} / ${r.limits.businessContextMaxChars}`);
  b3.append(count);
  b3.append(button("Save", "btn", () => save({ businessContext: ctx.value })));
  wrap.append(b3);

  // Analysis
  const b4 = el("div", "block");
  b4.append(el("h3", null, "Analysis"));
  const cap = field(
    b4,
    "How many decisions the AI explains per run",
    Object.assign(el("input"), { type: "number", value: s.maxReasonedPerRun, min: 1, max: 50 }),
    "Everything else is still found by the rules; this only limits how many get an AI explanation. Higher costs more.",
  );
  const seat = field(
    b4,
    "Price of one seat per month",
    Object.assign(el("input"), { type: "number", value: s.seatPriceMonthly ?? "", placeholder: "not set" }),
    "Used to estimate what an expansion is worth. Left empty, the product says it cannot estimate rather than guessing.",
  );
  b4.append(el("h3", null, "Thresholds"));
  b4.append(el("p", "note", "These are the lines that decide when something counts as a signal. They were chosen, not measured against real churn data."));
  const thresholdInputs = {};
  for (const t of r.thresholds) {
    thresholdInputs[t.id] = field(b4, `${t.label} (${t.unit})`, Object.assign(el("input"), { type: "number", value: t.current }), `${t.help} The shipped value is ${t.shipped}.`);
  }
  b4.append(
    button("Save analysis settings", "btn", () =>
      save({
        maxReasonedPerRun: Number(cap.value),
        seatPriceMonthly: seat.value === "" ? undefined : Number(seat.value),
        thresholds: Object.fromEntries(Object.entries(thresholdInputs).map(([k, i]) => [k, Number(i.value)])),
      }),
    ),
  );
  wrap.append(b4);

  // Privacy
  const b5 = el("div", "block");
  b5.append(el("h3", null, "Privacy"));
  const pseudo = el("input");
  pseudo.type = "checkbox";
  pseudo.checked = s.pseudonymise !== false;
  const pl = el("label", "f");
  const pspan = el("span", null, "");
  const inner = el("div", null);
  inner.style.display = "flex";
  inner.style.gap = "8px";
  inner.style.alignItems = "center";
  inner.append(pseudo, el("span", null, "Hide customer names from the AI"));
  pl.append(pspan, inner);
  b5.append(pl);
  b5.append(
    el(
      "p",
      "note",
      "On by default. Customers are sent as A-1, A-2 and so on, and people as their job title. The AI models this app uses are run by other companies, so this is what leaves your machine. Your data itself never does — only a short fact sheet, and only when you run an analysis.",
    ),
  );
  pseudo.onchange = () => save({ pseudonymise: pseudo.checked });
  wrap.append(b5);

  // Demo
  const b6 = el("div", "block");
  b6.append(el("h3", null, "Demo mode"));
  b6.append(el("p", "note", "Freezes today's date so you can move it forward and watch a reminder appear without waiting a week."));
  const demoOn = el("input");
  demoOn.type = "checkbox";
  demoOn.checked = !!s.demoMode;
  const dl = el("div", null);
  dl.style.display = "flex";
  dl.style.gap = "8px";
  dl.style.alignItems = "center";
  dl.append(demoOn, el("span", null, `Demo mode (today is ${r.asOf})`));
  demoOn.onchange = () => save({ demoMode: demoOn.checked }).then(loadStatus);
  b6.append(dl);
  const advRow = el("div", "filters");
  advRow.style.marginTop = "10px";
  const days = Object.assign(el("input"), { type: "number", value: 7, min: 1, max: 120 });
  days.style.maxWidth = "90px";
  advRow.append(el("span", "meta", "Move the clock forward"), days, el("span", "meta", "days"));
  advRow.append(
    button("Advance", "btn", async () => {
      const rr = await api("decisionsClockAdvance", { method: "POST", body: { days: Number(days.value) } });
      if (!rr.ok) return toast(rr.error, "bad");
      toast(`Today is now ${rr.asOf}. ${rr.followUp.unsnoozed} came back, ${rr.followUp.overdue} went overdue.`, "good");
      loadStatus();
    }),
  );
  b6.append(advRow);
  wrap.append(b6);

  // Danger
  const b7 = el("div", "block danger-zone");
  b7.append(el("h3", null, "Delete this workspace"));
  b7.append(el("p", "note", "Deletes the customer data, every decision and the whole history. This cannot be undone."));
  b7.append(
    button("Delete workspace", "btn danger", () => {
      const m = modal("Delete this workspace");
      m.append(el("p", "note", `Type "${r.workspace.name}" to confirm. Everything goes: the data, the decisions, the outcomes.`));
      const c = field(m, "Workspace name", Object.assign(el("input"), { type: "text" }));
      modalActions(m, "Delete for ever", async () => {
        const rr = await api("decisionsWorkspaceDelete", { method: "POST", body: { id: r.workspace.id, confirmName: c.value } });
        if (!rr.ok) return toast(rr.error, "bad");
        closeModal();
        await loadStatus();
        go("#/today");
      });
    }),
  );
  wrap.append(b7);

  // Docs
  const b8 = el("div", "block");
  b8.append(el("h3", null, "How to use this"));
  b8.append(el("p", "note", "The full instructions are in the docs/decisions folder where Omni Agent is installed. Start with getting-started.md."));
  wrap.append(b8);
};

function importDialog(onDone) {
  const m = modal("Import your data");
  m.append(
    el("p", "note", "Choose a folder containing these files. Only the first two are required."),
  );
  const ul = el("ul", "ev");
  for (const [f, what] of [
    ["accounts.csv", "one row per customer: id, name, ARR, plan, seats, renewal date"],
    ["usage_daily.csv", "one row per customer per day: active users, sessions, seats used"],
    ["contacts.csv", "who your contacts are and when they were last active"],
    ["tickets.csv", "support tickets, when they were opened and closed"],
    ["invoices.csv", "invoices and whether they were paid"],
    ["events.csv", "notable events: pricing page views, seat limit hit"],
  ]) {
    ul.append(el("li", null, `${f} — ${what}`));
  }
  m.append(ul);

  const pathIn = field(m, "Or type the folder path", Object.assign(el("input"), { type: "text", placeholder: "C:\\Users\\you\\customer-data" }));
  const acts = el("div", "modal-actions");
  acts.append(button("Cancel", "btn", closeModal));
  acts.append(
    button("Download blank templates", "btn", async () => {
      const rr = await api("decisionsTemplates", { method: "POST" });
      if (rr.ok) {
        pathIn.value = rr.folder;
        toast(`Templates written to ${rr.folder}. Fill them in, then import that folder.`, "good");
      } else toast(rr.error, "bad");
    }),
  );
  acts.append(
    button("Choose a folder…", "btn", async () => {
      const rr = await api("decisionsImportPick", { method: "POST" });
      handleImport(rr, onDone);
    }),
  );
  acts.append(
    button("Import", "btn primary", async () => {
      if (!pathIn.value.trim()) return toast("Type a folder path, or use Choose a folder.", "bad");
      const rr = await api("decisionsImport", { method: "POST", body: { path: pathIn.value.trim() } });
      handleImport(rr, onDone);
    }),
  );
  m.append(acts);
}

function handleImport(rr, onDone) {
  if (rr?.cancelled) return;
  if (!rr?.ok) {
    const m = modal("The import did not work");
    m.append(el("p", null, rr?.error ?? "Unknown problem."));
    if (rr?.report?.files) m.append(importReport(rr.report));
    modalActions(m, "Close", closeModal);
    return;
  }
  const m = modal("Imported");
  m.append(el("p", null, `${rr.report.accounts} customers imported.`));
  m.append(importReport(rr.report));
  for (const w of rr.report.warnings ?? []) m.append(el("p", "note", w));
  modalActions(m, "Done", () => {
    closeModal();
    onDone?.();
  });
}

function importReport(report) {
  const box = el("div", null);
  const tbl = el("table", "tbl");
  const head = el("tr");
  for (const h of ["File", "Read", "Used", "Rejected"]) head.append(el("th", h === "File" ? null : "num", h));
  const thead = el("thead");
  thead.append(head);
  tbl.append(thead);
  const body = el("tbody");
  for (const [name, f] of Object.entries(report.files ?? {})) {
    if (!f.present) continue;
    const tr = el("tr");
    tr.append(el("td", null, name));
    tr.append(el("td", "num", String(f.read)));
    tr.append(el("td", "num", String(f.accepted)));
    tr.append(el("td", "num", String(f.rejected)));
    body.append(tr);
    for (const [reason, n] of Object.entries(f.reasons ?? {})) {
      const r2 = el("tr");
      const td = el("td", "note", `${reason} — ${n} row${n === 1 ? "" : "s"}`);
      td.colSpan = 4;
      r2.append(td);
      body.append(r2);
    }
  }
  tbl.append(body);
  box.append(tbl);
  return box;
}

/* ── routing ────────────────────────────────────────────────────────────── */

function go(hash) {
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}

async function loadStatus() {
  const r = await api("decisionsStatus");
  state.status = r.ok ? r : null;
  const name = r?.workspace?.name ?? "No workspace";
  $("ws-name").textContent = name;
  const lr = r?.lastRun;
  $("last-run").textContent = lr ? `Last analysis ${fmtWhen(lr.at)} · ${lr.accounts ?? 0} customers` : "No analysis yet";
  const chip = $("asof-chip");
  if (r?.demoMode) {
    chip.hidden = false;
    chip.textContent = `Demo mode — today is ${r.asOf}`;
  } else chip.hidden = true;
  return r;
}

async function renderRoute() {
  const raw = location.hash.replace(/^#/, "") || "/today";
  const [pathPart, queryPart] = raw.split("?");
  const params = new URLSearchParams(queryPart ?? "");
  const parts = pathPart.split("/").filter(Boolean);
  const view = parts[0] ?? "today";

  if (!state.status) await loadStatus();
  if (state.status?.needsWorkspace) {
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    return views.onboarding();
  }
  if (state.status && !state.status.hasData && view !== "settings") {
    const wrap = page("Add some data");
    wrap.append(
      blank(
        "This workspace has no customer data yet",
        "Load the demo company to see what the product does, or import a folder of CSV files.",
        "Open Settings",
        () => go("#/settings"),
      ),
    );
    return;
  }

  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));

  const token = ++state.renderToken;
  try {
    if (view === "decisions" && parts[1]) return await views.decision(parts[1], token);
    if (view === "customers" && parts[1]) return await views.customer(parts[1], token);
    const fn = views[view] ?? views.today;
    await fn(params, token);
  } catch (err) {
    if (stale(token)) return;
    const wrap = page("Something went wrong");
    wrap.append(blank("Something went wrong", String(err?.message ?? err), "Back to Today", () => go("#/today")));
  }
}

function wire() {
  document.querySelectorAll(".nav-item").forEach((b) => (b.onclick = () => go(`#/${b.dataset.view}`)));
  $("run-btn").onclick = runAnalysis;
  $("ws-btn").onclick = openWorkspacePicker;
  $("modal-back").addEventListener("mousedown", (e) => {
    if (e.target === $("modal-back")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("modal-back").hidden) closeModal();
  });
  window.addEventListener("hashchange", renderRoute);
}

function openWorkspacePicker() {
  const m = modal("Workspaces");
  const list = el("div", null);
  for (const w of state.status?.workspaces ?? []) {
    const b = el("button", "choice");
    b.append(el("b", null, w.name));
    b.append(el("span", null, w.id === state.status.workspace?.id ? "Open now" : "Switch to this one"));
    b.onclick = async () => {
      await api("decisionsWorkspaceSelect", { method: "POST", body: { id: w.id } });
      closeModal();
      await loadStatus();
      go("#/today");
    };
    list.append(b);
  }
  m.append(list);
  const name = field(m, "Or start a new one", Object.assign(el("input"), { type: "text", placeholder: "Another company" }));
  modalActions(m, "Create", async () => {
    const r = await api("decisionsWorkspaceCreate", { method: "POST", body: { name: name.value } });
    if (!r.ok) return toast(r.error, "bad");
    closeModal();
    await loadStatus();
    go("#/today");
  });
}

async function boot() {
  wire();
  await loadStatus();
  await renderRoute();
}

boot();
