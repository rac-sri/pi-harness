import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { getAgentDir, type BashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalPath, pathDenied } from "../creds-guard.ts";
import { repositoryRoot } from "./writer-lock.ts";

const git = "git -c core.fsmonitor=false -c core.untrackedCache=false";
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export interface Check { id: string; command: string; property: string }
export interface Evidence {
	id: string; check: string; command: string; cwd: string; seed?: string;
	startedAt: string; durationMs: number; exitCode: number | null;
	before: string; after: string; passed: boolean; outputPath: string; outputHash: string;
	head: string | null; gitTree: string | null;
}
export interface RunState {
	version: 1; run: string; repo: string; contract: string; checks: Check[];
	phase: "pending" | "implemented" | "verified" | "committed";
	evidence: Evidence[]; commit?: string; verifiedTree?: string;
}
export interface HarnessInput {
	action: string; run: string; contract?: string; checks?: Check[];
	check?: string; seed?: string; timeoutSeconds?: number; files?: string[]; message?: string;
}

async function execute(ops: BashOperations, cwd: string, command: string, signal?: AbortSignal, timeout = 60) {
	const chunks: Buffer[] = [];
	const result = await ops.exec(command, cwd, { onData: chunk => chunks.push(Buffer.from(chunk)), signal, timeout });
	return { output: Buffer.concat(chunks).toString("utf8"), exitCode: result.exitCode };
}

async function gitOutput(ops: BashOperations, cwd: string, args: string, signal?: AbortSignal) {
	const result = await execute(ops, cwd, `${git} ${args}`, signal);
	if (result.exitCode !== 0) throw new Error(`Git inspection failed: ${result.output.slice(-2000)}`);
	return result.output;
}

/** Hash the current checkout, including deletions and nonignored untracked files. */
export async function fingerprint(repo: string, ops: BashOperations, signal?: AbortSignal): Promise<string> {
	repo = fs.realpathSync(repo);
	const files = (await gitOutput(ops, repo, "ls-files --cached --others --exclude-standard -z", signal)).split("\0").filter(Boolean);
	const hash = createHash("sha256");
	for (const file of [...new Set(files)].sort()) {
		const target = path.resolve(repo, file);
		if (!target.startsWith(repo + path.sep)) throw new Error(`Git path escapes repository: ${file}`);
		hash.update(JSON.stringify(file));
		let stat;
		try { stat = fs.lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { hash.update("deleted"); continue; } throw error; }
		if (stat.isSymbolicLink()) {
			hash.update("symlink:" + fs.readlinkSync(target));
			const resolved = canonicalPath(target, repo);
			if (!resolved.startsWith(repo + path.sep) || pathDenied(resolved, repo)) throw new Error(`Cannot fingerprint external or protected symlink: ${file}`);
			const linked = fs.statSync(resolved);
			if (!linked.isFile()) throw new Error(`Directory symlinks require separate verification: ${file}`);
			hash.update(String(linked.mode & 0o777));
			for await (const chunk of fs.createReadStream(resolved)) hash.update(chunk);
			continue;
		}
		if (stat.isDirectory()) {
			const subRoot = (await gitOutput(ops, target, "rev-parse --show-toplevel", signal)).trim();
			if (fs.realpathSync(subRoot) !== fs.realpathSync(target)) throw new Error(`Uninitialized submodule: ${file}`);
			hash.update("submodule:" + (await gitOutput(ops, target, "rev-parse HEAD", signal)).trim());
			hash.update(await fingerprint(target, ops, signal));
			continue;
		}
		if (!stat.isFile()) throw new Error(`Cannot fingerprint special file: ${file}`);
		if (pathDenied(target, repo)) throw new Error(`Cannot fingerprint protected file: ${file}`);
		hash.update(String(stat.mode & 0o777));
		for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
	}
	return hash.digest("hex");
}

function validateName(value: string, label: string) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value)) throw new Error(`Invalid ${label}`);
}

export function assertVerified(state: RunState, tree: string) {
	if (!state.checks.length) throw new Error("No required checks defined");
	for (const check of state.checks) {
		const evidence = state.evidence.filter(item => item.check === check.id).at(-1);
		if (!evidence?.passed || evidence.after !== tree || evidence.before !== tree) throw new Error(`Missing, failed, or stale evidence for ${check.id}; rerun against the current checkout`);
		if (!fs.existsSync(evidence.outputPath) || digest(fs.readFileSync(evidence.outputPath)) !== evidence.outputHash) throw new Error(`Evidence output missing or changed for ${check.id}`);
	}
}

