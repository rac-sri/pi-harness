/**
 * question tool: ask the user one question as a checkbox list (multiSelect) or a
 * radio list (single choice). The last row is always a free-text escape hatch,
 * so the user is never limited to the listed options.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const OTHER_OPTION = "Something else (type your own answer)";

type Option = { label: string; description?: string };
type Theme = { fg: (color: any, text: string) => string; bold: (text: string) => string };
export type PickResult = { indices: number[]; other: boolean } | null;

const Params = Type.Object({
	question: Type.String({ description: "One question, phrased so each option is a complete answer" }),
	context: Type.Optional(Type.String({ description: "Text the user must read before answering, shown above the question: summaries, the design being confirmed, numbered decisions. Plain lines; a line starting with # is a heading. Never squeeze this into an option description." })),
	options: Type.Array(Type.Object({
		label: Type.String({ description: "Short answer" }),
		description: Type.Optional(Type.String({ description: "One-line consequence or trade-off" })),
	}), { minItems: 1, maxItems: 8, description: "Put the recommended option first and end its label with (Recommended). Do not add an 'other' option; it is appended automatically." }),
	multiSelect: Type.Optional(Type.Boolean({ description: "true when several options can apply at once (e.g. which checks to run); default false" })),
	ledger: Type.Optional(Type.String({ description: "Decision ledger for this interview, e.g. 'reshield/01'. Every question with the same ledger sees all earlier decisions." })),
	decides: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{1,40}$", description: "kebab-case id of the one decision this question settles, e.g. 'enqueue-failure'. Asking an id that is already decided is refused unless revisit is true." })),
	revisit: Type.Optional(Type.Boolean({ description: "true to reopen an already-decided id; say in context what changed and why" })),
});

/** Interview budget: past this many decisions the tool asks the model to wrap up. */
export const DECISION_BUDGET = 10;
type Decision = { id: string; question: string; answer: string; changed?: boolean };
/** Per-process ledgers, keyed by ledger name. Exported for tests. */
export const ledgers = new Map<string, Decision[]>();
const clip = (text: string, max = 90) => text.length > max ? text.slice(0, max - 1) + "…" : text;
export function ledgerSummary(entries: Decision[]) {
	return entries.map((d, i) => `${i + 1}. ${d.id}: ${clip(d.answer)}${d.changed ? " (changed)" : ""}`).join("\n");
}

/** Keyboard-driven list. Exported for tests; rendering is plain text plus theme colours. */
export function createPicker(question: string, options: Option[], multi: boolean, theme: Theme, done: (result: PickResult) => void, requestRender: () => void, context?: string) {
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
		if (context?.trim()) {
			for (const line of contextLines(context)) line.heading ? wrap(" ", theme.fg("accent", theme.bold(line.text))) : line.text ? wrap(" ", theme.fg("text", line.text)) : lines.push("");
			lines.push("");
		}
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

function contextLines(context: string) {
	return context.trim().split("\n").flatMap((line, i) => /^#+\s/.test(line)
		? [...(i > 0 ? [{ heading: false, text: "" }] : []), { heading: true, text: line.replace(/^#+\s*/, "") }]
		: [{ heading: false, text: line.trimEnd() }]);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user one question as a selectable list: radio buttons by default, checkboxes with multiSelect. A final 'type your own answer' option is added automatically. Use for every interview or decision question instead of asking in prose. Put anything the user must read first (a summary, the design to confirm) in context, not in option descriptions. In an interview, pass the same ledger on every call and a decides id per question: settled ids are refused, and the ledger is shown to the user and returned to you after each answer.",
		parameters: Params,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entries = params.ledger ? ledgers.get(params.ledger) ?? [] : [];
			const reply = (text: string, answers: string[] | null) => ({ content: [{ type: "text" as const, text }], details: { question: params.question, context: params.context, answers } });
			const previous = params.decides ? entries.findIndex(d => d.id === params.decides) : -1;
			// Refuse a repeat before showing anything: the user should never see a settled question twice.
			if (previous >= 0 && !params.revisit) {
				const d = entries[previous];
				return reply(`Not asked: "${d.id}" is already decision ${previous + 1} ("${d.question}" -> ${d.answer}). Do not ask it again in other words. If a later answer conflicts with it, call again with revisit: true and explain the conflict in context.\nDecisions so far:\n${ledgerSummary(entries)}`, null);
			}
			const cancelled = () => reply("User cancelled the question. Ask how they want to proceed.", null);
			if (!ctx.hasUI || ctx.mode !== "tui") return reply("No interactive UI: ask this question in plain text instead.", null);
			const decided = entries.length ? `# Decided so far (${entries.length})\n${ledgerSummary(entries)}` : "";
			const shown = [params.context?.trim(), decided].filter(Boolean).join("\n") || undefined;
			const multi = params.multiSelect === true;
			const result = await ctx.ui.custom<PickResult>((tui, theme, _keys, done) => createPicker(params.question, params.options, multi, theme, done, () => tui.requestRender(), shown));
			if (!result) return cancelled();
			const answers = result.indices.map(i => params.options[i].label);
			let typed: string | undefined;
			if (result.other) {
				typed = (await ctx.ui.input(params.question, "Your answer"))?.trim();
				if (!typed) return cancelled();
				answers.push(typed);
			}
			let text = typed ? `${answers.length > 1 ? `User selected: ${answers.slice(0, -1).join("; ")}. ` : ""}User wrote: ${typed}` : `User selected: ${answers.join("; ")}`;
			if (params.ledger && params.decides) {
				const entry = { id: params.decides, question: params.question, answer: answers.join("; "), changed: previous >= 0 };
				previous >= 0 ? entries[previous] = entry : entries.push(entry);
				ledgers.set(params.ledger, entries);
				text += `\nDecisions so far (${params.ledger}):\n${ledgerSummary(entries)}`;
				if (previous >= 0) text += `\nDecision ${previous + 1} changed: check whether later decisions depend on it and revisit those too.`;
				if (entries.length >= DECISION_BUDGET) text += `\n${entries.length} decisions recorded. Ask only what blocks drafting the tasks; otherwise go to the confirm step.`;
			}
			return reply(text, answers);
		},
		// Keep the context and the answer in the chat after the picker closes.
		renderResult(result, _options, theme) {
			const details = result.details as { question: string; context?: string; answers: string[] | null } | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			const parts: string[] = [];
			if (details.context?.trim()) parts.push(...contextLines(details.context).map(l => l.heading ? theme.fg("accent", theme.bold(l.text)) : l.text), "");
			parts.push(theme.bold(details.question));
			parts.push(details.answers ? theme.fg("success", "✓ ") + theme.fg("accent", details.answers.join("; ")) : theme.fg("warning", "Cancelled"));
			return new Text(parts.join("\n"), 0, 0);
		},
	});
}
