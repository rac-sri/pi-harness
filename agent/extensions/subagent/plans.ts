import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { VAULT_ROOT } from "../creds-guard.ts";

/** Reload on each dispatch; {project} is expanded by the planner from its task. */
export function loadPlanDirectory(cwd: string, filePath = path.join(getAgentDir(), "agents", "planner.json")): string {
	let directory = path.join(VAULT_ROOT, "Agents", "{project}");
	try {
		const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.directory !== "string" || !config.directory.trim() || /[\r\n\x00]/.test(config.directory)) {
			throw new Error("directory must be a nonempty, single-line path");
		}
		directory = config.directory.trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot load plan configuration ${filePath}: ${error}`);
	}
	const expanded = directory === "~" ? os.homedir() : directory.startsWith("~/") ? path.join(os.homedir(), directory.slice(2)) : directory;
	return path.resolve(cwd, expanded);
}

export function plannerPrompt(prompt: string, cwd: string, filePath?: string): string {
	const directory = loadPlanDirectory(cwd, filePath);
	return `${prompt}\n\n## Configured plan storage\n\nPlan directory: ${JSON.stringify(directory)}\nReplace every {project} in this directory with the kebab-case Project from the task (or the working directory name if absent). This is the authoritative plan root for mission folders and goal files, even if the task mentions another location. Store <mission-slug>/mission.md and <mission-slug>/<NN>-<goal-slug>.md inside it. Use the same date rules and local fallback defined above.\n`;
}
