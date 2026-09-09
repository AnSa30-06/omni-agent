// Loading and validating config/decisions/rules.json.
//
// The thresholds are data so a person can see them in Settings and change a few
// without a release. That only helps if a malformed file fails LOUDLY: a rules
// file that silently loses its `bands` array would produce a run where nothing
// is ever detected and nothing anywhere says why.
import fs from "node:fs";
import { pkg } from "../util/paths.mjs";

let _cache = null;

/** The shipped rules, parsed and validated once. */
export function rules() {
  if (_cache) return _cache;
  const raw = JSON.parse(fs.readFileSync(pkg("config", "decisions", "rules.json"), "utf8"));
  validate(raw);
  _cache = raw;
  return _cache;
}

/** Test seam: drop the cache so a fixture file can be loaded instead. */
export function clearCache() {
  _cache = null;
}

/** Validate the shape. Throws with the offending key named. */
export function validate(r) {
  const need = (cond, msg) => {
    if (!cond) throw new Error(`rules.json is invalid: ${msg}`);
  };
  need(r && typeof r === "object", "not an object");
  need(r.signals && typeof r.signals === "object", "missing `signals`");
  need(r.situations && typeof r.situations === "object", "missing `situations`");
  need(r.actionCatalogue && typeof r.actionCatalogue === "object", "missing `actionCatalogue`");
  need(r.severity && typeof r.severity.critical === "number", "missing `severity.critical`");
  need(r.limits && typeof r.limits === "object", "missing `limits`");

  for (const [id, s] of Object.entries(r.signals)) {
    need(Array.isArray(s.bands) && s.bands.length === 3, `signals.${id}.bands must be an array of 3`);
    need(typeof s.template === "string" && s.template.length > 0, `signals.${id}.template is missing`);
    need(typeof s.label === "string", `signals.${id}.label is missing`);
  }
  for (const [id, sit] of Object.entries(r.situations)) {
    if (id === "cohort_shift") continue;
    need(Array.isArray(sit.requiresAll), `situations.${id}.requiresAll must be an array`);
    need(Array.isArray(sit.actions) && sit.actions.length > 0, `situations.${id}.actions must be a non-empty array`);
    for (const a of sit.actions) {
      need(Object.hasOwn(r.actionCatalogue, a), `situations.${id} names action "${a}", which is not in actionCatalogue`);
    }
    for (const dep of [...sit.requiresAll, ...(sit.requiresAny ?? [])]) {
      need(Object.hasOwn(r.signals, dep), `situations.${id} needs signal "${dep}", which is not defined`);
    }
  }
  return r;
}

/**
 * The bands for one signal, after any per-workspace override.
 *
 * Only the FIRST band (the one that decides whether a signal fires at all) is
 * editable in the UI. Letting a user rewrite band 3 would change what "severe"
 * means without changing the word on screen.
 *
 * @param {string} signalId
 * @param {object} settings from getSettings()
 */
export function bandsFor(signalId, settings = {}) {
  const base = rules().signals[signalId]?.bands ?? [];
  const override = settings.thresholds?.[signalId];
  if (override == null || !Number.isFinite(Number(override))) return base;
  return [Number(override), ...base.slice(1)];
}

/** Which thresholds the Settings page may edit, with their current values. */
export function editableThresholds(settings = {}) {
  const r = rules();
  return ["usage_drop_30d", "renewal_near", "tickets_up_30d"].map((id) => ({
    id,
    label: r.signals[id].label,
    shipped: r.signals[id].bands[0],
    current: bandsFor(id, settings)[0],
    unit: id === "renewal_near" ? "days" : "percent",
    help:
      id === "usage_drop_30d"
        ? "How far usage must fall before it counts as a signal."
        : id === "renewal_near"
          ? "How many days before a renewal starts to count as a signal."
          : "How far ticket volume must rise before it counts as a signal.",
  }));
}

/** One limit, with the workspace override applied. */
export function limit(name, settings = {}) {
  const fromSettings = settings[name];
  if (Number.isFinite(Number(fromSettings))) return Number(fromSettings);
  return rules().limits[name];
}

/** Human label for an action id, e.g. "Executive outreach call". */
export function actionLabel(actionId) {
  return rules().actionCatalogue[actionId] ?? actionId;
}
