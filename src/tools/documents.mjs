// Documents and structured data.
//
// Reading and writing are deliberately in one module because the agent's real
// tasks cross the boundary constantly ("read this PDF, put the fields in a
// spreadsheet"). Everything leans on a mature library; nothing here reimplements
// a file format.
//
//   PDF   pdfjs-dist (Mozilla)   read
//   DOCX  mammoth                read
//   XLSX  exceljs                read + write
//   CSV   hand-rolled RFC4180    read + write   (a 40-line parser beats a dep)
//   JSON/TXT/MD  node builtins   read + write
import fs from "node:fs";
import path from "node:path";
import { logger } from "../util/log.mjs";

const log = logger("documents");

const MAX_BYTES = 100 * 1024 * 1024;

function assertReadable(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error("file not found: " + abs);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error("path is a directory: " + abs);
  if (st.size > MAX_BYTES) throw new Error("file too large (" + st.size + " bytes): " + abs);
  return abs;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC4180-ish parser: handles quotes, escaped quotes, embedded newlines, CRLF. */
export function parseCsv(text, { delimiter = "," } = {}) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delimiter) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

export function toCsv(rows, { delimiter = "," } = {}) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /["\n\r]|^\s|\s$/.test(s) || s.includes(delimiter) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(esc).join(delimiter)).join("\r\n");
}

/** Array-of-objects from a CSV, using the first row as headers. */
function csvToRecords(rows) {
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => (o[h] = r[i] ?? ""));
    return o;
  });
  return { headers, records };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

async function readPdf(abs, { maxPages = 200 } = {}) {
  // pdfjs is an ESM/worker-oriented build; the legacy entry is the one that
  // runs headless in Node without a DOM.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(abs));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Group items into lines by their y position, so the text reads in order
    // rather than as a bag of fragments.
    const lines = new Map();
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: item.transform[4], s: item.str });
    }
    const text = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => items.sort((a, b) => a.x - b.x).map((i) => i.s).join("").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    pages.push({ page: i, text });
  }
  const meta = await doc.getMetadata().catch(() => null);
  return {
    kind: "pdf",
    pageCount: doc.numPages,
    pagesRead: n,
    title: meta?.info?.Title || null,
    author: meta?.info?.Author || null,
    pages,
    text: pages.map((p) => "--- page " + p.page + " ---\n" + p.text).join("\n\n"),
  };
}

async function readDocx(abs) {
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  const { value, messages } = await mammoth.extractRawText({ path: abs });
  return { kind: "docx", text: value.trim(), warnings: (messages || []).map((m) => m.message).slice(0, 10) };
}

async function readXlsx(abs, { maxRows = 5000 } = {}) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n > maxRows) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map((v) => (v && typeof v === "object" && "result" in v ? v.result : v && typeof v === "object" && "text" in v ? v.text : v ?? "")));
    });
    const { headers, records } = csvToRecords(rows.map((r) => r.map((c) => (c == null ? "" : String(c)))));
    sheets.push({ name: ws.name, rowCount: rows.length, headers, records });
  });
  return { kind: "xlsx", sheetCount: sheets.length, sheets };
}

/**
 * Read any supported document.
 * @param {string} file
 * @param {{maxChars?:number, maxPages?:number}} [opts]
 */
