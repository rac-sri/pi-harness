import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function repositoryRoot(cwd: string): string {
	let current = fs.realpathSync(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return fs.realpathSync(cwd);
		current = parent;
	}
}

function alive(pid: unknown): boolean {
	if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
	try { process.kill(Number(pid), 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Cross-process exclusion. A crashed coordinator cannot orphan a live writer. */
export function acquireWriter(cwd: string, directory = path.join(getAgentDir(), "harness", "locks")) {
	const repo = repositoryRoot(cwd);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const file = path.join(directory, createHash("sha256").update(repo).digest("hex") + ".json");
	let fd: number;
	try { fd = fs.openSync(file, "wx", 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let owner;
		try { owner = JSON.parse(fs.readFileSync(file, "utf8")); }
		catch { throw new Error(`Writer lock is being initialized or is corrupt: ${file}`); }
		if (alive(owner.pid) || alive(owner.childPid)) throw new Error(`Repository already has an active writer: ${repo}`);
		throw new Error(`Interrupted writer lock: ${file}. Both recorded processes have exited; inspect the repository before removing this lock.`);
	}
	const owner = { pid: process.pid, childPid: 0, repo, startedAt: new Date().toISOString() };
	const save = () => { fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(owner), 0, "utf8"); fs.fsyncSync(fd); };
	save();
	return {
		repo,
		childStarted(pid: number) { owner.childPid = pid; save(); },
		release() { fs.closeSync(fd); fs.unlinkSync(file); },
	};
}
