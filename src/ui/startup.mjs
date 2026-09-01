// What the app is doing while it starts, for the page to show.
//
// The window opens BEFORE the gateway and the agent are started (see
// launch.mjs), so for the first half-minute of a cold start the page has
// nothing behind it. This is the one thing it can ask: how far along is the
// start, and did something go wrong. Written by launch.mjs, read by the
// `status` route, and the reason the startup screen can say "Starting the
// model gateway... 34s" instead of nothing.
const state = {
  ready: false,
  since: Date.now(),
  steps: [],
  problem: null,
};

let retryFn = null;
let retrying = false;

/** Reset to a fresh start with the given ordered steps. */
export function startupBegin(steps) {
  state.ready = false;
  state.since = Date.now();
  state.problem = null;
  state.steps = steps.map(({ id, label }) => ({ id, label, status: "pending", note: null }));
}

/** @param {"pending"|"running"|"done"|"failed"} status */
export function startupStep(id, status, note = null) {
  const s = state.steps.find((x) => x.id === id);
  if (!s) return;
  s.status = status;
  s.note = note;
}

/**
 * A problem the page has to show instead of the app - written for someone
 * who cannot fix a computer, with the one thing they can actually do.
 *
 * @param {{title:string, detail?:string|null, action?:"setup"|"retry", actionLabel?:string|null}} p
 */
export function startupProblem(p) {
  state.problem = {
    title: p.title,
    detail: p.detail ?? null,
    action: p.action ?? "retry",
    actionLabel: p.actionLabel ?? null,
  };
}

export function startupReady() {
  state.ready = true;
  state.problem = null;
}

export function startupSnapshot() {
  return {
    ready: state.ready,
    since: state.since,
    elapsedMs: Date.now() - state.since,
    retrying,
    steps: state.steps.map((s) => ({ ...s })),
    problem: state.problem ? { ...state.problem } : null,
  };
}

/** launch.mjs registers how to try again; the `startupRetry` route calls it. */
export function onRetry(fn) {
  retryFn = fn;
}

/**
 * Run the registered retry, once at a time. Not awaited by the route that
 * calls it - a retry takes as long as a start, and the page is polling the
 * snapshot anyway.
 */
export function retry() {
  if (!retryFn) return { ok: false, reason: "nothing to retry" };
  if (retrying) return { ok: true, reason: "already-retrying" };
  retrying = true;
  Promise.resolve()
    .then(() => retryFn())
    .catch((err) => startupProblem({ title: "Omni Agent could not start", detail: String(err?.message ?? err) }))
    .finally(() => {
      retrying = false;
    });
  return { ok: true };
}
