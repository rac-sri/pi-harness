import assert from "node:assert/strict";
import path from "node:path";
import { root, jiti } from "./lib/loader.mjs";

const { createHashlineStore, renderRead, applyEdits } = await jiti.import(path.join(root, "extensions/lib/hashline.ts"));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const rejects = (fn, code, label) => { assert.throws(fn, error => error.code === code, label); checks++; };
const FILE = "/repo/src/sig.ts";
const OTHER = "/repo/src/other.ts";
const tagOf = text => /^\[[^\]]*#([0-9A-F]{4})\]/.exec(text)[1];
const fresh = (raw, opts = {}, file = FILE) => { const store = createHashlineStore(); const read = renderRead(store, file, "src/sig.ts", raw, opts); return { store, read, tag: read.tag }; };
const source = "a\nb\nc\nd\ne\n";

// Read format: snapshot header plus numbered lines; tag is derived from content.
{
  const { read } = fresh(source);
  check(read.text.startsWith(`[src/sig.ts#${read.tag}]\n1:a\n2:b\n`), "read renders header and numbered lines");
  check(tagOf(read.text) === read.tag && /^[0-9A-F]{4}$/.test(read.tag), "tag is four uppercase hex characters");
  check(fresh("a\nb\nc\nd\ne\n").tag === read.tag && fresh("a\nb\nc\nd\nE\n").tag !== read.tag, "tag follows content");
  const window = fresh(source, { offset: 2, limit: 2 }).read.text;
  check(window.includes("2:b\n3:c") && !window.includes("1:a") && !window.includes("4:d") && /offset=4/.test(window), "offset/limit window with continuation hint");
  check(fresh("").read.text.includes("empty file"), "empty file is labeled");
}

// Replace applies, returns a new tag, and the new tag chains without a re-read.
{
  const { store, tag } = fresh(source);
  const first = applyEdits(store, FILE, "src/sig.ts", source, tag, [{ op: "replace", start: 2, end: 3, text: "B\nC" }]);
  check(first.raw === "a\nB\nC\nd\ne\n", "replace rewrites inclusive range");
  check(first.tag !== tag && first.text.includes(`#${first.tag}]`) && first.text.includes("2:B"), "result carries new tag and changed lines");
  const second = applyEdits(store, FILE, "src/sig.ts", first.raw, first.tag, [{ op: "insert", after: 5, text: "f" }]);
  check(second.raw === "a\nB\nC\nd\ne\nf\n", "chained edit with returned tag");
}

// Multiple edits use original numbering; insert/delete edges.
{
  const { store, tag } = fresh(source);
  const result = applyEdits(store, FILE, "src/sig.ts", source, tag, [{ op: "insert", after: 0, text: "top" }, { op: "delete", start: 2, end: 2 }, { op: "replace", start: 5, end: 5, text: "E" }]);
  check(result.raw === "top\na\nc\nd\nE\n", "batched edits apply against the read snapshot");
  const blank = fresh(source);
  check(applyEdits(blank.store, FILE, "src/sig.ts", source, blank.tag, [{ op: "replace", start: 1, end: 1, text: "" }]).raw === "\nb\nc\nd\ne\n", "empty replacement text is one blank line");
  const empty = fresh("");
  check(applyEdits(empty.store, FILE, "src/sig.ts", "", empty.tag, [{ op: "insert", after: 0, text: "x" }]).raw === "x\n", "insert into empty file");
}

// Line endings, BOM and missing final newline are preserved.
{
  const crlf = "\uFEFFa\r\nb\r\nc";
  const { store, tag, read } = fresh(crlf);
  check(read.text.includes("1:a\n2:b\n3:c") && !read.text.includes("\r") && !read.text.includes("\uFEFF"), "read hides CR and BOM");
  check(applyEdits(store, FILE, "src/sig.ts", crlf, tag, [{ op: "replace", start: 2, end: 2, text: "B" }]).raw === "\uFEFFa\r\nB\r\nc", "CRLF, BOM and no final newline preserved");
  const open = fresh("a\nb");
  check(applyEdits(open.store, FILE, "src/sig.ts", "a\nb", open.tag, [{ op: "insert", after: 2, text: "c" }]).raw === "a\nb\nc", "appending keeps a missing final newline missing");
}

