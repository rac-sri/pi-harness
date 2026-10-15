/**
 * Git diff loading and parsing shared by scripts/review-diff.mjs (summary + HTML) and the
 * in-pi diff viewer (extensions/diff-viewer.ts).
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";

export interface DiffSource {
	repo: string;
	/** Anything `git diff` takes; ignored when worktree is set. */
	range?: string;
	/** Uncommitted work against HEAD. Untracked files are included only under `paths`. */
	worktree?: boolean;
	/** Pathspecs relative to the repo root. */
	paths?: string[];
}
/** A hunk row's `new` is the new-side line its changes follow (git's "+start,count" made 0-based for count>0). */
export interface DiffRow { kind: "add" | "del" | "ctx" | "hunk" | "meta"; old?: number; new?: number; text: string }
export interface DiffFile { file: string; added: number | "bin"; removed: number | "bin"; ranges: LineRange[]; rows: DiffRow[] }
export interface LineRange { start: number; end: number; deleted?: boolean }

// Same secret patterns the bash sandbox denies.
const secret = (file: string) => /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx)$/.test(file);

export const sourceLabel = (source: DiffSource) => source.worktree ? "uncommitted changes" : source.range ?? "HEAD~1..HEAD";

/** Pathspecs given relative to `cwd`, made relative to the repo root for git. */
export const repoPaths = (repo: string, cwd: string, paths: string[]) => paths.map(p => path.relative(repo, path.resolve(cwd, p)) || ".");

/** Unified diff text, with untracked files under `paths` in worktree mode and secret files removed. */
export function diffText(source: DiffSource, context: number): string {
	const git = (...args: string[]) => execFileSync("git", ["-C", source.repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	const paths = source.paths ?? [];
	const range = source.worktree ? "HEAD" : source.range ?? "HEAD~1..HEAD";
	const parts = [git("diff", "--no-color", `-U${context}`, "-M", range, "--", ...paths)];
	if (source.worktree && paths.length) {
		for (const file of git("ls-files", "--others", "--exclude-standard", "-z", "--", ...paths).split("\0").filter(Boolean)) {
			// --no-index exits 1 when the files differ, which is always the case here.
			try { parts.push(git("diff", "--no-color", "--no-index", `-U${context}`, "--", "/dev/null", file)); }
			catch (error: any) { parts.push(String(error.stdout ?? "")); }
		}
	}
	return parts.filter(Boolean).map(part => part.endsWith("\n") ? part : part + "\n").join("")
		.split(/(?=^diff --git )/m).filter(section => !secret(/^diff --git a\/.* b\/(.*)$/m.exec(section)?.[1] ?? "")).join("");
}

/** Per-file rows with old/new line numbers, counts, and changed new-side line ranges. */
export function parseDiff(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	let current: DiffFile | undefined;
	let oldLine = 0, newLine = 0, inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			current = { file: /^diff --git a\/.* b\/(.*)$/.exec(line)?.[1] ?? line, added: 0, removed: 0, ranges: [], rows: [] };
			files.push(current);
			inHunk = false;
			continue;
		}
		if (!current) continue;
		const target = /^\+\+\+ b\/(.*)$/.exec(line);
		if (target && !inHunk) { current.file = target[1]; continue; }
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
			current.rows.push({ kind: "hunk", new: hunk[3] === "0" ? newLine : newLine - 1, text: line });
			continue;
		}
		if (!inHunk) {
			if (/^Binary files /.test(line)) { current.added = current.removed = "bin"; current.rows.push({ kind: "meta", text: line }); }
			else if (/^(rename|new file|deleted file)/.test(line)) current.rows.push({ kind: "meta", text: line });
			continue;
		}
		if (line.startsWith("+")) { current.rows.push({ kind: "add", new: newLine++, text: line.slice(1) }); if (typeof current.added === "number") current.added++; }
		else if (line.startsWith("-")) { current.rows.push({ kind: "del", old: oldLine++, text: line.slice(1) }); if (typeof current.removed === "number") current.removed++; }
		else if (line.startsWith(" ")) current.rows.push({ kind: "ctx", old: oldLine++, new: newLine++, text: line.slice(1) });
	}
	for (const file of files) file.ranges = changedRanges(file.rows);
	return files;
}

/**
 * New-side ranges of changed lines. A run of consecutive changes covers its added lines; a run
 * with only deletions sits at the line before it. Ranges at most 5 lines apart merge.
 */
function changedRanges(rows: DiffRow[]): LineRange[] {
	const ranges: LineRange[] = [];
	const push = (range: LineRange) => {
		const last = ranges.at(-1);
		if (last && range.start - last.end <= 5) { last.end = Math.max(last.end, range.end); last.deleted = last.deleted && range.deleted; }
		else ranges.push({ ...range, start: Math.max(1, range.start), end: Math.max(1, range.end) });
	};
	let lastNew = 0;
	let run: DiffRow[] = [];
	const flush = () => {
		const added = run.filter(row => row.kind === "add");
		if (added.length) push({ start: added[0].new!, end: added.at(-1)!.new! });
		else if (run.length) push({ start: lastNew, end: lastNew, deleted: true });
		run = [];
	};
	for (const row of rows) {
		if (row.kind === "add" || row.kind === "del") { run.push(row); continue; }
		flush();
		if (row.new !== undefined) lastNew = row.new;
	}
	flush();
	return ranges;
}

export const formatRanges = (ranges: LineRange[]) => ranges.map(r => `L${r.start}${r.end > r.start ? `-${r.end}` : ""}${r.deleted ? " (deletion)" : ""}`);

export function summary(files: DiffFile[], source: DiffSource): string {
	const total = (key: "added" | "removed") => files.reduce((sum, f) => sum + (typeof f[key] === "number" ? f[key] as number : 0), 0);
	return [
		`${files.length} file${files.length === 1 ? "" : "s"} changed, +${total("added")} −${total("removed")} (${sourceLabel(source)}, ${source.repo})`,
		"",
		...files.map(f => `${f.file}  +${f.added} −${f.removed}  ${f.ranges.length ? formatRanges(f.ranges).join(", ") : "(removed or binary)"}`),
	].join("\n");
}
