/**
 * Snapshot-tagged line editing, after oh-my-pi's hashline v2 (crates/pi-edit).
 *
 * `read` serves numbered lines under a `[path#TAG]` header, where TAG names the
 * exact file content. Edits cite the tag and line numbers. An edit applies
 * directly only when the file still matches the tagged snapshot (full SHA-256,
 * not just the 4-character tag). Otherwise it may shift onto the current file
 * only when every edited line plus CONTEXT lines on each side occurs exactly
 * once, unchanged, and every edit in the batch shifts by the same amount.
 * Anything else fails closed and the model must re-read.
 *
 * Pure string functions: the tool wrapper owns file I/O and locking.
 */
import { createHash } from "node:crypto";

const CONTEXT = 2;
const MAX_SNAPSHOTS_PER_FILE = 8;
const MAX_RESULT_LINES = 60;

export class HashlineError extends Error {
	constructor(readonly code: string, message: string) { super(`[${code}] ${message}`); }
}

interface Line { text: string; crlf: boolean; served: boolean }
interface Parsed { bom: string; lines: Line[]; finalNewline: boolean; crlfDefault: boolean }
interface Snapshot { tag: string; digest: string; parsed: Parsed }
export interface HashlineStore { files: Map<string, Snapshot[]> }
export interface ReadOptions { offset?: number; limit?: number; maxLines?: number; maxBytes?: number; maxLineChars?: number }
export type HashlineEdit =
	| { op: "replace"; start: number; end: number; text: string }
	| { op: "delete"; start: number; end: number }
	| { op: "insert"; after: number; text: string };
export interface EditResult { raw: string; text: string; tag: string; recovered: boolean; firstChangedLine?: number }

export function createHashlineStore(): HashlineStore { return { files: new Map() }; }

function digestOf(raw: string): string { return createHash("sha256").update(raw, "utf8").digest("hex"); }

function parse(raw: string): Parsed {
	const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
	const body = raw.slice(bom.length);
	const finalNewline = body.endsWith("\n");
	const segments = body === "" ? [] : (finalNewline ? body.slice(0, -1) : body).split("\n");
	let crlfCount = 0;
	const lines = segments.map((segment, index) => {
		const terminated = index < segments.length - 1 || finalNewline;
		const crlf = terminated && segment.endsWith("\r");
		if (crlf) crlfCount++;
		return { text: crlf ? segment.slice(0, -1) : segment, crlf, served: false };
	});
	const terminated = finalNewline ? segments.length : Math.max(0, segments.length - 1);
	const crlfDefault = terminated > 0 && crlfCount * 2 > terminated;
	for (const [index, line] of lines.entries()) if (index === lines.length - 1 && !finalNewline) line.crlf = crlfDefault;
	return { bom, lines, finalNewline, crlfDefault };
}

function serialize(parsed: Parsed): string {
	const last = parsed.lines.length - 1;
	return parsed.bom + parsed.lines.map((line, index) => line.text + (index < last || parsed.finalNewline ? (line.crlf ? "\r\n" : "\n") : "")).join("");
}

function remember(store: HashlineStore, file: string, raw: string, parsed: Parsed): Snapshot {
	const digest = digestOf(raw);
	const snapshots = store.files.get(file) ?? [];
	const existing = snapshots.find(snapshot => snapshot.digest === digest);
	if (existing) {
		parsed.lines.forEach((line, index) => { if (line.served) existing.parsed.lines[index].served = true; });
		snapshots.splice(snapshots.indexOf(existing), 1);
		snapshots.push(existing);
		return existing;
	}
	const snapshot = { tag: digest.slice(0, 4).toUpperCase(), digest, parsed };
	snapshots.push(snapshot);
	if (snapshots.length > MAX_SNAPSHOTS_PER_FILE) snapshots.shift();
	store.files.set(file, snapshots);
	return snapshot;
}