// Tags are bound to the file and the session.
{
  const { store, tag } = fresh(source);
  rejects(() => applyEdits(store, FILE, "src/sig.ts", source, "0000", [{ op: "delete", start: 1, end: 1 }]), "E_UNKNOWN_TAG", "unknown tag rejected");
  renderRead(store, OTHER, "src/other.ts", "x\n", {});
  assert.throws(() => applyEdits(store, OTHER, "src/other.ts", "x\n", tag, [{ op: "delete", start: 1, end: 1 }]), error => error.code === "E_UNKNOWN_TAG" && error.message.includes(FILE)); checks++;
}

// Stale anchors: edited lines changed -> reject; only unchanged, uniquely placed lines may shift.
{
  const { store, tag } = fresh(source);
  rejects(() => applyEdits(store, FILE, "src/sig.ts", "a\nb\nX\nd\ne\n", tag, [{ op: "replace", start: 3, end: 3, text: "C" }]), "E_STALE", "changed target line rejected");
  rejects(() => applyEdits(store, FILE, "src/sig.ts", "a\nX\nc\nd\ne\n", tag, [{ op: "replace", start: 3, end: 3, text: "C" }]), "E_STALE", "changed context line rejected");
  const shifted = applyEdits(store, FILE, "src/sig.ts", "new1\nnew2\na\nb\nc\nd\ne\n", tag, [{ op: "replace", start: 3, end: 3, text: "C" }]);
  check(shifted.raw === "new1\nnew2\na\nb\nC\nd\ne\n" && shifted.recovered && /shift/i.test(shifted.text), "unchanged lines shifted by an external insert are recovered with a warning");
  const long = "p\nq\nr\ns\nt\nu\nv\nw\nx\ny\n";
  const split = fresh(long);
  const middleInsert = "p\nq\nr\ns\nt\nNEW\nu\nv\nw\nx\ny\n";
  check(applyEdits(split.store, FILE, "src/sig.ts", middleInsert, split.tag, [{ op: "delete", start: 9, end: 9 }]).raw === "p\nq\nr\ns\nt\nNEW\nu\nv\nw\ny\n", "single edit below an external insert recovers");
  rejects(() => applyEdits(split.store, FILE, "src/sig.ts", middleInsert, split.tag, [{ op: "delete", start: 2, end: 2 }, { op: "delete", start: 9, end: 9 }]), "E_STALE", "edits with different shifts rejected");
  const dup = "x\ny\nz\nk\nm\n";
  const repeated = fresh(dup);
  rejects(() => applyEdits(repeated.store, FILE, "src/sig.ts", "x\ny\nz\nk\nm\nx\ny\nz\nk\nm\n", repeated.tag, [{ op: "replace", start: 3, end: 3, text: "Z" }]), "E_STALE", "ambiguous duplicated region rejected");
}

// Edits must target lines the model actually saw in full.
{
  const { store, tag } = fresh(source, { offset: 1, limit: 2 });
  rejects(() => applyEdits(store, FILE, "src/sig.ts", source, tag, [{ op: "replace", start: 4, end: 4, text: "D" }]), "E_UNSERVED", "edit outside the served window rejected");
  check(applyEdits(store, FILE, "src/sig.ts", source, tag, [{ op: "replace", start: 2, end: 2, text: "B" }]).raw === "a\nB\nc\nd\ne\n", "edit inside served window allowed");
  const longLine = "x".repeat(50) + "\nshort\n";
  const truncated = fresh(longLine, { maxLineChars: 10 });
  check(truncated.read.text.includes("1:xxxxxxxxxx") && /truncated/i.test(truncated.read.text), "long lines are truncated visibly");
  rejects(() => applyEdits(truncated.store, FILE, "src/sig.ts", longLine, truncated.tag, [{ op: "replace", start: 1, end: 1, text: "y" }]), "E_UNSERVED", "truncated line cannot be replaced blind");
}

