import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RuntimeConfig {
	timeoutSeconds: number;
	maxTurns: number;
	maxOutputTokens: number;
	updateIntervalMs: number;
	thinking: Record<string, string>;
}

export function loadRuntimeConfig(file = path.join(getAgentDir(), "agents", "runtime.json")): RuntimeConfig {
	const defaults: RuntimeConfig = { timeoutSeconds: 1200, maxTurns: 80, maxOutputTokens: 100000, updateIntervalMs: 150, thinking: { scout: "low", planner: "medium", executor: "medium", reviewer: "high", discuss: "medium" } };
	let raw;
	try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults; throw new Error(`Cannot load runtime configuration ${file}: ${error}`); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid runtime configuration ${file}`);
	const result = { ...defaults, ...raw, thinking: { ...defaults.thinking, ...raw.thinking } };
	for (const key of ["timeoutSeconds", "maxTurns", "maxOutputTokens", "updateIntervalMs"] as const) {
		if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error(`Invalid ${key} in ${file}`);
	}
	if (raw.thinking !== undefined && (!raw.thinking || typeof raw.thinking !== "object" || Array.isArray(raw.thinking))) throw new Error(`Invalid thinking in ${file}`);
	for (const level of Object.values(result.thinking)) if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level as string)) throw new Error(`Invalid thinking level in ${file}`);
	return result;
}
