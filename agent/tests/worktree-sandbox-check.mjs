// A parallel executor runs in a linked git worktree under the bash sandbox. Its commits write to
// the main repository's .git (worktree admin dir, objects, refs, logs), which the sandbox must
// allow, while the main repository's config and hooks stay write-protected.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { worktreeGitPaths } from "../extensions/sandbox/index.ts";

// Outside /tmp, which the sandbox always allows and would hide a missing permission.
const root = fs.mkdtempSync(path.join(os.homedir(), ".pi-worktree-check-"));
try {
	const repo = path.join(root, "repo"), worktree = path.join(root, "wt");
	const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	fs.mkdirSync(repo);
	git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
	fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
	git(repo, "worktree", "add", "-q", worktree, "-b", "wt/check");
	fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");

	const common = fs.realpathSync(path.join(repo, ".git"));
	const extra = worktreeGitPaths(worktree).map(p => p.replace(/^.*\/\.git/, common));
	assert.deepEqual(extra.map(p => path.relative(common, p)), ["worktrees/wt", "objects", "refs", "logs"], "worktree needs only its admin dir, objects, refs and logs");
	assert.deepEqual(worktreeGitPaths(repo), [], "a normal checkout needs nothing extra");
	assert.deepEqual(worktreeGitPaths(os.tmpdir()), [], "outside a repository needs nothing extra");

	const settings = path.join(root, "srt.json");
	fs.writeFileSync(settings, JSON.stringify({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [worktree, "/tmp", "/private/tmp", ...worktreeGitPaths(worktree)], denyWrite: [] } }));
	const srt = path.join(import.meta.dirname, "../extensions/sandbox/node_modules/.bin/srt");
	const run = command => { try { return execFileSync(srt, ["-s", settings, "-c", command], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { return String(error.stdout ?? "") + String(error.stderr ?? ""); } };
	assert.match(run("git add b.txt && git commit -qm check && echo COMMITTED"), /COMMITTED/, "sandboxed commit in a worktree succeeds");
	assert.match(run(`echo x >> ${JSON.stringify(path.join(repo, ".git/config"))} && echo WROTE || echo DENIED`), /DENIED/, "main repository config stays protected");
	assert.match(run(`touch ${JSON.stringify(path.join(repo, ".git/hooks/pre-commit"))} && echo WROTE || echo DENIED`), /DENIED/, "main repository hooks stay protected");
	git(repo, "cherry-pick", "wt/check");
	assert.ok(fs.existsSync(path.join(repo, "b.txt")), "worktree commit cherry-picks back");
	console.log("Passed 7 worktree sandbox checks.");
} finally {
	try { execFileSync("git", ["-C", path.join(root, "repo"), "worktree", "prune"]); } catch {}
	fs.rmSync(root, { recursive: true, force: true });
}