// Malformed batches are rejected before any write.
{
  const { store, tag } = fresh(source);
  const bad = (edits, code, label) => rejects(() => applyEdits(store, FILE, "src/sig.ts", source, tag, edits), code, label);
  bad([{ op: "replace", start: 2, end: 3, text: "x" }, { op: "delete", start: 3, end: 4 }], "E_OVERLAP", "overlapping ranges rejected");
  bad([{ op: "replace", start: 2, end: 3, text: "x" }, { op: "insert", after: 2, text: "y" }], "E_OVERLAP", "insert inside a replaced range rejected");
  bad([{ op: "replace", start: 2, end: 3, text: "x" }, { op: "insert", after: 3, text: "y" }], "E_OVERLAP", "insert after a replaced range end rejected");
  bad([{ op: "insert", after: 1, text: "x" }, { op: "insert", after: 1, text: "y" }], "E_OVERLAP", "two inserts at one gap rejected");
  bad([{ op: "delete", start: 5, end: 6 }], "E_RANGE", "range past EOF rejected");
  bad([{ op: "delete", start: 3, end: 2 }], "E_RANGE", "inverted range rejected");
  bad([{ op: "insert", after: 6, text: "x" }], "E_RANGE", "insert past EOF rejected");
  bad([], "E_RANGE", "empty batch rejected");
  bad([{ op: "replace", start: 2, end: 3, text: "2:B\n3:C" }], "E_PREFIXED", "payload copied with line-number prefixes rejected");
  check(applyEdits(store, FILE, "src/sig.ts", source, tag, [{ op: "replace", start: 2, end: 2, text: "8080:80" }]).raw === "a\n8080:80\nc\nd\ne\n", "colon-number payload far from the range is allowed");
  check(applyEdits(store, FILE, "src/sig.ts", source, tag, [{ op: "insert", after: 1, text: "b0\n" }]).raw === "a\nb0\nb\nc\nd\ne\n", "one trailing newline in payload is not an extra line");
}

// Tool wrapper: real files, registered names, fail-closed writes.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tools = new Map();
  (await jiti.import(path.join(root, "extensions/hashline/tool.ts"))).default({ registerTool: tool => tools.set(tool.name, tool) });
  check(tools.has("read") && tools.has("hashline_edit") && !tools.has("edit"), "registers read and hashline_edit only");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hashline-"));
  try {
    const target = path.join(dir, "mod.rs");
    fs.writeFileSync(target, "fn a() {}\nfn b() {}\n");
    const ctx = { cwd: dir };
    const text = result => result.content.map(part => part.text).join("");
    const read = text(await tools.get("read").execute("r1", { path: "mod.rs" }, undefined, undefined, ctx));
    const tag = tagOf(read);
    const edited = await tools.get("hashline_edit").execute("e1", { path: "mod.rs", tag, edits: [{ op: "replace", start: 2, end: 2, text: "fn b() { todo!() }" }] }, undefined, undefined, ctx);
    check(fs.readFileSync(target, "utf8") === "fn a() {}\nfn b() { todo!() }\n" && typeof edited.details?.diff === "string", "edit writes file and reports a diff");
    fs.writeFileSync(target, "fn a() {}\nfn b() { changed }\n");
    await assert.rejects(tools.get("hashline_edit").execute("e2", { path: "mod.rs", tag: tagOf(text(edited)), edits: [{ op: "replace", start: 2, end: 2, text: "x" }] }, undefined, undefined, ctx), /E_STALE/); checks++;
    check(fs.readFileSync(target, "utf8") === "fn a() {}\nfn b() { changed }\n", "rejected edit leaves the file untouched");
    await assert.rejects(tools.get("hashline_edit").execute("e3", { path: "missing.rs", tag, edits: [{ op: "delete", start: 1, end: 1 }] }, undefined, undefined, ctx), /E_UNKNOWN_TAG|not found|ENOENT/); checks++;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log(`Passed ${checks} hashline checks.`);
