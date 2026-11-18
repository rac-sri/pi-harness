/**
 * Per-dispatch measurements, appended as one JSON line per subagent run to
 * <agentDir>/harness/metrics/dispatches.jsonl. They answer the questions that decide
 * harness settings per model (Fan et al. 2026): how close runs get to the context
 * window, how often turn limits or stuck detection end them, and how many tool calls
 * and re-edits a solved task costs. No task text or tool arguments are stored.
 * Summarise with `node agent/scripts/dispatch-stats.mjs`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FILE_MUTATING_TOOLS } from "./tools.ts";

export type StopKind = "stuck" | "max-turns" | "max-output" | "deadline" | "completion-rejected" | "provider" | "error";

/** Why a dispatch ended early, from its error message; undefined when it didn't. */
export function stopKind(errorMessage?: string): StopKind | undefined {
	if (!errorMessage) return undefined;
	if (/^STUCK\b/.test(errorMessage)) return "stuck";
	if (/reached \d+ turns/.test(errorMessage)) return "max-turns";
	if (/reached \d+ output tokens/.test(errorMessage)) return "max-output";
	if (/deadline/.test(errorMessage)) return "deadline";
	if (/completion rejected/.test(errorMessage)) return "completion-rejected";
	if (/\b(429|402|401|403)\b|quota|usage limit|rate limit/i.test(errorMessage)) return "provider";
	return "error";
}

export interface DispatchRecord {
	at: string; role: string; model?: string; outcome: "ok" | "failed" | "aborted";
	stop?: StopKind; elapsedMs: number; turns: number; toolCalls: number; failedToolCalls: number;
	tools: Record<string, number>; reEdits: number; peakContextTokens: number;
	input: number; output: number; cacheRead: number; cost: number;
}

export function createDispatchMetrics() {
	const tools: Record<string, number> = {};
	const edited = new Set<string>();
	let toolCalls = 0, failedToolCalls = 0, reEdits = 0, peakContextTokens = 0;
	return {
		toolStart(name: string, args: any) {
			toolCalls++;
			tools[name] = (tools[name] ?? 0) + 1;
			const file = typeof args?.path === "string" ? args.path : undefined;
			// lsp_navigation writes only for renames and code actions; its reads would count as re-edits.
			if (file && FILE_MUTATING_TOOLS.has(name) && name !== "lsp_navigation") { if (edited.has(file)) reEdits++; else edited.add(file); }
		},
		toolEnd(isError: boolean) { if (isError) failedToolCalls++; },
		context(tokens: number) { if (tokens > peakContextTokens) peakContextTokens = tokens; },
		get peakContextTokens() { return peakContextTokens; },
		snapshot() { return { toolCalls, failedToolCalls, tools: { ...tools }, reEdits, peakContextTokens }; },
	};
}

export function appendDispatchRecord(agentDir: string, record: DispatchRecord) {
	if (process.env.PI_DISPATCH_METRICS === "off") return; // Tests with fake children against the real agent dir.
	try {
		const directory = path.join(agentDir, "harness", "metrics");
		fs.mkdirSync(directory, { recursive: true });
		fs.appendFileSync(path.join(directory, "dispatches.jsonl"), JSON.stringify(record) + "\n");
	} catch { /* Metrics never fail a dispatch. */ }
}