export async function readDocument(file, opts = {}) {
  const abs = assertReadable(file);
  const ext = path.extname(abs).toLowerCase();
  const maxChars = opts.maxChars ?? 200000;
  log.info("reading document", { ext, bytes: fs.statSync(abs).size });

  let result;
  if (ext === ".pdf") result = await readPdf(abs, opts);
  else if (ext === ".docx") result = await readDocx(abs);
  else if (ext === ".xlsx" || ext === ".xlsm") result = await readXlsx(abs, opts);
  else if (ext === ".csv" || ext === ".tsv") {
    const raw = fs.readFileSync(abs, "utf8");
    const rows = parseCsv(raw, { delimiter: ext === ".tsv" ? "\t" : "," });
    const { headers, records } = csvToRecords(rows);
    result = { kind: "csv", rowCount: records.length, headers, records, text: raw };
  } else if (ext === ".json") {
    const raw = fs.readFileSync(abs, "utf8");
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) { throw new Error("invalid JSON in " + abs + ": " + err.message); }
    result = { kind: "json", data: parsed, text: raw };
  } else {
    // txt, md, code, anything else textual
    result = { kind: "text", text: fs.readFileSync(abs, "utf8") };
  }

  result.path = abs;
  result.filename = path.basename(abs);
  if (typeof result.text === "string" && result.text.length > maxChars) {
    result.truncated = true;
    result.originalChars = result.text.length;
    result.text = result.text.slice(0, maxChars);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export async function writeDocument(file, content, { format } = {}) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const ext = (format ? "." + format : path.extname(abs)).toLowerCase();

  if (ext === ".csv") {
    const rows = Array.isArray(content) && Array.isArray(content[0])
      ? content
      : recordsToRows(content);
    fs.writeFileSync(abs, toCsv(rows), "utf8");
    return { path: abs, format: "csv", rows: rows.length };
  }

  if (ext === ".xlsx") {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const sheetsInput = Array.isArray(content) ? [{ name: "Sheet1", rows: content }] : Object.entries(content).map(([name, rows]) => ({ name, rows }));
    for (const { name, rows } of sheetsInput) {
      const ws = wb.addWorksheet(String(name).slice(0, 31));
      const asRows = Array.isArray(rows) && Array.isArray(rows[0]) ? rows : recordsToRows(rows);
      asRows.forEach((r) => ws.addRow(r));
      if (asRows.length) ws.getRow(1).font = { bold: true };
    }
    await wb.xlsx.writeFile(abs);
    return { path: abs, format: "xlsx", sheets: sheetsInput.length };
  }

  if (ext === ".json") {
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(abs, text, "utf8");
    return { path: abs, format: "json", bytes: Buffer.byteLength(text) };
  }

  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(abs, text, "utf8");
  return { path: abs, format: ext.replace(".", "") || "txt", bytes: Buffer.byteLength(text) };
}

function recordsToRows(records) {
  if (!Array.isArray(records) || !records.length) return [];
  const headers = [...new Set(records.flatMap((r) => Object.keys(r ?? {})))];
  return [headers, ...records.map((r) => headers.map((h) => r?.[h] ?? ""))];
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function numeric(values) {
  const nums = values.map((v) => (typeof v === "number" ? v : Number(String(v).replace(/[$,%\s,]/g, "")))).filter((n) => Number.isFinite(n));
  return nums;
}

function describeColumn(name, values) {
  const nonEmpty = values.filter((v) => v !== "" && v != null);
  const nums = numeric(nonEmpty);
  const isNumeric = nonEmpty.length > 0 && nums.length / nonEmpty.length >= 0.8;
  const col = {
    name,
    count: values.length,
    nonEmpty: nonEmpty.length,
    missing: values.length - nonEmpty.length,
    distinct: new Set(nonEmpty.map(String)).size,
    type: isNumeric ? "numeric" : "text",
  };
  if (isNumeric && nums.length) {
    const sorted = [...nums].sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0);
    const mean = sum / nums.length;
    col.min = sorted[0];
    col.max = sorted[sorted.length - 1];
    col.sum = Number(sum.toFixed(6));
    col.mean = Number(mean.toFixed(6));
    col.median = sorted[Math.floor(sorted.length / 2)];
    col.stdev = Number(Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length).toFixed(6));
  } else {
    const freq = new Map();
    for (const v of nonEmpty) freq.set(String(v), (freq.get(String(v)) ?? 0) + 1);
    col.top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, n]) => ({ value, n }));
  }
  return col;
}

/**
 * Summary statistics for a tabular file (CSV/TSV/XLSX/JSON-array).
 * Deterministic and local - no model call, so it costs no tokens.
 */
export async function analyzeData(file, opts = {}) {
  const doc = await readDocument(file, { maxChars: Number.MAX_SAFE_INTEGER, ...opts });
  let records = [];
  let source = doc.kind;
  if (doc.kind === "csv") records = doc.records;
  else if (doc.kind === "xlsx") {
    const sheet = opts.sheet ? doc.sheets.find((s) => s.name === opts.sheet) : doc.sheets[0];
    if (!sheet) throw new Error("sheet not found: " + opts.sheet);
    records = sheet.records;
    source = "xlsx:" + sheet.name;
  } else if (doc.kind === "json") {
    if (Array.isArray(doc.data)) records = doc.data;
    else throw new Error("JSON analysis needs an array of objects at the top level");
  } else throw new Error("cannot analyse a " + doc.kind + " file as a table");

  if (!records.length) return { path: doc.path, source, rowCount: 0, columns: [], note: "no data rows" };

  const headers = [...new Set(records.flatMap((r) => Object.keys(r ?? {})))];
  const columns = headers.map((h) => describeColumn(h, records.map((r) => r?.[h] ?? "")));
  return {
    path: doc.path,
    source,
    rowCount: records.length,
    columnCount: headers.length,
    columns,
    sample: records.slice(0, 5),
  };
}
