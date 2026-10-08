/**
 * Bare `/implement` (or `/implement <mission>`) opens a picker of this repo's
 * planned goals, next goal first, then rewrites the input to
 * `/implement <goal file>` so the prompt template runs unchanged.
 * `/implement <request>` passes through untouched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPlanDirectory } from "./subagent/plans.ts";
import { createPicker, type PickResult } from "./question.ts";

export interface Goal { mission: string; number: string; name: string; status: string; file?: string }
export interface Mission { slug: string; repo?: string; date?: string; goals: Goal[] }

const RUNNABLE = ["executing", "planned"];

function subdirectories(dir: string): string[] {
	try { return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name)); }
	catch { return []; }
}

/** Parse a mission index: frontmatter plus the `| NN | goal | status | file |` table. */
export function readMission(dir: string): Mission | undefined {
	let text: string;
	try { text = fs.readFileSync(path.join(dir, "mission.md"), "utf8"); } catch { return undefined; }
	const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1].trim();
	const slug = field("mission") ?? path.basename(dir);
	const goals: Goal[] = [];
	for (const line of text.split("\n")) {
		const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
		if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue;
		goals.push({ mission: slug, number: cells[0], name: cells[1], status: cells[2], file: cells[3] && cells[3] !== "-" ? path.join(dir, cells[3]) : undefined });
	}
	return { slug, repo: field("repo"), date: field("date"), goals };
}

const inside = (child: string, parent: string) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };

/** Missions under the plan root whose repo contains cwd (or sits inside it). `{project}` matches any project folder. */
export function findMissions(planRoot: string, cwd: string): Mission[] {
	const [before, after = ""] = planRoot.split("{project}");
	const roots = planRoot.includes("{project}") ? subdirectories(before).map(project => path.join(project, after)) : [planRoot];
	return roots.flatMap(subdirectories).map(readMission)
		.filter((mission): mission is Mission => !!mission?.repo && (inside(cwd, mission.repo) || inside(mission.repo, cwd)));
}

/** Runnable goals: executing before planned, newest mission first, then goal order. */
export function runnableGoals(missions: Mission[]): Goal[] {
	const byDate = [...missions].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
	const goals = byDate.flatMap(mission => mission.goals.filter(goal => goal.file && RUNNABLE.includes(goal.status)));
	return goals.sort((a, b) => RUNNABLE.indexOf(a.status) - RUNNABLE.indexOf(b.status));
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		const match = /^\/implement(?:\s+([a-z0-9][a-z0-9-]*))?\s*$/.exec(event.text.trim());
		if (event.source === "extension" || !match || !ctx.hasUI || ctx.mode !== "tui") return { action: "continue" };
		let missions: Mission[];
		try { missions = findMissions(loadPlanDirectory(ctx.cwd), ctx.cwd); }
		catch (error) { ctx.ui.notify(String(error), "error"); return { action: "handled" }; }
		if (match[1]) {
			missions = missions.filter(mission => mission.slug === match[1]);
			// A one-word request that isn't a mission goes to the template as a normal request.
			if (!missions.length) return { action: "continue" };
		}
		const goals = runnableGoals(missions);
		if (!goals.length) {
			ctx.ui.notify(missions.length ? "No planned goals yet. Run /plan to plan the next one." : "No missions for this repo. Use /plan, or /implement <request>.", "warning");
			return { action: "handled" };
		}
		const context = missions.map(mission => `# ${mission.slug}\n${mission.goals.map(goal => `${goal.number} ${goal.name} · ${goal.status}`).join("\n")}`).join("\n");
		const options = goals.map((goal, i) => ({ label: `${goal.number} ${goal.name}${i === 0 ? " (next)" : ""}`, description: `${goal.mission} · ${goal.status}` }));
		const result = await ctx.ui.custom<PickResult>((tui, theme, _keys, done) => createPicker("Which goal do you want to implement?", options, false, theme, done, () => tui.requestRender(), context));
		if (!result) return { action: "handled" };
		if (result.other) {
			const request = (await ctx.ui.input("What should be implemented?", "Describe the change"))?.trim();
			return request ? { action: "transform", text: `/implement ${request}` } : { action: "handled" };
		}
		return { action: "transform", text: `/implement ${goals[result.indices[0]].file}` };
	});
}
