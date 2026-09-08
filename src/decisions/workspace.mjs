// Workspaces: a named company, its SQLite file, and the copies of whatever was
// imported into it.
//
// One file per workspace rather than one database with a workspace column,
// because "delete this company's data" then means deleting a directory, and
// there is no query anywhere that can accidentally read across two companies.
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../util/paths.mjs";
import { open, getMeta, setMeta, getSettings, setSettings } from "./db.mjs";
import { workspaceId } from "./ids.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/workspace");

export function root() {
  return path.join(PATHS.home, "decisions");
}
function indexFile() {
  return path.join(root(), "workspaces.json");
}
export function dirFor(id) {
  return path.join(root(), id);
}
export function dbFileFor(id) {
  return path.join(dirFor(id), "decisions.sqlite");
}
export function importsDir(id) {
  return path.join(dirFor(id), "imports");
}

function readIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), "utf8"));
    return { selected: raw.selected ?? null, workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [] };
  } catch {
    return { selected: null, workspaces: [] };
  }
}

function writeIndex(idx) {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(idx, null, 2));
}

export function list() {
  const idx = readIndex();
  // A workspace whose directory has been deleted by hand is dropped rather
  // than offered as a choice that will fail on the next click.
  const alive = idx.workspaces.filter((w) => fs.existsSync(dbFileFor(w.id)));
  if (alive.length !== idx.workspaces.length) writeIndex({ ...idx, workspaces: alive });
  return { workspaces: alive, selected: alive.some((w) => w.id === idx.selected) ? idx.selected : (alive[0]?.id ?? null) };
}

export function create(name) {
  const clean = String(name ?? "").trim();
  if (!clean) return { ok: false, error: "give the workspace a name" };
  const idx = readIndex();
  const ws = { id: workspaceId(), name: clean, createdAt: new Date().toISOString(), lastRunAt: null };
  fs.mkdirSync(dirFor(ws.id), { recursive: true });
  const db = open(dbFileFor(ws.id));
  setMeta(db, "workspace_name", clean);
  db.close();
  writeIndex({ selected: ws.id, workspaces: [...idx.workspaces, ws] });
  log.info("workspace created", { id: ws.id });
  return { ok: true, workspace: ws };
}

export function select(id) {
  const idx = readIndex();
  if (!idx.workspaces.some((w) => w.id === id)) return { ok: false, error: "no such workspace" };
  writeIndex({ ...idx, selected: id });
  return { ok: true, selected: id };
}

export function rename(id, name) {
  const clean = String(name ?? "").trim();
  if (!clean) return { ok: false, error: "give the workspace a name" };
  const idx = readIndex();
  const ws = idx.workspaces.find((w) => w.id === id);
  if (!ws) return { ok: false, error: "no such workspace" };
  ws.name = clean;
  writeIndex(idx);
  const db = openWorkspace(id);
  setMeta(db, "workspace_name", clean);
  db.close();
  return { ok: true, workspace: ws };
}

/**
 * Delete a workspace and every byte of its data.
 * `confirmName` must match, because this cannot be undone and there is no bin.
 */
export function remove(id, confirmName) {
  const idx = readIndex();
  const ws = idx.workspaces.find((w) => w.id === id);
  if (!ws) return { ok: false, error: "no such workspace" };
  if (String(confirmName ?? "").trim() !== ws.name) {
    return { ok: false, error: `type the workspace name exactly ("${ws.name}") to confirm` };
  }
  try {
    fs.rmSync(dirFor(id), { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: `the data could not be deleted: ${err.message}` };
  }
  const rest = idx.workspaces.filter((w) => w.id !== id);
  writeIndex({ selected: rest[0]?.id ?? null, workspaces: rest });
  log.info("workspace deleted", { id });
  return { ok: true, deleted: id };
}

export function touchRun(id) {
  const idx = readIndex();
  const ws = idx.workspaces.find((w) => w.id === id);
  if (ws) {
    ws.lastRunAt = new Date().toISOString();
    writeIndex(idx);
  }
}

/** Open the database for one workspace. The caller closes it. */
export function openWorkspace(id) {
  if (!id) throw new Error("no workspace selected");
  return open(dbFileFor(id));
}

/** Open the currently selected workspace, or null when there is none. */
export function openSelected() {
  const { selected } = list();
  if (!selected) return null;
  return { id: selected, db: openWorkspace(selected) };
}

export function info(id) {
  const idx = readIndex();
  return idx.workspaces.find((w) => w.id === id) ?? null;
}

export { getMeta, setMeta, getSettings, setSettings };
