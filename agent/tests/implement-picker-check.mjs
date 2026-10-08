import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { root, jiti } from "./lib/loader.mjs";

let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-implement-picker-"));
const previous = process.env.PI_CODING_AGENT_DIR;
try {
	const repo = path.join(fixture, "repos/nightshade"), other = path.join(fixture, "repos/other");
	const mission = (project, slug, repoPath, date, rows) => {
		const dir = path.join(fixture, "plans", project, slug); fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "mission.md"), `---\nproject: ${project}\nmission: ${slug}\nrepo: ${repoPath}\ndate: ${date}\n---\n# Mission\n\n## Goals\n| # | goal | status | file |\n|---|------|--------|------|\n${rows.map(r => `| ${r.join(" | ")} |`).join("\n")}\n`);
		return dir;
	};
	const reshield = mission("nightshade", "hyperliquid-reshield", repo, "2026-10-08", [["01", "Queue and manager", "planned", "01-queue.md"], ["02", "Close handoff", "pending", "-"]]);
	const older = mission("nightshade", "fees", repo, "2026-09-01", [["01", "Fee table", "done", "01-fees.md"], ["02", "Fee audit", "executing", "02-audit.md"]]);
	mission("elsewhere", "unrelated", other, "2026-10-08", [["01", "Not this repo", "planned", "01-x.md"]]);
	fs.mkdirSync(path.join(fixture, "agent/agents"), { recursive: true });
	fs.writeFileSync(path.join(fixture, "agent/agents/planner.json"), JSON.stringify({ directory: path.join(fixture, "plans/{project}") }));
	process.env.PI_CODING_AGENT_DIR = path.join(fixture, "agent");

	const picker = await jiti.import(path.join(root, "extensions/implement-picker.ts"));
	const cwd = path.join(repo, "venue/hyperliquid_coordinator");
	const found = picker.findMissions(path.join(fixture, "plans/{project}"), cwd);
	check(found.map(m => m.slug).sort().join() === "fees,hyperliquid-reshield", "missions are matched by repo path across project folders, from a subdirectory");
	const goals = picker.runnableGoals(found);
	check(goals.map(g => `${g.mission}/${g.number}`).join() === "fees/02,hyperliquid-reshield/01", "executing goals come before planned ones; done and pending are excluded");
	check(goals[1].file === path.join(reshield, "01-queue.md") && goals[0].file === path.join(older, "02-audit.md"), "goal files resolve inside their mission folder");

	let handler; picker.default({ on: (name, fn) => { if (name === "input") handler = fn; } });
	let shown, notified;
	const ctx = (pick, typed) => ({ cwd, hasUI: true, mode: "tui", ui: { notify: message => { notified = message; }, input: async () => typed,
		custom: async factory => { shown = factory({ requestRender() {} }, { fg: (_c, t) => t, bold: t => t }, {}, () => {}).render(100).join("\n"); return pick; } } });
	const run = (text, pick, typed, source = "interactive") => handler({ text, source }, ctx(pick, typed));

	const chosen = await run("/implement", { indices: [0], other: false });
	check(chosen.action === "transform" && chosen.text === `/implement ${path.join(older, "02-audit.md")}`, "bare /implement rewrites to the chosen goal file");
	check(shown.includes("02 Fee audit (next)") && shown.includes("02 Close handoff · pending") && !shown.includes("Not this repo"), "picker shows the next goal first and the full goal list as context");
	check((await run("/implement hyperliquid-reshield", { indices: [0], other: false })).text.endsWith("01-queue.md"), "/implement <mission> limits the list to that mission");
	check((await run("/implement fix the retry bug", null)).action === "continue", "a free-text request passes through to the template");
	check((await run("/implement typo", null)).action === "continue", "a one-word request that isn't a mission passes through");
	check((await run("/implement", null, undefined, "extension")).action === "continue", "extension-sent input is left alone");
	check((await run("/implement", null)).action === "handled", "cancelling the picker sends nothing");
	const typed = await run("/implement", { indices: [], other: true }, "add a status route");
	check(typed.text === "/implement add a status route", "type-your-own becomes a normal implement request");
	fs.writeFileSync(path.join(fixture, "agent/agents/planner.json"), JSON.stringify({ directory: path.join(fixture, "empty/{project}") }));
	check((await run("/implement", null)).action === "handled" && notified.includes("No missions"), "no missions explains what to do instead of sending an empty request");
	console.log(`Passed ${checks} implement picker checks.`);
} finally {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
	fs.rmSync(fixture, { recursive: true, force: true });
}
