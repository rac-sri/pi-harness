/**
 * question tool: ask the user one question as a checkbox list (multiSelect) or a
 * radio list (single choice). The last row is always a free-text escape hatch,
 * so the user is never limited to the listed options.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const OTHER_OPTION = "Something else (type your own answer)";

type Option = { label: string; description?: string };
type Theme = { fg: (color: any, text: string) => string; bold: (text: string) => string };
export type PickResult = { indices: number[]; other: boolean } | null;

const Params = Type.Object({
	question: Type.String({ description: "One question, phrased so each option is a complete answer" }),
	options: Type.Array(Type.Object({
		label: Type.String({ description: "Short answer" }),
		description: Type.Optional(Type.String({ description: "One-line consequence or trade-off" })),
	}), { minItems: 1, maxItems: 8, description: "Put the recommended option first and end its label with (Recommended). Do not add an 'other' option; it is appended automatically." }),
	multiSelect: Type.Optional(Type.Boolean({ description: "true when several options can apply at once (e.g. which checks to run); default false" })),
});

/** Keyboard-driven list. Exported for tests; rendering is plain text plus theme colours. */
export function createPicker(question: string, options: Option[], multi: boolean, theme: Theme, done: (result: PickResult) => void, requestRender: () => void) {
	const rows = [...options, { label: OTHER_OPTION }];
	const checked = new Set<number>();
	let cursor = 0;
	let hint = "";
	let cache: string[] | undefined;
	const refresh = () => { cache = undefined; requestRender(); };
	const finish = (indices: number[]) => {
		const other = indices.includes(rows.length - 1);
		done({ indices: indices.filter(i => i < rows.length - 1).sort((a, b) => a - b), other });
	};

	function handleInput(data: string) {
		hint = "";
		if (matchesKey(data, Key.escape)) return done(null);
		if (matchesKey(data, Key.up)) cursor = (cursor + rows.length - 1) % rows.length;
		else if (matchesKey(data, Key.down)) cursor = (cursor + 1) % rows.length;
		else if (/^[1-9]$/.test(data) && Number(data) <= rows.length) {
			cursor = Number(data) - 1;
			if (!multi) return finish([cursor]);
			checked.has(cursor) ? checked.delete(cursor) : checked.add(cursor);
		} else if (multi && matchesKey(data, Key.space)) checked.has(cursor) ? checked.delete(cursor) : checked.add(cursor);
		else if (matchesKey(data, Key.enter)) {
			if (!multi) return finish([cursor]);
			if (checked.size === 0) hint = "Select at least one option with Space.";
			else return finish([...checked]);
		} else return;
		refresh();
	}

	function render(width: number): string[] {
		if (cache) return cache;
		const w = Math.max(20, width);
		const lines: string[] = [];
		const wrap = (prefix: string, text: string) => {
			const pad = visibleWidth(prefix);
			wrapTextWithAnsi(text, Math.max(10, w - pad)).forEach((line, i) => lines.push((i === 0 ? prefix : " ".repeat(pad)) + line));
		};
		lines.push(theme.fg("accent", "─".repeat(w)));
		wrap(" ", theme.bold(question));
		if (multi) wrap(" ", theme.fg("muted", "Select all that apply."));
		lines.push("");
		rows.forEach((row, i) => {
			const active = i === cursor;
			const mark = multi ? (checked.has(i) ? "[x]" : "[ ]") : (active ? "(•)" : "( )");
			const label = `${mark} ${i + 1}. ${row.label}`;
			wrap(active ? theme.fg("accent", "› ") : "  ", theme.fg(active || checked.has(i) ? "accent" : "text", label));
			if ("description" in row && row.description) wrap("        ", theme.fg("muted", row.description));
		});
		lines.push("");
		if (hint) wrap(" ", theme.fg("warning", hint));
		wrap(" ", theme.fg("dim", multi ? "↑↓ move · Space toggle · 1-9 toggle · Enter submit · Esc cancel" : "↑↓ move · Enter or 1-9 select · Esc cancel"));
		lines.push(theme.fg("accent", "─".repeat(w)));
		return (cache = lines);
	}

	return { render, handleInput, invalidate: () => { cache = undefined; } };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user one question as a selectable list: radio buttons by default, checkboxes with multiSelect. A final 'type your own answer' option is added automatically. Use for every interview or decision question instead of asking in prose.",
		parameters: Params,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reply = (text: string, answers: string[] | null) => ({ content: [{ type: "text" as const, text }], details: { question: params.question, answers } });
			const cancelled = () => reply("User cancelled the question. Ask how they want to proceed.", null);
			if (!ctx.hasUI || ctx.mode !== "tui") return reply("No interactive UI: ask this question in plain text instead.", null);
			const multi = params.multiSelect === true;
			const result = await ctx.ui.custom<PickResult>((tui, theme, _keys, done) => createPicker(params.question, params.options, multi, theme, done, () => tui.requestRender()));
			if (!result) return cancelled();
			const answers = result.indices.map(i => params.options[i].label);
			if (result.other) {
				const typed = (await ctx.ui.input(params.question, "Your answer"))?.trim();
				if (!typed) return cancelled();
				answers.push(typed);
				const picked = answers.length > 1 ? `User selected: ${answers.slice(0, -1).join("; ")}. ` : "";
				return reply(`${picked}User wrote: ${typed}`, answers);
			}
			return reply(`User selected: ${answers.join("; ")}`, answers);
		},
	});
}
