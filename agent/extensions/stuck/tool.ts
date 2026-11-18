/**
 * Subagent-only stuck reminder (see extensions/lib/stuck.ts). Loaded explicitly by the
 * subagent dispatcher; there is no index.ts, so the main session never installs it.
 * Appends a one-time "change approach" note to the result of a repeated identical call.
 * Ending the run is the dispatcher's job.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createStreakTracker, stuckReminder } from "../lib/stuck.ts";

export default function stuck(pi: ExtensionAPI) {
	const tracker = createStreakTracker();
	pi.on("tool_result", async event => {
		const verdict = tracker.record(event.toolName, event.input, event.isError);
		if (!verdict.remind) return;
		return { content: [...event.content, { type: "text", text: stuckReminder(event.toolName, verdict) }] };
	});
}
