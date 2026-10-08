// Verifies agent/extensions/advisor-patch-guard.ts: an unpatched pi-advisor-flow gets
// re-patched at extension load, a patched one is left alone and stays silent.
// Run: node agent/tests/advisor-patch-guard.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { root, modules, jiti } from "./lib/loader.mjs";

const MARKER = "sessionId: resolved.sessionId";
const TARBALL_DIR = "/tmp/pav"; // holds pi-advisor-flow-0.11.1.tgz (npm pack)

// Unpack a pristine pi-advisor-flow@0.11.1 so the guard has something real to fix.
const pristineCopy = (dest) => {
	fs.mkdirSync(dest, { recursive: true });
	const tarball = fs.existsSync(path.join(TARBALL_DIR, "pi-advisor-flow-0.11.1.tgz"))
		? path.join(TARBALL_DIR, "pi-advisor-flow-0.11.1.tgz")
		: undefined;
	if (!tarball) throw new Error(`pristine tarball missing: run npm pack pi-advisor-flow@0.11.1 into ${TARBALL_DIR}`);
	execFileSync("tar", ["xzf", tarball, "-C", dest], { stdio: "ignore" });
	const unpacked = path.join(dest, "package");
	const pkgDir = path.join(dest, "pi-advisor-flow");
	fs.renameSync(unpacked, pkgDir);
	return pkgDir;
};
const guard = (await jiti.import(path.join(root, "extensions/advisor-patch-guard.ts"))).default ?? (await jiti.import(path.join(root, "extensions/advisor-patch-guard.ts")));

const run = (agentDir) => {
	const hooks = new Map();
	const notifications = [];
	guard({ on: (name, fn) => hooks.set(name, fn), registerCommand() {}, registerShortcut() {}, registerTool() {} });
	const ctx = { cwd: agentDir, hasUI: true, ui: { notify: (text, kind) => notifications.push({ text, kind }) } };
	return { hooks, notifications, fire: async () => { const h = hooks.get("session_start"); if (h) await h({ type: "session_start" }, ctx); } };
};

const results = [];
const check = (cond, label) => { assert.ok(cond, "FAIL: " + label); results.push(label); };

// Case 1: unpatched package under a fake agent dir -> re-applied at load, reported on session_start.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
try {
	pristineCopy(path.join(fixture, "npm/node_modules"));
	const bundle = path.join(fixture, "npm/node_modules/pi-advisor-flow/dist/index.js");
	fs.mkdirSync(path.join(fixture, "patches"), { recursive: true });
	fs.copyFileSync(path.join(root, "patches/advisor-session-header.mjs"), path.join(fixture, "patches/advisor-session-header.mjs"));
	const before = fs.readFileSync(bundle, "utf8");
	check(!before.includes(MARKER), "fixture starts unpatched");

	process.env.PI_CODING_AGENT_DIR = fixture;
	const g = run(fixture);
	check(fs.readFileSync(bundle, "utf8").includes(MARKER), "guard re-applies the patch at extension load");
	await g.fire();
	check(g.notifications.length === 1 && g.notifications[0].kind === "info", "guard reports the re-apply once on session_start");

	// Case 2: already-patched package -> silent, and the file is untouched.
	const g2Fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard2-"));
	fs.cpSync(path.join(fixture, "npm"), path.join(g2Fixture, "npm"), { recursive: true });
	fs.cpSync(path.join(fixture, "patches"), path.join(g2Fixture, "patches"), { recursive: true });
	const g2Bundle = path.join(g2Fixture, "npm/node_modules/pi-advisor-flow/dist/index.js");
	const g2Before = fs.readFileSync(g2Bundle, "utf8");
	process.env.PI_CODING_AGENT_DIR = g2Fixture;
	const g2 = run(g2Fixture);
	check(fs.readFileSync(g2Bundle, "utf8") === g2Before, "guard leaves an already-patched bundle byte-identical");
	await g2.fire();
	check(g2.notifications.length === 0, "guard stays silent when nothing was wrong");
	fs.rmSync(g2Fixture, { recursive: true, force: true });

	// Case 3: no plugin installed at all -> no crash, no message.
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard3-"));
	process.env.PI_CODING_AGENT_DIR = empty;
	const g3 = run(empty);
	await g3.fire();
	check(g3.notifications.length === 0, "guard is a no-op without the plugin present");
	fs.rmSync(empty, { recursive: true, force: true });
	void g;
} finally {
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(fixture, { recursive: true, force: true });
}

// Case 4: the real install is patched, so the guard does nothing in a normal session.
const real = path.join(root, "npm/node_modules/pi-advisor-flow/dist/index.js");
check(fs.readFileSync(real, "utf8").includes(MARKER), "installed pi-advisor-flow carries the patch");

console.log(results.map(r => "ok   " + r).join("\n"));
console.log(`\nPassed ${results.length} patch-guard checks.`);
