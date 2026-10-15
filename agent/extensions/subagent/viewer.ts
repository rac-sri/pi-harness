/**
 * Subagent viewer: a full-screen list of this session's subagent runs (live ones update in
 * place). Enter opens one run's whole transcript: task, assistant text, thinking, every tool
 * call with its output, and the final report. Opened with Ctrl+Shift+A or /agents.
 */
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Theme = { fg: (color: any, text: string) => string; bold: (text: string) => string };
type Part = { type: string; text?: string; thinking?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = { role: string; content: Part[] | string; toolName?: string; isError?: boolean };

export interface ViewerRun {
	id?: string; agent: string; task: string; exitCode: number; stopReason?: string; errorMessage?: string;
	startedAt?: number; elapsedMs?: number; phase?: string; model?: string; stderr?: string;
	messages: Msg[] | unknown[];
	liveText?: string; liveThinking?: string; liveTool?: { name: string; args: Record<string, unknown> }; liveToolOutput?: string;
}

type FormatCall = (name: string, args: Record<string, unknown>, fg: Theme["fg"]) => string;

const failed = (run: ViewerRun) => run.exitCode > 0 || run.stopReason === "error" || run.stopReason === "aborted";
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const textOf = (content: Part[] | string) => typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");

/** Transcript as styled logical lines; the viewer wraps them to the terminal width. */
export function transcript(run: ViewerRun, theme: Theme, formatCall: FormatCall): string[] {
	const out: string[] = [];
	const section = (title: string) => out.push("", theme.fg("accent", theme.bold(`── ${title}`)));
	const block = (color: string, text: string) => { for (const line of text.split("\n")) out.push(theme.fg(color, line)); };
	out.push(`${statusIcon(run, theme)} ${theme.bold(run.agent)}${theme.fg("dim", ` · ${status(run)}${run.model ? " · " + run.model : ""}`)}`);
	if (run.errorMessage) block("error", `Error: ${run.errorMessage}`);
	section("Task");
	block("dim", run.task);
	for (const message of run.messages as Msg[]) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "thinking" && part.thinking?.trim()) { section("Thinking"); block("muted", part.thinking.trim()); }
				else if (part.type === "text" && part.text?.trim()) { section("Assistant"); block("toolOutput", part.text.trim()); }
				else if (part.type === "toolCall") { out.push(""); out.push(theme.fg("muted", "→ ") + formatCall(part.name ?? "?", part.arguments ?? {}, theme.fg.bind(theme))); }
			}
		} else if (message.role === "toolResult") {
			const text = textOf(message.content).trimEnd();
			if (text) block(message.isError ? "error" : "dim", text);
		}
	}
	if (run.exitCode === -1) {
		if (run.liveThinking) { section("Thinking (live)"); block("muted", run.liveThinking); }
		if (run.liveTool) { out.push(""); out.push(theme.fg("warning", "⏳ ") + formatCall(run.liveTool.name, run.liveTool.args, theme.fg.bind(theme))); }
		if (run.liveToolOutput) block("dim", run.liveToolOutput);
		if (run.liveText) { section("Assistant (live)"); block("toolOutput", run.liveText); }
	}
	if (failed(run) && run.stderr?.trim()) { section("stderr"); block("error", run.stderr.trim().slice(-4000)); }
	return out;
}

function status(run: ViewerRun) {
	const seconds = Math.round((run.elapsedMs ?? (run.startedAt ? Date.now() - run.startedAt : 0)) / 1000);
	const state = run.exitCode === -1 ? run.phase ?? "running" : failed(run) ? `failed${run.stopReason ? " (" + run.stopReason + ")" : ""}` : "done";
	return `${state} · ${seconds}s`;
}

function statusIcon(run: ViewerRun, theme: Theme) {
	return run.exitCode === -1 ? theme.fg("warning", "⏳") : failed(run) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

export function createViewer(runs: () => ViewerRun[], theme: Theme, formatCall: FormatCall, done: () => void, requestRender: () => void, height: () => number) {
	let selected = Math.max(0, runs().length - 1);
	let open: ViewerRun | undefined;
	let scroll = 0;
	let follow = true;
	let lastPage = 1;
	// Live runs change without input; redraw while anything is running.
	const timer = setInterval(() => { if (runs().some(run => run.exitCode === -1)) requestRender(); }, 500);
	const close = () => { clearInterval(timer); done(); };

	function handleInput(data: string) {
		const list = runs();
		if (!open) {
			if (matchesKey(data, Key.escape) || data === "q") return close();
			if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
			else if (matchesKey(data, Key.down)) selected = Math.min(list.length - 1, selected + 1);
			else if (matchesKey(data, Key.enter) && list[selected]) { open = list[selected]; scroll = 0; follow = true; }
			else return;
			return requestRender();
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "q") { open = undefined; return requestRender(); }
		const step = matchesKey(data, Key.up) || data === "k" ? -1 : matchesKey(data, Key.down) || data === "j" ? 1
			: matchesKey(data, Key.pageUp) || data === "b" ? -lastPage : matchesKey(data, Key.pageDown) || data === " " ? lastPage
			: matchesKey(data, Key.home) || data === "g" ? -Infinity : matchesKey(data, Key.end) || data === "G" ? Infinity : 0;
		if (!step) return;
		follow = step === Infinity;
		scroll = step === -Infinity ? 0 : step === Infinity ? Number.MAX_SAFE_INTEGER : scroll + step;
		requestRender();
	}

	function render(width: number): string[] {
		const w = Math.max(20, width);
		const rows = Math.max(6, Math.floor(height()) - 1);
		const border = theme.fg("accent", "─".repeat(w));
		const list = runs();
		if (!open) {
			const lines = [border, " " + theme.bold(`Subagents (${list.length})`), ""];
			if (!list.length) lines.push(theme.fg("muted", " No subagent runs in this session yet."));
			const room = rows - 6;
			const first = Math.max(0, Math.min(selected - room + 1, list.length - room));
			list.slice(first, first + room).forEach((run, i) => {
				const index = first + i;
				const active = index === selected;
				const head = `${active ? theme.fg("accent", "› ") : "  "}${statusIcon(run, theme)} ${theme.fg(active ? "accent" : "text", run.agent)} ${theme.fg("dim", status(run))}  `;
				lines.push(truncateToWidth(head + theme.fg("muted", oneLine(run.task)), w));
			});
			lines.push("", theme.fg("dim", " ↑↓ select · Enter open transcript · Esc close"), border);
			return lines;
		}
		const body = transcript(open, theme, formatCall).flatMap(line => line ? wrapTextWithAnsi(line, w - 1).map(part => " " + part) : [""]);
		const room = rows - 3;
		lastPage = Math.max(1, room - 2);
		const max = Math.max(0, body.length - room);
		scroll = follow ? max : Math.max(0, Math.min(scroll, max));
		if (scroll === max) follow = true;
		const position = body.length > room ? `${scroll + 1}-${Math.min(body.length, scroll + room)} of ${body.length}` : `${body.length} lines`;
		const footer = ` ${position} · ↑↓/jk line · PgUp/PgDn page · g/G top/end · Esc back`;
		return [border, ...body.slice(scroll, scroll + room), theme.fg("dim", truncateToWidth(footer, w)), border].map(line => visibleWidth(line) > w ? truncateToWidth(line, w) : line);
	}

	return { render, handleInput, invalidate() {}, dispose: () => clearInterval(timer) };
}
