import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commonDir, createDiffViewer, parseDiffArgs } from "../extensions/diff-viewer.ts";
import { diffText, parseDiff, summary } from "../extensions/lib/review-diff.ts";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "diff-viewer-"));
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.mkdirSync(path.join(repo, "src"));
fs.writeFileSync(path.join(repo, "src/a.rs"), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
git("add", "."); git("commit", "-qm", "base");
const lines = fs.readFileSync(path.join(repo, "src/a.rs"), "utf8").split("\n");
lines[2] = "changed 3"; lines.splice(15, 1);
fs.writeFileSync(path.join(repo, "src/a.rs"), lines.join("\n"));
fs.writeFileSync(path.join(repo, "src/new.rs"), "fn main() {}\n");
fs.writeFileSync(path.join(repo, "src/admin.pem"), "SECRET\n");
fs.writeFileSync(path.join(repo, "scratch.txt"), "unrelated\n");

const source = parseDiffArgs("-- src", repo, repo);
assert.equal(source.worktree, true, "dirty checkout defaults to uncommitted changes");
const files = parseDiff(diffText(source, 0));
const names = files.map(f => f.file).sort();
assert.deepEqual(names, ["src/a.rs", "src/new.rs"], "untracked files under PATHs are included; secrets and other paths are not");
const a = files.find(f => f.file === "src/a.rs");
assert.equal(a.added, 1); assert.equal(a.removed, 2);
assert.match(summary(files, source), /src\/a\.rs  \+1 −2  L3, L15 \(deletion\)/, "summary lists changed line ranges, deletions at the line before");
assert.equal(commonDir(["x/y/a.rs", "x/y/z/b.rs"]), "x/y/");
assert.equal(commonDir(["a.rs", "x/b.rs"]), "");

const theme = { fg: (_c, t) => t, bold: t => t };
let closed = false;
const viewer = createDiffViewer(parseDiff(diffText(source, 3)), "uncommitted changes", theme, () => { closed = true; }, () => 14);
assert.match(viewer.render(80).join("\n"), /files in src\/[\s\S]*› a\.rs/, "list shows paths relative to the shared directory");
viewer.handleInput("\r");
const opened = viewer.render(80);
assert.ok(opened.length <= 14, "diff fits the terminal height");
assert.match(opened.join("\n"), / 3 +│-line 3/); assert.match(opened.join("\n"), / +3 │\+changed 3/);
viewer.handleInput("n");
assert.match(viewer.render(80).join("\n"), /new\.rs[\s\S]*1 │\+fn main/, "n moves to the next file");
viewer.handleInput("\x1b"); viewer.handleInput("\x1b");
assert.ok(closed, "Esc goes back, then closes");
fs.rmSync(repo, { recursive: true });
console.log("Passed 12 diff viewer checks.");

// Vim motions: counts, Ctrl+D/U, gg/G, {/} between hunks.
{
	const { createVimKeys, applyMotion } = await import("../extensions/lib/vim-keys.ts");
	const vim = createVimKeys();
	assert.equal(vim.feed("5"), "pending"); assert.deepEqual(vim.feed("j"), { kind: "line", by: 5 }, "count prefix");
	assert.deepEqual(vim.feed("\x04"), { kind: "halfPage", by: 1 }, "Ctrl+D"); assert.deepEqual(vim.feed("\x15"), { kind: "halfPage", by: -1 }, "Ctrl+U");
	assert.deepEqual(vim.feed("\x06"), { kind: "page", by: 1 }, "Ctrl+F"); assert.deepEqual(vim.feed("\x02"), { kind: "page", by: -1 }, "Ctrl+B");
	assert.equal(vim.feed("g"), "pending"); assert.deepEqual(vim.feed("g"), { kind: "top" }, "gg");
	assert.deepEqual(vim.feed("G"), { kind: "bottom" }); vim.feed("4"); vim.feed("2"); assert.deepEqual(vim.feed("G"), { kind: "goto", line: 42 }, "42G");
	assert.deepEqual(vim.feed("0"), { kind: "panStart" }, "0 without a count pans to column 0");
	assert.equal(applyMotion({ kind: "halfPage", by: 1 }, 0, 20, 100), 10);
	assert.equal(applyMotion({ kind: "section", by: 1 }, 0, 10, 100, [5, 30, 60]), 5);
	assert.equal(applyMotion({ kind: "section", by: 2 }, 0, 10, 100, [5, 30, 60]), 30);
	assert.equal(applyMotion({ kind: "section", by: -1 }, 30, 10, 100, [5, 30, 60]), 5);
	assert.equal(applyMotion({ kind: "bottom" }, 0, 10, 100), 90);
	console.log("Passed 14 vim motion checks.");
}
