import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCsv, toCsv, analyzeData, writeDocument, readDocument } from "../../src/tools/documents.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-doc-"));

test("CSV parser handles quoted delimiters, escaped quotes and CRLF", () => {
  const rows = parseCsv('a,b,c\r\n1,"x,y","he said ""hi"""\r\n');
  assert.deepEqual(rows[0], ["a", "b", "c"]);
  assert.deepEqual(rows[1], ["1", "x,y", 'he said "hi"']);
});

test("CSV parser keeps newlines that are inside quotes", () => {
  const rows = parseCsv('a,b\n1,"line1\nline2"\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], "line1\nline2");
});

test("toCsv round-trips values that need quoting", () => {
  const original = [["a", "b"], ["x,y", 'q"q']];
  assert.deepEqual(parseCsv(toCsv(original)), original);
});

test("analyzeData types columns and counts missing values", async () => {
  const file = path.join(tmp, "s.csv");
  fs.writeFileSync(file, "name,amount\nA,10\nB,20\nC,\n");
  const r = await analyzeData(file);
  assert.equal(r.rowCount, 3);
  const amount = r.columns.find((c) => c.name === "amount");
  assert.equal(amount.type, "numeric");
  assert.equal(amount.missing, 1);
  assert.equal(amount.mean, 15);
  assert.equal(amount.min, 10);
  assert.equal(amount.max, 20);
});

test("a numeric column wearing currency symbols is still recognised", async () => {
  const file = path.join(tmp, "money.csv");
  fs.writeFileSync(file, "item,price\nA,$1200\nB,$800\n");
  const r = await analyzeData(file);
  assert.equal(r.columns.find((c) => c.name === "price").type, "numeric");
});

test("writeDocument turns records into a CSV with a header row", async () => {
  const file = path.join(tmp, "out.csv");
  await writeDocument(file, [{ a: 1, b: "x" }, { a: 2, b: "y" }]);
  const back = await readDocument(file);
  assert.equal(back.rowCount, 2);
  assert.deepEqual(back.headers, ["a", "b"]);
  assert.equal(back.records[1].b, "y");
});

test("xlsx write then read preserves records", async () => {
  const file = path.join(tmp, "out.xlsx");
  await writeDocument(file, [{ name: "Ada", role: "Analyst" }]);
  const back = await readDocument(file);
  assert.equal(back.kind, "xlsx");
  assert.deepEqual(back.sheets[0].records, [{ name: "Ada", role: "Analyst" }]);
});

test("reading a missing file fails with a useful message", async () => {
  await assert.rejects(() => readDocument(path.join(tmp, "nope.txt")), /file not found/);
});

test("analysing a non-tabular file is refused rather than guessed at", async () => {
  const file = path.join(tmp, "a.txt");
  fs.writeFileSync(file, "just prose");
  await assert.rejects(() => analyzeData(file), /cannot analyse/);
});
