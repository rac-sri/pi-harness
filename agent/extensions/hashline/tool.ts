/**
 * Executor-only snapshot-tagged read/edit tools (see extensions/lib/hashline.ts).
 * Loaded explicitly by the subagent dispatcher; there is no index.ts, so pi's
 * extension discovery never installs it in the main session.
 */
import { promises as fs } from "node:fs";
import { Type } from "typebox";
import { createReadToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, generateDiffString, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "../creds-guard.ts";
import { applyEdits, createHashlineStore, type HashlineEdit, renderRead } from "../lib/hashline.ts";

const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

const editSchema = Type.Object({
	path: Type.String({ description: "File to edit, as passed to read" }),
	tag: Type.String({ description: "4-character tag from the file's latest [path#TAG] header (from read or a previous hashline_edit)" }),
	edits: Type.Array(Type.Union([
		Type.Object({ op: Type.Literal("replace"), start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }), text: Type.String({ description: "New content for lines start..end inclusive; no N: prefixes" }) }),
		Type.Object({ op: Type.Literal("delete"), start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }) }),
		Type.Object({ op: Type.Literal("insert"), after: Type.Integer({ minimum: 0, description: "Insert after this line; 0 inserts at the top" }), text: Type.String({ description: "Lines to insert; no N: prefixes" }) }),
	]), { minItems: 1, description: "Non-overlapping edits, all numbered against the tagged snapshot" }),
});

async function readText(file: string, display: string): Promise<string> {
	let buffer: Buffer;
	try { buffer = await fs.readFile(file); }
	catch (error) { throw new Error(`Could not read ${display}: ${(error as NodeJS.ErrnoException).code ?? error}.`); }
	if (buffer.includes(0)) throw new Error(`${display} is a binary file; hashline tools only handle text.`);
	return buffer.toString("utf8");
}

export default function hashline(pi: ExtensionAPI) {
	const store = createHashlineStore();
	const nativeRead = createReadToolDefinition(process.cwd());

	pi.registerTool({
		...nativeRead,
		description: `Read a text file as numbered lines under a [path#TAG] header; TAG identifies this exact file content and is required by hashline_edit. Images are returned as attachments. Output is limited to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; continue with offset.`,
		promptSnippet: "read: numbered file lines under a [path#TAG] header for hashline_edit",
		promptGuidelines: ["Lines are shown as N:content. The N: prefix is not file content."],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (IMAGE.test(params.path)) return nativeRead.execute(toolCallId, params, signal, onUpdate, ctx);
			const file = canonicalPath(params.path, ctx?.cwd ?? process.cwd());
			const raw = await readText(file, params.path);
			const { text } = renderRead(store, file, params.path, raw, { offset: params.offset, limit: params.limit, maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "hashline_edit",
		label: "hashline edit",
		description: "Edit a text file by line numbers from read, citing its [path#TAG] tag. Ops: replace start..end with text, delete start..end, insert text after a line (0 = top). All edits in one call use the numbering of that tag and must not overlap. Rejects with E_STALE when the cited lines changed since that read; then read again. The result returns the new tag; use it for the next edit to the same file. Use write only for new files or full rewrites.",
		promptSnippet: "hashline_edit: edit files by [path#TAG] line numbers from read",
		promptGuidelines: [
			"Edit existing files with hashline_edit; read the target lines first and cite the tag from the most recent read or edit result of that file.",
			"text is the exact new content: never include the N: prefixes; a trailing newline does not add a line.",
			"On E_STALE, E_UNSERVED or E_UNKNOWN_TAG, read the file again instead of guessing.",
		],
		parameters: editSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const file = canonicalPath(params.path, ctx?.cwd ?? process.cwd());
			return withFileMutationQueue(file, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				const before = await readText(file, params.path);
				const result = applyEdits(store, file, params.path, before, params.tag, params.edits as HashlineEdit[]);
				if (signal?.aborted) throw new Error("Operation aborted");
				await fs.writeFile(file, result.raw);
				const diff = generateDiffString(before, result.raw);
				return { content: [{ type: "text", text: result.text }], details: { diff: diff.diff, firstChangedLine: result.firstChangedLine, recovered: result.recovered } };
			});
		},
	});
}