export async function runHarnessAction(input: HarnessInput, cwd: string, ops: BashOperations, signal?: AbortSignal, store = path.join(getAgentDir(), "harness", "runs"), onProgress?: (text: string) => void) {
	validateName(input.run, "run id");
	const repo = repositoryRoot(cwd);
	const directory = path.join(store, digest(repo), input.run);
	const stateFile = path.join(directory, "state.json");
	const load = (): RunState => JSON.parse(fs.readFileSync(stateFile, "utf8"));
	if (input.action === "status") {
		const state = load();
		let evidenceFresh = false;
		try { assertVerified(state, await fingerprint(repo, ops, signal)); evidenceFresh = true; } catch { /* Show stale state explicitly. */ }
		return { ...state, stateFile, evidenceFresh };
	}
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lockFile = path.join(directory, ".lock");
	let lock;
	try { lock = fs.openSync(lockFile, "wx", 0o600); }
	catch { throw new Error(`Run ${input.run} is busy or has an interrupted operation; inspect ${lockFile} before removing it`); }
	const save = (state: RunState) => {
		const temporary = stateFile + ".tmp";
		fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(temporary, stateFile);
	};
	try {
		fs.writeSync(lock, JSON.stringify({ pid: process.pid, action: input.action, at: new Date().toISOString() }));
		if (input.action === "define") {
			if (fs.existsSync(stateFile)) throw new Error("Run already exists; use a new run id for a revised contract");
			if (!input.contract?.trim() || !input.checks?.length) throw new Error("A correctness contract and required checks are mandatory");
			const seen = new Set<string>();
			for (const check of input.checks) {
				validateName(check.id, "check id");
				if (seen.has(check.id) || !check.command?.trim() || !check.property?.trim()) throw new Error("Checks need unique ids, commands, and properties");
				seen.add(check.id);
			}
			await gitOutput(ops, repo, "rev-parse --show-toplevel", signal);
			const state: RunState = { version: 1, run: input.run, repo, contract: input.contract, checks: input.checks, phase: "pending", evidence: [] };
			save(state);
			return { ...state, stateFile };
		}
		const state = load();
		if (state.repo !== repo) throw new Error("Run belongs to another repository");
		if (state.phase === "committed" && input.action !== "complete") throw new Error("Checkpoint already committed; start a new run for further changes");
		if (input.action === "implemented") {
			state.phase = "implemented";
			state.verifiedTree = undefined;
			save(state);
		} else if (input.action === "verify") {
			if (state.phase === "pending") throw new Error("Mark implementation complete before verification");
			const check = state.checks.find(check => check.id === input.check);
			if (!check) throw new Error("Unknown required check");
			const timeout = input.timeoutSeconds ?? 300;
			if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error("Verification timeout must be 1–3600 seconds");
			const before = await fingerprint(repo, ops, signal);
			const head = await execute(ops, repo, `${git} rev-parse --verify HEAD`, signal);
			const gitTree = await execute(ops, repo, `${git} rev-parse --verify 'HEAD^{tree}'`, signal);
			const id = randomUUID();
			const outputPath = path.join(directory, id + ".log");
			const outputFd = fs.openSync(outputPath, "wx", 0o600);
			const outputHash = createHash("sha256");
			const started = Date.now();
			let exitCode: number | null = null;
			let failure: string | undefined;
			const command = input.seed === undefined ? check.command : `export HARNESS_SEED=${quote(input.seed)};\n${check.command}`;
			try {
				const result = await ops.exec(command, repo, { signal, timeout, onData: chunk => {
					const data = Buffer.from(chunk); fs.writeSync(outputFd, data); outputHash.update(data); onProgress?.(data.toString("utf8"));
				} });
				exitCode = result.exitCode;
			} catch (error) { failure = String(error); }
			finally { fs.fsyncSync(outputFd); fs.closeSync(outputFd); }
			let after = "unavailable";
			try { after = await fingerprint(repo, ops, signal); } catch (error) { failure ??= String(error); }
			const evidence: Evidence = { id, check: check.id, command: check.command, cwd: repo, seed: input.seed, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, exitCode, before, after, head: head.exitCode === 0 ? head.output.trim() : null, gitTree: gitTree.exitCode === 0 ? gitTree.output.trim() : null, passed: exitCode === 0 && before === after && !failure, outputPath, outputHash: outputHash.digest("hex") };
			state.evidence.push(evidence);
			state.phase = "implemented";
			state.verifiedTree = undefined;
			save(state);
			try { assertVerified(state, after); state.phase = "verified"; state.verifiedTree = after; save(state); } catch { /* Other checks remain pending or stale. */ }
			return { evidence, phase: state.phase, stateFile, failure };
		} else if (input.action === "complete" || input.action === "checkpoint") {
			const tree = await fingerprint(repo, ops, signal);
			assertVerified(state, tree);
			if (state.phase !== "committed") state.phase = "verified";
			state.verifiedTree = tree;
			save(state);
			if (input.action === "checkpoint") {
				if (!input.files?.length || !input.message?.trim()) throw new Error("Checkpoint needs explicit files and a commit message");
				if ((await gitOutput(ops, repo, "diff --cached --name-only -z", signal)).length) throw new Error("Index already contains staged work; checkpoint refused");
				const changed = (await gitOutput(ops, repo, "ls-files --modified --deleted --others --exclude-standard -z", signal)).split("\0").filter(Boolean);
				const files = [...new Set(input.files)];
				for (const file of files) {
					const target = path.resolve(repo, file);
					if (!target.startsWith(repo + path.sep) || file.startsWith("-") || pathDenied(target, repo) || !changed.includes(file)) throw new Error(`Invalid or unchanged checkpoint file: ${file}`);
				}
				if (changed.some(file => !files.includes(file))) throw new Error("Checkout includes changes outside checkpoint files; isolate or resolve them first");
				await gitOutput(ops, repo, "add -- " + files.map(quote).join(" "), signal);
				if (await fingerprint(repo, ops, signal) !== tree) throw new Error("Checkout changed while staging; checkpoint refused");
				await gitOutput(ops, repo, "commit -m " + quote(input.message), signal);
				if (await fingerprint(repo, ops, signal) !== tree) throw new Error("Commit hooks changed the checkout; rerun verification");
				if ((await gitOutput(ops, repo, "status --porcelain", signal)).trim()) throw new Error("Checkout is dirty after commit; checkpoint remains uncommitted in harness state");
				state.commit = (await gitOutput(ops, repo, "rev-parse HEAD", signal)).trim();
				state.phase = "committed";
				save(state);
			}
		} else throw new Error("Unknown harness action");
		return { ...state, stateFile };
	} finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
}

