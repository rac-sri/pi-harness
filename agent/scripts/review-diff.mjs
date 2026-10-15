#!/usr/bin/env node
/**
 * Checkpoint review summary: files changed in a git range with the changed line ranges, and
 * optionally a self-contained HTML diff.
 *
 *   node ~/.pi/agent/scripts/review-diff.mjs [--repo DIR] [--html] [RANGE | --worktree] [-- PATH...]
 *
 * RANGE is anything `git diff` takes (default HEAD~1..HEAD). --worktree reviews uncommitted
 * work against HEAD instead; untracked files are included only when they fall under the given
 * PATHs, so unrelated scratch files stay out. Key and env files are never shown. Line ranges are on the new side
 * of the diff, so `path:L12` opens the right place in the current checkout; a pure deletion is
 * shown at the line it sat before. One line per file: `path  +added −removed  L12-30, L88`.
 */
import fs from "node:fs";
import path from "node:path";
import { diffText, parseDiff, repoPaths, sourceLabel, summary } from "../extensions/lib/review-diff.ts";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const option = name => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
const html = flag("--html");
const worktree = flag("--worktree");
const repo = path.resolve(option("--repo") ?? ".");
const split = args.indexOf("--");
// PATHs are relative to where the script runs; git wants them relative to the repo root.
const paths = split < 0 ? [] : repoPaths(repo, process.cwd(), args.splice(split).slice(1));
const source = { repo, worktree, range: args[0] ?? "HEAD~1..HEAD", paths };
const label = sourceLabel(source);
const range = source.range;
const files = parseDiff(diffText(source, 0));
const total = key => files.reduce((sum, f) => sum + (typeof f[key] === "number" ? f[key] : 0), 0);
console.log(summary(files, source));

if (html) {
	const escape = text => text.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	const row = r => r.kind === "hunk" || r.kind === "meta"
		? `<tr class="${r.kind}"><td></td><td></td><td>${escape(r.text)}</td></tr>`
		: `<tr${r.kind === "ctx" ? "" : ` class="${r.kind}"`}><td>${r.old ?? ""}</td><td>${r.new ?? ""}</td><td>${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${escape(r.text)}</td></tr>`;
	const sections = parseDiff(diffText(source, 5)).map(f => ({ file: f.file, rows: f.rows.map(row) }));
	const stat = new Map(files.map(entry => [entry.file, entry]));
	const id = index => `f${index}`;
	const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review ${escape(label)}</title><style>
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
</style></head><body><main><h1>${escape(label)}</h1><div class="muted">${escape(repo)} · ${files.length} files · <span class="plus">+${total("added")}</span> <span class="minus">−${total("removed")}</span></div>
<nav><ul>${sections.map((s, i) => { const e = stat.get(s.file); return `<li><a href="#${id(i)}">${escape(s.file)}</a> <span class="n">${e ? `<span class="plus">+${e.added}</span> <span class="minus">−${e.removed}</span>` : ""}</span></li>`; }).join("")}</ul></nav>
${sections.map((s, i) => `<section id="${id(i)}"><h2>${escape(s.file)}</h2><div class="scroll"><table>${s.rows.join("")}</table></div></section>`).join("\n")}
</main></body></html>`;
	// /tmp, not os.tmpdir(): the bash sandbox allows writes to /tmp only.
	const dir = "/tmp/pi-review";
	fs.mkdirSync(dir, { recursive: true });
	const out = path.join(dir, `${path.basename(repo).replace(/^\.+/, "")}-${(worktree ? "worktree" : range).replace(/[^\w.-]+/g, "_").slice(0, 80)}.html`);
	fs.writeFileSync(out, page);
	console.log(`\nHTML diff: ${out}`);
}
