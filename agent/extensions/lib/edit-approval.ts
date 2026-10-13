import type { Duplex } from "node:stream";
import { createInterface } from "node:readline";
import { isReadOnlyCommand } from "./read-only.ts";
import { FILE_MUTATING_TOOLS } from "./tools.ts";

export interface EditRequest {
	id: string;
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
}

export const EDIT_CHOICES = ["Apply this edit", "Skip this edit", "Edit without asking for this session"];

export function needsEditApproval(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "bash") return !isReadOnlyCommand(String(input.command ?? ""));
	if (toolName === "lsp_navigation") {
		return !new Set(["definition", "typeDefinition", "declaration", "references", "hover", "signatureHelp", "documentSymbol", "findSymbol", "workspaceSymbol", "implementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls", "workspaceDiagnostics", "capabilities"]).has(String(input.operation ?? ""));
	}
	return FILE_MUTATING_TOOLS.has(toolName);
}

// Shared by every executor dispatch in the main session. Serialize prompts so
// parallel executors cannot replace one another's input dialog.
export function createEditApproval(select: (request: EditRequest, signal?: AbortSignal) => Promise<string | undefined>) {
	let automatic = false;
	let generation = 0;
	let queue = Promise.resolve();
	return {
		reset() { automatic = false; generation++; },
		request(request: EditRequest, signal?: AbortSignal): Promise<boolean> {
			const requestedGeneration = generation;
			const result = queue.then(async () => {
				if (signal?.aborted || requestedGeneration !== generation) return false;
				if (automatic) return true;
				const answer = await select(request, signal);
				if (signal?.aborted || requestedGeneration !== generation) return false;
				if (answer === EDIT_CHOICES[2]) automatic = true;
				return automatic || answer === EDIT_CHOICES[0];
			});
			queue = result.then(() => {}, () => {});
			return result;
		},
	};
}

export type ApproveEdit = (request: EditRequest, signal?: AbortSignal) => Promise<boolean>;

export function serveEditApprovals(stream: Duplex, approve: ApproveEdit | undefined, signal?: AbortSignal, waiting?: (value: boolean) => void) {
	const lines = createInterface({ input: stream });
	const controller = new AbortController();
	let pending = 0;
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	lines.on("line", async line => {
		let request: EditRequest;
		try { request = JSON.parse(line); } catch { return; }
		if (typeof request.id !== "string" || typeof request.toolName !== "string" || !request.input || typeof request.cwd !== "string") return;
		if (pending++ === 0) waiting?.(true);
		let allow = false;
		try { allow = await approve?.(request, controller.signal) ?? false; } catch { /* Fail closed. */ }
		finally { if (--pending === 0) waiting?.(false); }
		if (!stream.destroyed && !controller.signal.aborted) stream.write(JSON.stringify({ id: request.id, allow }) + "\n");
	});
	return () => {
		abort();
		signal?.removeEventListener("abort", abort);
		lines.close();
	};
}
