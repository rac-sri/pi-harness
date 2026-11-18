/**
 * Stuck detection for subagents: streaks of consecutive identical tool calls
 * (same tool, same arguments). Thresholds follow Fan et al. 2026 (arXiv:2609.20804):
 * a one-time reminder after 5 identical calls, and the run is ended after 8
 * identical calls that all failed. A child extension (extensions/stuck/tool.ts)
 * appends the reminder to the tool result; the dispatcher ends the run. Both feed
 * the same events in the same order, so their counts agree.
 */

export const REMIND_AFTER = 5;
export const STOP_AFTER_FAILURES = 8;

/** Key identifying a call: tool name plus arguments with object keys sorted. */
export function callKey(toolName: string, args: unknown): string {
	const stable = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(stable);
		if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]));
		return value;
	};
	return `${toolName}\0${JSON.stringify(stable(args ?? {}))}`;
}

export interface StreakVerdict {
	/** Consecutive identical calls, this one included. */
	count: number;
	/** Consecutive identical calls that all failed, this one included (0 if it succeeded). */
	failing: number;
	/** True exactly once per streak, when it reaches REMIND_AFTER. */
	remind: boolean;
	/** True once the failing streak reaches STOP_AFTER_FAILURES. */
	stop: boolean;
}

export function createStreakTracker() {
	let last: string | undefined;
	let count = 0, failing = 0, reminded = false;
	return {
		record(toolName: string, args: unknown, isError: boolean): StreakVerdict {
			const key = callKey(toolName, args);
			if (key === last) count++;
			else { last = key; count = 1; failing = 0; reminded = false; }
			failing = isError ? failing + 1 : 0;
			const remind = !reminded && (count >= REMIND_AFTER || failing >= REMIND_AFTER);
			if (remind) reminded = true;
			return { count, failing, remind, stop: failing >= STOP_AFTER_FAILURES };
		},
	};
}

export function stuckReminder(toolName: string, verdict: StreakVerdict): string {
	const failed = verdict.failing ? `, the last ${verdict.failing} failed` : "";
	return `\n\n[harness] This is the same ${toolName} call, with the same arguments, ${verdict.count} times in a row${failed}. Repeating it will not change the result. Change approach: re-read the relevant code, question the assumption behind this call, or stop and report what is blocking you. ${STOP_AFTER_FAILURES} identical failing calls end the run.`;
}