/** Render a read window and record which lines were served in full. */
export function renderRead(store: HashlineStore, file: string, display: string, raw: string, options: ReadOptions = {}): { text: string; tag: string } {
	const parsed = parse(raw);
	const total = parsed.lines.length;
	const maxLines = options.maxLines ?? 2000, maxBytes = options.maxBytes ?? 50 * 1024, maxLineChars = options.maxLineChars ?? 2000;
	const start = options.offset ?? 1;
	if (!Number.isInteger(start) || start < 1 || (total > 0 && start > total)) throw new HashlineError("E_RANGE", `Offset ${start} is outside the file (${total} lines).`);
	const requestedEnd = options.limit === undefined ? total : Math.min(total, start + options.limit - 1);
	const rows: string[] = [];
	let bytes = 0, end = start - 1, truncatedLines = 0;
	for (let number = start; number <= requestedEnd && rows.length < maxLines; number++) {
		const line = parsed.lines[number - 1];
		const full = line.text.length <= maxLineChars;
		const row = `${number}:${full ? line.text : line.text.slice(0, maxLineChars) + " ... [line truncated; not editable here]"}`;
		if (rows.length > 0 && bytes + row.length + 1 > maxBytes) break;
		rows.push(row); bytes += row.length + 1; end = number;
		line.served = full;
		if (!full) truncatedLines++;
	}
	const snapshot = remember(store, file, raw, parsed);
	let text = `[${display}#${snapshot.tag}]\n`;
	if (total === 0) return { text: text + "(empty file: insert with after=0)", tag: snapshot.tag };
	text += rows.join("\n");
	if (end < total) text += `\n\n[Showing lines ${start}-${end} of ${total}. Use offset=${end + 1} to continue.]`;
	if (truncatedLines) text += `\n[${truncatedLines} long line(s) truncated; replace them with write or a shell tool.]`;
	return { text, tag: snapshot.tag };
}

function payload(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n");
	return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

/** Gap position (insert after `after`) sorts between lines `after` and `after + 1`. */
function key(edit: HashlineEdit): number { return edit.op === "insert" ? edit.after + 0.5 : edit.start; }

function validate(edits: HashlineEdit[], lines: Line[]): void {
	const total = lines.length;
	if (!Array.isArray(edits) || edits.length === 0) throw new HashlineError("E_RANGE", "Provide at least one edit.");
	for (const edit of edits) {
		if (edit.op === "insert") {
			if (!Number.isInteger(edit.after) || edit.after < 0 || edit.after > total) throw new HashlineError("E_RANGE", `insert after=${edit.after} is outside 0..${total}.`);
		} else if (edit.op === "replace" || edit.op === "delete") {
			if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 1 || edit.end < edit.start || edit.end > total) throw new HashlineError("E_RANGE", `${edit.op} ${edit.start}-${edit.end} is not a range within 1..${total}.`);
		} else throw new HashlineError("E_INPUT", `Unknown op ${(edit as { op?: unknown }).op}.`);
		if (edit.op !== "delete") {
			const rows = payload(edit.text);
			const near = edit.op === "insert" ? [edit.after, edit.after + 1] : [edit.start - 1, edit.end + 1];
			const prefixes = rows.map(row => /^(\d+):/.exec(row)?.[1]);
			if (prefixes.every(Boolean) && Number(prefixes[0]) >= near[0] && Number(prefixes[0]) <= near[1]) throw new HashlineError("E_PREFIXED", "Replacement text starts with read line-number prefixes (N:). Send only the new file content.");
		}
		const seen = edit.op === "insert" ? (edit.after > 0 ? [edit.after] : total > 0 ? [1] : []) : Array.from({ length: edit.end - edit.start + 1 }, (_, i) => edit.start + i);
		const unseen = seen.find(number => !lines[number - 1].served);
		if (unseen !== undefined) throw new HashlineError("E_UNSERVED", `Line ${unseen} was not served in full under this tag. Read that range first.`);
	}
	const sorted = [...edits].sort((a, b) => key(a) - key(b));
	for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
		const a = sorted[i], b = sorted[j];
		const conflict = a.op === "insert" && b.op === "insert" ? a.after === b.after
			: a.op === "insert" ? b.op !== "insert" && a.after >= b.start && a.after <= b.end
			: b.op === "insert" ? b.after >= a.start && b.after <= a.end
			: b.start <= a.end;
		if (conflict) throw new HashlineError("E_OVERLAP", "Edits overlap or insert inside/at the end of a replaced range. Merge them into one edit.");
	}
}

function windowOf(edit: HashlineEdit, total: number): [number, number] {
	const [first, last] = edit.op === "insert" ? [edit.after, edit.after + 1] : [edit.start, edit.end];
	return [Math.max(1, first - CONTEXT), Math.min(total, last + CONTEXT)];
}

function uniqueOffset(previous: Line[], current: Line[], [lo, hi]: [number, number]): number | undefined {
	const block = previous.slice(lo - 1, hi).map(line => line.text);
	let found: number | undefined;
	for (let start = 0; start + block.length <= current.length; start++) {
		if (block.every((text, i) => current[start + i].text === text)) {
			if (found !== undefined) return undefined;
			found = start - (lo - 1);
		}
	}
	return found;
}