export function registerVerification(pi: ExtensionAPI, getOperations: () => BashOperations) {
	pi.registerTool({
		name: "harness_check", label: "Verification checkpoint",
		description: "Define an immutable correctness contract and required checks, mark implemented, run sandboxed verification with durable evidence, inspect status, validate completion, or commit explicitly scoped files. Use one run per checkpoint. Evidence must match the current checkout; failed/stale checks block completion.",
		parameters: Type.Object({
			action: Type.Union(["define", "implemented", "verify", "status", "complete", "checkpoint"].map(value => Type.Literal(value))),
			run: Type.String(), contract: Type.Optional(Type.String()),
			checks: Type.Optional(Type.Array(Type.Object({ id: Type.String(), command: Type.String(), property: Type.String() }))),
			check: Type.Optional(Type.String()), seed: Type.Optional(Type.String()), timeoutSeconds: Type.Optional(Type.Number()),
			files: Type.Optional(Type.Array(Type.String())), message: Type.Optional(Type.String()),
		}),
		async execute(_id, input, signal, onUpdate, ctx) {
			let preview = "";
			const result = await runHarnessAction(input, ctx.cwd, getOperations(), signal, undefined, text => {
				preview = (preview + text).slice(-4000);
				onUpdate?.({ content: [{ type: "text", text: preview }], details: {} });
			});
			// Keep routine transitions small in the model context; full records remain
			// on disk and are returned by status for independent review.
			const display = input.action !== "status" && "checks" in result
				? { run: result.run, phase: result.phase, stateFile: result.stateFile, verifiedTree: result.verifiedTree, commit: result.commit, requiredChecks: result.checks.map(check => check.id) }
				: result;
			return { content: [{ type: "text", text: JSON.stringify(display, null, 2) }], details: result, isError: "evidence" in result && !Array.isArray(result.evidence) && !result.evidence.passed };
		},
	});
}
