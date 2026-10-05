/**
 * advisor-patch-guard: keeps the local pi-advisor-flow session-id patch in place.
 *
 * WHY. pi-advisor-flow 0.11.1 builds Advisor stream options as {reasoning, signal} and never
 * forwards a session id, but pi-ai derives OpenCode's mandatory `x-opencode-session` header ONLY
 * from options.sessionId (pi-ai/dist/providers/opencode-headers.js -> withSessionHeader). OpenCode
 * Go now rejects requests without it (HTTP 400 {"type":"MissingSessionID"}), so every Advisor
 * consultation aimed at an opencode-go/* model fails while the Executor is fine (Pi's agent loop
 * supplies sessionId). agent/patches/advisor-session-header.mjs fixes the plugin in place, but
 * `pi update` replaces the package and silently un-fixes it.
 *
 * THIS GUARD. At load — before any Advisor call resolves a model — it re-applies the patch when the
 * loaded bundle has lost it and reports what it did on session_start. pi-advisor-flow may already be
 * imported in this same process, so a /reload can still be needed; the guard guarantees the fix is on
 * disk for the next load. It only ever touches the two known files inside the plugin package, and a
 * failure here never breaks the session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const MARKER = "sessionId: resolved.sessionId";

export default function (pi: ExtensionAPI) {
	let notice: { text: string; kind: "info" | "warning" } | undefined;
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME ?? "", ".pi", "agent");
		const pkg = path.join(agentDir, "npm/node_modules/pi-advisor-flow");
		const bundle = path.join(pkg, "dist/index.js");
		const script = path.join(agentDir, "patches/advisor-session-header.mjs");
		// No plugin, no patch script, or already patched: nothing to say.
		if (!existsSync(bundle) || !existsSync(script)) return;
		if (readFileSync(bundle, "utf8").includes(MARKER)) return;

		const result = spawnSync(process.execPath, [script, pkg], { encoding: "utf8", timeout: 20_000 });
		notice = result.status === 0
			? { kind: "info", text: "[advisor-patch-guard] Re-applied the pi-advisor-flow session-id patch (`pi update` had reverted it). Run /reload if Advisor calls still report MissingSessionID." }
			: { kind: "warning", text: `[advisor-patch-guard] pi-advisor-flow is unpatched — Advisor calls on OpenCode will fail — and re-applying failed: ${String(result.stderr ?? "").trim().slice(0, 200) || `exit ${result.status}`}. Run: node agent/patches/advisor-session-header.mjs` };
	} catch (error) {
		notice = { kind: "warning", text: `[advisor-patch-guard] startup check failed: ${(error as Error).message}` };
	}

	if (!notice) return;
	const pending = notice;
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify(pending.text, pending.kind);
	});
}
