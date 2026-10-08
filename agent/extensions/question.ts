/**
 * question tool: ask the user one question as a select list. The last entry is
 * always a free-text escape hatch, so the user is never limited to the listed options.
 * Smaller variant of Pi's examples/extensions/question.ts, built on ctx.ui.select/input.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const OTHER_OPTION = "Something else (type your own answer)";

const Params = Type.Object({
	question: Type.String({ description: "One question, phrased so each option is a complete answer" }),
	options: Type.Array(Type.Object({
		label: Type.String({ description: "Short answer" }),
		description: Type.Optional(Type.String({ description: "One-line consequence or trade-off" })),
	}), { minItems: 1, maxItems: 6, description: "Put the recommended option first and end its label with (Recommended). Do not add an 'other' option; it is appended automatically." }),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user one question as a select list. A final 'type your own answer' option is added automatically. Use for every interview or decision question instead of asking in prose.",
		parameters: Params,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = (value: string, answer: string | null) => ({ content: [{ type: "text" as const, text: value }], details: { question: params.question, answer } });
			if (!ctx.hasUI) return text("No interactive UI: ask this question in plain text instead.", null);
			const labels = params.options.map(o => o.description ? `${o.label} — ${o.description}` : o.label);
			const choice = await ctx.ui.select(params.question, [...labels, OTHER_OPTION]);
			if (choice === undefined) return text("User cancelled the question. Ask how they want to proceed.", null);
			if (choice === OTHER_OPTION) {
				const typed = (await ctx.ui.input(params.question, "Your answer"))?.trim();
				return typed ? text(`User wrote: ${typed}`, typed) : text("User cancelled the question. Ask how they want to proceed.", null);
			}
			const picked = params.options[labels.indexOf(choice)].label;
			return text(`User selected: ${picked}`, picked);
		},
	});
}
