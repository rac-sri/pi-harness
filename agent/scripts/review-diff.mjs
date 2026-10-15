#!/usr/bin/env node
/**
 * Checkpoint review summary: files changed in a git range with the changed line ranges, and
 * optionally a self-contained HTML diff.
 *
 *   node ~/.pi/agent/scripts/review-diff.mjs [--repo DIR] [--html] [RANGE]
 *
 * RANGE is anything `git diff` takes (default HEAD~1..HEAD). Line ranges are on the new side
 * of the diff, so `path:L12` opens the right place in the current checkout; a pure deletion is
 * shown at the line it sat before. One line per file: `path  +added −removed  L12-30, L88`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const option = name => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
const html = flag("--html");
const repo = path.resolve(option("--repo") ?? ".");
const range = args[0] ?? "HEAD~1..HEAD";
const git = (...rest) => execFileSync("git", ["-C", repo, ...rest], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Changed new-side line ranges per file, from a zero-context diff. */
function changedRanges(diff) {
	const files = new Map();
	let current;
	for (const line of diff.split("\n")) {
		const header = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/.exec(line);
		if (header) { current = header[1]; if (current && !files.has(current)) files.set(current, []); continue; }
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk && current) {
			const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
			files.get(current).push(count === 0 ? { start: Math.max(1, start), end: Math.max(1, start), deleted: true } : { start, end: start + count - 1 });
		}
	}
	return files;
}

const formatRanges = ranges => ranges.map(r => `L${r.start}${r.end > r.start ? `-${r.end}` : ""}${r.deleted ? " (deletion)" : ""}`);

const numstat = git("diff", "--numstat", "-M", range).trim().split("\n").filter(Boolean).map(line => {
	const [added, removed, ...name] = line.split("\t");
	// Renames print as "old => new" or "dir/{old => new}"; keep the new path.
	const file = name.join("\t").replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/\//g, "/");
	return { file, added: added === "-" ? "bin" : Number(added), removed: removed === "-" ? "bin" : Number(removed) };
});
const ranges = changedRanges(git("diff", "--no-color", "-U0", "-M", range));
const total = (key) => numstat.reduce((sum, entry) => sum + (typeof entry[key] === "number" ? entry[key] : 0), 0);

console.log(`${numstat.length} file${numstat.length === 1 ? "" : "s"} changed, +${total("added")} −${total("removed")} (${range}, ${repo})\n`);
for (const entry of numstat) {
	const where = formatRanges(ranges.get(entry.file) ?? []);
	console.log(`${entry.file}  +${entry.added} −${entry.removed}  ${where.length ? where.join(", ") : "(removed or binary)"}`);
}

if (html) {
	const escape = text => text.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	const diff = git("diff", "--no-color", "-U5", "-M", range);
	const sections = [];
	let rows = [], file, oldLine = 0, newLine = 0;
	const flush = () => { if (file) sections.push({ file, rows }); rows = []; };
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) { flush(); file = /^diff --git a\/.* b\/(.*)$/.exec(line)?.[1] ?? line; continue; }
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
		if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); rows.push(`<tr class="hunk"><td></td><td></td><td>${escape(line)}</td></tr>`); continue; }
		if (!rows.length || /^(---|\+\+\+|index |similarity |rename |new file|deleted file|Binary)/.test(line)) {
			if (/^Binary|^rename |^new file|^deleted file/.test(line)) rows.push(`<tr class="meta"><td></td><td></td><td>${escape(line)}</td></tr>`);
			continue;
		}
		if (line.startsWith("+")) rows.push(`<tr class="add"><td></td><td>${newLine++}</td><td>${escape(line)}</td></tr>`);
		else if (line.startsWith("-")) rows.push(`<tr class="del"><td>${oldLine++}</td><td></td><td>${escape(line)}</td></tr>`);
		else if (line.startsWith(" ")) rows.push(`<tr><td>${oldLine++}</td><td>${newLine++}</td><td>${escape(line)}</td></tr>`);
	}
	flush();
	const stat = new Map(numstat.map(entry => [entry.file, entry]));
	const id = index => `f${index}`;
	const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review ${escape(range)}</title><style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--add:#dafbe1;--del:#ffebe9;--hunk:#ddf4ff;--head:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--add:#12261e;--del:#25171c;--hunk:#121d2f;--head:#161b22}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1400px;margin:0 auto;padding:16px}h1{font-size:18px;margin:0 0 4px}.muted{color:var(--muted)}
nav ul{list-style:none;padding:0;margin:12px 0 24px}nav li{padding:2px 0}a{color:inherit}
.n{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.plus{color:#1a7f37}.minus{color:#cf222e}
section{border:1px solid var(--line);border-radius:6px;margin:0 0 20px;overflow:hidden}
section h2{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:8px 12px;background:var(--head);border-bottom:1px solid var(--line);position:sticky;top:0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
td{padding:0 8px;white-space:pre;vertical-align:top}td:nth-child(-n+2){width:1%;text-align:right;color:var(--muted);user-select:none}
tr.add{background:var(--add)}tr.del{background:var(--del)}tr.hunk,tr.meta{background:var(--hunk);color:var(--muted)}
</style></head><body><main><h1>${escape(range)}</h1><div class="muted">${escape(repo)} · ${numstat.length} files · <span class="plus">+${total("added")}</span> <span class="minus">−${total("removed")}</span></div>
<nav><ul>${sections.map((s, i) => { const e = stat.get(s.file); return `<li><a href="#${id(i)}">${escape(s.file)}</a> <span class="n">${e ? `<span class="plus">+${e.added}</span> <span class="minus">−${e.removed}</span>` : ""}</span></li>`; }).join("")}</ul></nav>
${sections.map((s, i) => `<section id="${id(i)}"><h2>${escape(s.file)}</h2><div class="scroll"><table>${s.rows.join("")}</table></div></section>`).join("\n")}
</main></body></html>`;
	// /tmp, not os.tmpdir(): the bash sandbox allows writes to /tmp only.
	const dir = "/tmp/pi-review";
	fs.mkdirSync(dir, { recursive: true });
	const out = path.join(dir, `${path.basename(repo).replace(/^\.+/, "")}-${range.replace(/[^\w.-]+/g, "_").slice(0, 80)}.html`);
	fs.writeFileSync(out, page);
	console.log(`\nHTML diff: ${out}`);
}
