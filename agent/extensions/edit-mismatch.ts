/**
 * edit-mismatch: when `edit` can't find its oldText, show the model the file's current
 * nearest lines. The usual cause is a stale view: another agent (often an executor ticking a
 * goal checklist) changed the file after the model last read it. Without this hint the model
 * tends to treat the failure as lost work and redo it.
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "./creds-guard.ts";

type Edit = { oldText?: string };

function bigrams(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (let i = 0; i < text.length - 1; i++) counts.set(text.slice(i, i + 2), (counts.get(text.slice(i, i + 2)) ?? 0) + 1);
	return counts;
}

/** Dice similarity of character pairs: 1 for equal text, near 0 for unrelated text. */
function similarity(a: Map<string, number>, b: Map<string, number>): number {
	let shared = 0, total = 0;
	for (const [pair, count] of a) { shared += Math.min(count, b.get(pair) ?? 0); total += count; }
	for (const count of b.values()) total += count;
	return total ? 2 * shared / total : 0;
}

/** Up to `limit` current lines most like the first non-blank line of oldText. */
export function nearestLines(file: string, oldText: string, limit = 3): { line: number; text: string }[] {
	const needle = oldText.split("\n").map(line => line.trim()).find(Boolean);
	if (!needle) return [];
	// Also compare line starts: a ticked box keeps its head while the rest of the line is rewritten.
	const head = (text: string) => text.slice(0, 40);
	const target = bigrams(needle), targetHead = bigrams(head(needle));
	return file.split("\n")
		.map((text, i) => ({ line: i + 1, text, score: Math.max(similarity(target, bigrams(text.trim())), similarity(targetHead, bigrams(head(text.trim())))) }))
		.filter(entry => entry.score >= 0.5)
		.sort((a, b) => b.score - a.score).slice(0, limit)
		.sort((a, b) => a.line - b.line)
		.map(({ line, text }) => ({ line, text }));
}

export function mismatchHint(file: string, message: string, input: { oldText?: string; edits?: Edit[] }): string {
	const index = Number(/edits\[(\d+)\]/.exec(message)?.[1] ?? 0);
	const oldText = input.edits?.[index]?.oldText ?? input.oldText ?? "";
	const near = nearestLines(file, oldText);
	const clip = (text: string) => text.length > 240 ? text.slice(0, 239) + "…" : text;
	return [
		"",
		"The file no longer contains that text; it probably changed after your last read (another agent may have edited it). This is a stale edit, not a failed task: do not redo the work.",
		near.length ? "Closest current lines:\n" + near.map(entry => `${entry.line}: ${clip(entry.text)}`).join("\n") : "No similar line found.",
		"Re-read the affected lines, then retry the edit against the current text. No edits from this call were applied.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" || !event.isError) return;
		const message = event.content.filter(block => block.type === "text").map(block => block.text).join("\n");
		if (!/Could not find/.test(message) || typeof event.input.path !== "string") return;
		let file: string;
		try { file = fs.readFileSync(canonicalPath(event.input.path, ctx.cwd), "utf8"); } catch { return; }
		return { content: [{ type: "text", text: message + mismatchHint(file, message, event.input) }] };
	});
}
