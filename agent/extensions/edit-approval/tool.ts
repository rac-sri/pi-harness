/** Explicitly loaded for executor children; fd 3 connects to the parent UI. */
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { needsEditApproval } from "../lib/edit-approval.ts";

export default function (pi: ExtensionAPI) {
	let stream: Socket | undefined;
	let sequence = 0;
	const pending = new Map<string, (allow: boolean) => void>();
	const denyPending = () => { for (const resolve of pending.values()) resolve(false); pending.clear(); };
	pi.on("tool_call", async (event, ctx) => {
		if (!needsEditApproval(event.toolName, event.input)) return;
		if (process.env.PI_EXECUTOR_EDIT_APPROVAL !== "1") return { block: true, reason: "Edit approval requires the main session's input UI." };
		if (!stream) {
			try {
				stream = new Socket({ fd: 3, readable: true, writable: true });
				stream.on("error", denyPending);
				stream.on("close", denyPending);
				createInterface({ input: stream }).on("line", line => {
					try {
						const response = JSON.parse(line);
						pending.get(response.id)?.(response.allow === true);
						pending.delete(response.id);
					} catch { denyPending(); }
				});
			} catch { return { block: true, reason: "Edit approval connection unavailable." }; }
		}
		const connection = stream;
		const id = String(++sequence);
		const allow = await new Promise<boolean>(resolve => {
			if (connection.destroyed) return resolve(false);
			pending.set(id, resolve);
			connection.write(JSON.stringify({ id, toolName: event.toolName, input: event.input, cwd: ctx.cwd }) + "\n", error => {
				if (error) { pending.delete(id); resolve(false); }
			});
		});
		if (!allow) return { block: true, reason: "Edit skipped by the user (or approval unavailable). Do not retry this edit through another tool or bash; continue only with approved work." };
	});
	pi.on("session_shutdown", async () => { denyPending(); stream?.destroy(); });
}
