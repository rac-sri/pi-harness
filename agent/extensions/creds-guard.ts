/** File-tool boundary; bash also has kernel-enforced credential/vault denials. */
import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isReadOnlyCommand, READ_ONLY_HINT } from "./lib/read-only.ts";

export const VAULT_ROOT = "/Users/rachitsrivastava/Library/CloudStorage/ProtonDrive-privacyprophetHQ@proton.me-folder/Obs";
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "lens_diagnostics", "symbol_search", "ast_grep_search", "ast_grep_replace", "ast_grep_outline", "module_report", "read_symbol", "read_enclosing", "project_report", "effective_config", "lsp_navigation"]);
const RECURSIVE_TOOLS = new Set(["grep", "find", "symbol_search", "ast_grep_search", "ast_grep_replace", "ast_grep_outline", "project_report"]);
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
		if (event.toolName === "harness_check") {
			if (process.env.PI_SUBAGENT_READ_ONLY === "1" && input.action !== "status") return { block: true, reason: "Read-only subagent may only inspect verification status." };
			return;
		}
		if (event.toolName === "bash") {
			const command = String(input.command ?? "");
			if (process.env.PI_SUBAGENT_READ_ONLY === "1" && !isReadOnlyCommand(command)) return { block: true, reason: `Read-only subagent: command is outside the permitted shell subset. ${READ_ONLY_HINT}` };
			// Bash never accesses the vault; planner/executor use canonicalized file tools.
			// The OS denyRead additionally blocks indirect/obfuscated shell access.
			if (command.includes("ProtonDrive") || command.includes(VAULT_ROOT)) return { block: true, reason: "Use file tools for vault access; bash vault access is disabled." };
			if (/(^|[\s"'=(/:])\.env(?!\.(?:example|sample|template|dist)(?=$|[\s"'/]))/.test(command) || /\.(?:ssh|aws|gnupg|npmrc|netrc|git-credentials)(?=$|[\s"'/])/.test(command) || /\.pi\/agent\/(?:auth|models-store)\.json/.test(command)) return { block: true, reason: "Credential access blocked by creds-guard." };
			return;
		}
		if (!FILE_TOOLS.has(event.toolName)) return;
		const candidates = [input.path, input.file_path, input.filePath, input.root, input.rootPath, input.newFilePath].filter((value): value is string => typeof value === "string");
		if (Array.isArray(input.paths)) candidates.push(...input.paths.filter((value): value is string => typeof value === "string" && !value.startsWith("!")));
		if (!candidates.length) candidates.push(".");
		try {
			for (const raw of candidates) {
				// Recursive extension searches accept globs: guard the whole possible
				// expansion rather than treating '*' as a literal filename.
				const recursive = RECURSIVE_TOOLS.has(event.toolName);
				const glob = recursive ? raw.search(/[?*\[{]/) : -1;
				const prefix = glob >= 0 ? raw.slice(0, glob) : raw;
				const target = glob >= 0 ? (prefix.endsWith(path.sep) ? prefix : path.dirname(prefix)) || "." : raw;
				if (recursive && raw.split(path.sep).some(part => part.startsWith(".env") && /[?*\[{]/.test(part))) return { block: true, reason: "Credential glob blocked by creds-guard." };
				if (["write", "edit", "ast_grep_replace", "lsp_navigation"].includes(event.toolName) && within(canonicalPath(target, ctx.cwd), canonicalPath(path.join(getAgentDir(), "harness"), ctx.cwd))) return { block: true, reason: "Harness evidence is managed by harness_check; direct edits are blocked." };
				const reason = pathDenied(target, ctx.cwd, recursive);
				if (reason) return { block: true, reason: `Blocked by creds-guard: ${reason}.` };
			}
		} catch { return { block: true, reason: "creds-guard could not safely resolve the target path." }; }
	});
}
