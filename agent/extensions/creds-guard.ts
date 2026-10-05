/** File-tool boundary; bash also has kernel-enforced credential/vault denials. */
import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isReadOnlyCommand } from "./lib/read-only.ts";

export const VAULT_ROOT = "/Users/rachitsrivastava/Library/CloudStorage/ProtonDrive-privacyprophetHQ@proton.me-folder/Obs";
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
export const SECRET_PATHS = [".ssh", ".gnupg", ".aws", ".aws-sam", ".docker", ".npmrc", ".netrc", ".git-credentials", ".pypirc", ".pi/agent/auth.json", ".pi/agent/models-store.json", ".config/opencode", ".config/stripe", ".config/github-copilot", ".config/sops", ".cargo/credentials", ".cargo/credentials.toml", ".mongodb", "ns-owner.key", "Library/Keychains", ".emulator_console_auth_token"].map(p => path.join(os.homedir(), p));

function within(target: string, root: string): boolean {
	return target === root || target.startsWith(root + path.sep);
}

/** Resolve symlinks even for a new file by resolving its nearest existing parent. */
export function canonicalPath(value: string, cwd: string): string {
	const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
	let existing = path.resolve(cwd, expanded);
	const suffix: string[] = [];
	while (true) {
		try { return path.join(realpathSync(existing), ...suffix); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			suffix.unshift(path.basename(existing));
			existing = parent;
		}
	}
}

export function pathDenied(value: string, cwd: string, recursive = false): string | undefined {
	const target = canonicalPath(value, cwd);
	const vault = canonicalPath(VAULT_ROOT, cwd);
	const sessionInVault = within(canonicalPath(cwd, cwd), vault);
	if (!sessionInVault && within(target, vault) && !within(target, path.join(vault, "Agents"))) return "vault outside Agents/";
	if (!sessionInVault && recursive && within(vault, target) && !within(target, path.join(vault, "Agents"))) return "recursive access includes the private vault";
	for (const secret of SECRET_PATHS) {
		const resolvedSecret = canonicalPath(secret, cwd);
		if (within(target, resolvedSecret) || (recursive && within(resolvedSecret, target))) return "credential surface";
	}
	if (target.split(path.sep).some(p => /^\.env(?:$|\.)/.test(p) && !/^\.env\.(example|sample|template|dist)$/.test(p))) return ".env secrets";
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (event.toolName === "bash") {
			const command = String(input.command ?? "");
			if (process.env.PI_SUBAGENT_READ_ONLY === "1" && !isReadOnlyCommand(command)) return { block: true, reason: "Read-only subagent: command is outside the permitted shell subset." };
			// Bash never accesses the vault; planner/executor use canonicalized file tools.
			// The OS denyRead additionally blocks indirect/obfuscated shell access.
			if (command.includes("ProtonDrive") || command.includes(VAULT_ROOT)) return { block: true, reason: "Use file tools for vault access; bash vault access is disabled." };
			if (/(^|[\s"'=(/:])\.env(?!\.(?:example|sample|template|dist)(?=$|[\s"'/]))/.test(command) || /\.(?:ssh|aws|gnupg|npmrc|netrc|git-credentials)(?=$|[\s"'/])/.test(command) || /\.pi\/agent\/(?:auth|models-store)\.json/.test(command)) return { block: true, reason: "Credential access blocked by creds-guard." };
			return;
		}
		if (!FILE_TOOLS.has(event.toolName)) return;
		const raw = [input.path, input.file_path, input.filePath].find(v => typeof v === "string") as string | undefined;
		try {
			const reason = pathDenied(raw ?? ".", ctx.cwd, event.toolName === "grep" || event.toolName === "find");
			if (reason) return { block: true, reason: `Blocked by creds-guard: ${reason}.` };
		} catch { return { block: true, reason: "creds-guard could not safely resolve the target path." }; }
	});
}
