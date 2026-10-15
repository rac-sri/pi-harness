/**
 * In-pi diff viewer: a full-screen file list (+/− and changed line ranges), Enter for a file's
 * coloured diff with old/new line numbers. `/diff [RANGE | --worktree] [-- PATH...]` opens it
 * for the user; the `review_diff` tool lets the model open it at a checkpoint review.
 */
import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { diffText, formatRanges, parseDiff, repoPaths, sourceLabel, summary, type DiffFile, type DiffSource } from "./lib/review-diff.ts";

type Theme = { fg: (color: any, text: string) => string; bold: (text: string) => string };

/** Characters from `start`, `width` columns wide; tabs as 4 spaces. */
const slice = (text: string, start: number, width: number) => truncateToWidth(text.replace(/\t/g, "    ").slice(start), width, "…");

/** Directory prefix shared by every file ("a/b/" for a/b/x.rs and a/b/c/y.rs). */
export function commonDir(files: string[]): string {
	if (!files.length) return "";
	let prefix = files[0].slice(0, files[0].lastIndexOf("/") + 1);
	for (const file of files) while (prefix && !file.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1);
	return prefix;
}

export function createDiffViewer(files: DiffFile[], label: string, theme: Theme, done: () => void, height: () => number) {
	const prefix = commonDir(files.map(f => f.file));
	const short = (file: string) => file.slice(prefix.length);
	let selected = 0;
	let open: number | undefined;
	let scroll = 0, column = 0, page = 1;

	const openFile = (index: number) => { open = index; scroll = 0; column = 0; };

	function handleInput(data: string) {
		if (open === undefined) {
			if (matchesKey(data, Key.escape) || data === "q") return done();
			if (matchesKey(data, Key.up) || data === "k") selected = Math.max(0, selected - 1);
			else if (matchesKey(data, Key.down) || data === "j") selected = Math.min(files.length - 1, selected + 1);
			else if ((matchesKey(data, Key.enter) || matchesKey(data, Key.right)) && files.length) openFile(selected);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") { selected = open; open = undefined; return; }
		if (data === "n" || data === "]") { if (open < files.length - 1) openFile(open + 1); return; }
		if (data === "p" || data === "[") { if (open > 0) openFile(open - 1); return; }
		if (matchesKey(data, Key.left) || data === "h") { column = Math.max(0, column - 8); return; }
		if (matchesKey(data, Key.right) || data === "l") { column += 8; return; }
		const step = matchesKey(data, Key.up) || data === "k" ? -1 : matchesKey(data, Key.down) || data === "j" ? 1
			: matchesKey(data, Key.pageUp) || data === "b" ? -page : matchesKey(data, Key.pageDown) || data === " " ? page
			: matchesKey(data, Key.home) || data === "g" ? -Infinity : matchesKey(data, Key.end) || data === "G" ? Infinity : 0;
		scroll = step === -Infinity ? 0 : step === Infinity ? Number.MAX_SAFE_INTEGER : scroll + step;
	}

	function render(width: number): string[] {
		const w = Math.max(30, width);
		const rows = Math.max(6, Math.floor(height()) - 1);
		const border = theme.fg("accent", "─".repeat(w));
		const counts = (f: DiffFile) => `${theme.fg("toolDiffAdded", `+${f.added}`)} ${theme.fg("toolDiffRemoved", `−${f.removed}`)}`;
		if (open === undefined) {
			const added = files.reduce((n, f) => n + (typeof f.added === "number" ? f.added : 0), 0);
			const removed = files.reduce((n, f) => n + (typeof f.removed === "number" ? f.removed : 0), 0);
			const lines = [border, ` ${theme.bold("Diff")} ${theme.fg("dim", `· ${label} · ${files.length} files${prefix ? ` in ${prefix}` : ""} ·`)} ${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `−${removed}`)}`, ""];
			if (!files.length) lines.push(theme.fg("muted", " No changes."));
			const room = rows - 6;
			const first = Math.max(0, Math.min(selected - Math.floor(room / 2), files.length - room));
			files.slice(first, first + room).forEach((f, i) => {
				const active = first + i === selected;
				const where = f.ranges.length ? formatRanges(f.ranges).join(", ") : "(removed or binary)";
				lines.push(truncateToWidth(`${active ? theme.fg("accent", "› ") : "  "}${theme.fg(active ? "accent" : "text", short(f.file))}  ${counts(f)}  ${theme.fg("dim", where)}`, w, "…"));
			});
			lines.push("", theme.fg("dim", truncateToWidth(" ↑↓ select · Enter view diff · Esc close", w)), border);
			return lines;
		}
		const file = files[open];
		const digits = String(file.rows.reduce((max, r) => Math.max(max, r.old ?? 0, r.new ?? 0), 0)).length;
		const num = (n?: number) => (n === undefined ? "" : String(n)).padStart(digits);
		const textWidth = Math.max(10, w - 2 * digits - 5);
		const body = file.rows.map(r => {
			if (r.kind === "hunk") return theme.fg("accent", slice(r.text, 0, w));
			if (r.kind === "meta") return theme.fg("muted", slice(r.text, 0, w));
			const color = r.kind === "add" ? "toolDiffAdded" : r.kind === "del" ? "toolDiffRemoved" : "toolDiffContext";
			const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
			return theme.fg("dim", `${num(r.old)} ${num(r.new)} │`) + theme.fg(color, sign + slice(r.text, column, textWidth));
		});
		const room = rows - 4;
		page = Math.max(1, room - 2);
		scroll = Math.max(0, Math.min(scroll, body.length - room));
		const header = ` ${theme.fg("dim", prefix)}${theme.bold(short(file.file))}  ${counts(file)}  ${theme.fg("dim", `file ${open + 1}/${files.length}${column ? ` · col ${column + 1}` : ""}`)}`;
		const position = body.length > room ? `${scroll + 1}-${Math.min(body.length, scroll + room)} of ${body.length}` : `${body.length} lines`;
		const footer = ` ${position} · ↑↓ line · PgUp/PgDn page · g/G top/end · ←→ pan · n/p next/prev file · Esc files`;
		return [border, truncateToWidth(header, w, "…"), ...body.slice(scroll, scroll + room).map(line => visibleWidth(line) > w ? truncateToWidth(line, w) : line), theme.fg("dim", truncateToWidth(footer, w)), border];
	}

	return { render, handleInput, invalidate() {} };
}

/** `/diff` arguments: `[RANGE | --worktree] [-- PATH...]`. Without a range, uncommitted work if any, else the last commit. */
export function parseDiffArgs(args: string, repo: string, cwd: string): DiffSource {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const split = words.indexOf("--");
	const paths = split < 0 ? [] : repoPaths(repo, cwd, words.splice(split).slice(1));
	const worktree = words.includes("--worktree");
	const range = words.find(word => word !== "--worktree");
	if (worktree || range) return { repo, worktree, range, paths };
	const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
	return dirty ? { repo, worktree: true, paths } : { repo, range: "HEAD~1..HEAD", paths };
}

const repoRoot = (cwd: string) => execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

async function show(ctx: ExtensionContext, source: DiffSource) {
	const files = parseDiff(diffText(source, 5));
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const viewer = createDiffViewer(files, sourceLabel(source), theme, done, () => tui.terminal.rows);
		return { ...viewer, handleInput: (data: string) => { viewer.handleInput(data); tui.requestRender(); } };
	});
	return files;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description: "View a diff in pi: /diff [RANGE | --worktree] [-- PATH...] (default: uncommitted changes, else the last commit)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			try { const repo = repoRoot(ctx.cwd); await show(ctx, parseDiffArgs(args, repo, ctx.cwd)); }
			catch (error) { ctx.ui.notify(`diff: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, "error"); }
		},
	});
	pi.registerTool({
		name: "review_diff",
		label: "Review diff",
		description: "Open a full-screen diff viewer for the user (file list with +/− and changed line ranges, then each file's coloured diff) and wait until they close it. Returns the per-file summary. Use when the user wants to review changes inside pi.",
		parameters: Type.Object({
			repo: Type.Optional(Type.String({ description: "Repository path; default: the current repository" })),
			range: Type.Optional(Type.String({ description: "git diff range, e.g. abc123^..def456" })),
			worktree: Type.Optional(Type.Boolean({ description: "Review uncommitted changes against HEAD instead of a range" })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Limit to these paths (relative to cwd); in worktree mode untracked files are included only under them" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const repo = repoRoot(params.repo ?? ctx.cwd);
			const source: DiffSource = { repo, range: params.range, worktree: params.worktree, paths: repoPaths(repo, ctx.cwd, params.paths ?? []) };
			if (!ctx.hasUI || ctx.mode !== "tui") {
				return { content: [{ type: "text", text: `No interactive UI. Summary:\n${summary(parseDiff(diffText(source, 0)), source)}` }], details: {} };
			}
			const files = await show(ctx, source);
			return { content: [{ type: "text", text: `User closed the diff viewer.\n${summary(files, source)}` }], details: {} };
		},
	});
}