function shift(edit: HashlineEdit, offset: number): HashlineEdit {
	return edit.op === "insert" ? { ...edit, after: edit.after + offset } : { ...edit, start: edit.start + offset, end: edit.end + offset };
}

function findSnapshot(store: HashlineStore, file: string, tag: string): Snapshot {
	const snapshot = (store.files.get(file) ?? []).findLast(candidate => candidate.tag === tag);
	if (snapshot) return snapshot;
	const owners = [...store.files].filter(([, snapshots]) => snapshots.some(candidate => candidate.tag === tag)).map(([owner]) => owner);
	throw new HashlineError("E_UNKNOWN_TAG", owners.length
		? `Tag #${tag} was issued for ${owners.join(", ")}, not ${file}. Read this file and use its own tag.`
		: `Tag #${tag} was not issued for ${file} in this session. Read the file again and use the current [path#TAG] header; never invent a tag.`);
}

/** Apply a batch of edits addressed against a served snapshot; returns the new file content. */
export function applyEdits(store: HashlineStore, file: string, display: string, currentRaw: string, tag: string, edits: HashlineEdit[]): EditResult {
	const snapshot = findSnapshot(store, file, tag);
	validate(edits, snapshot.parsed.lines);
	const current = parse(currentRaw);
	let base = edits;
	let offset = 0;
	const recovered = snapshot.digest !== digestOf(currentRaw);
	if (recovered) {
		const offsets = edits.map(edit => uniqueOffset(snapshot.parsed.lines, current.lines, windowOf(edit, snapshot.parsed.lines.length)));
		if (snapshot.parsed.lines.length === 0 || offsets.some(value => value === undefined) || offsets.some(value => value !== offsets[0])) {
			throw new HashlineError("E_STALE", `${display} changed after #${tag} was read, and the edited lines or their context changed or moved ambiguously. Read the file again.`);
		}
		offset = offsets[0]!;
		base = edits.map(edit => shift(edit, offset));
		for (const edit of base) { const [lo, hi] = windowOf(edit, current.lines.length); for (let n = lo; n <= hi; n++) current.lines[n - 1].served = true; }
	} else {
		current.lines.forEach((line, index) => { line.served = snapshot.parsed.lines[index].served; });
	}

	const regions: Array<[number, number]> = [];
	let delta = 0;
	for (const edit of [...base].sort((a, b) => key(a) - key(b))) {
		const added = edit.op === "delete" ? 0 : payload(edit.text).length;
		const at = (edit.op === "insert" ? edit.after + 1 : edit.start) + delta;
		regions.push([at, at + added - 1]);
		delta += added - (edit.op === "insert" ? 0 : edit.end - edit.start + 1);
	}
	for (const edit of [...base].sort((a, b) => key(b) - key(a))) {
		const rows = edit.op === "delete" ? [] : payload(edit.text).map(text => ({ text, crlf: current.crlfDefault, served: true }));
		if (edit.op === "insert") current.lines.splice(edit.after, 0, ...rows);
		else current.lines.splice(edit.start - 1, edit.end - edit.start + 1, ...rows);
	}
	if (current.lines.length > 0 && snapshot.parsed.lines.length === 0) current.finalNewline = true;
	const raw = serialize(current);

	const shown = new Set<number>();
	for (const [from, to] of regions) for (let n = Math.max(1, from - CONTEXT); n <= Math.min(current.lines.length, Math.max(from, to) + CONTEXT); n++) shown.add(n);
	const numbers = [...shown].sort((a, b) => a - b).slice(0, MAX_RESULT_LINES);
	for (const n of numbers) current.lines[n - 1].served = true;
	const next = remember(store, file, raw, current);
	const lines = numbers.map((n, i) => (i > 0 && numbers[i - 1] !== n - 1 ? "...\n" : "") + `${n}:${current.lines[n - 1].text}`);
	let text = `[${display}#${next.tag}]\nApplied ${edits.length} edit(s). Use #${next.tag} for further edits to this file.`;
	if (recovered) text += `\nWarning: ${display} changed after #${tag} was read. The edited lines and ${CONTEXT} lines of context were unchanged and occur once, so the edit was shifted by ${offset} line(s). Check the result below.`;
	if (shown.size > MAX_RESULT_LINES) text += `\n(Showing the first ${MAX_RESULT_LINES} changed/context lines; read the file for the rest.)`;
	if (lines.length) text += "\n" + lines.join("\n");
	return { raw, text, tag: next.tag, recovered, firstChangedLine: regions.length ? Math.min(...regions.map(([from]) => from)) : undefined };
}
