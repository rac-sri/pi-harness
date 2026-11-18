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

const LIMITS = ["timeoutSeconds", "maxTurns", "maxOutputTokens"] as const;
type Limits = Partial<Pick<RuntimeConfig, typeof LIMITS[number]>>;

/**
 * Global limits, then `roles.<agent>`, then `models.<provider/model>` (thinking suffix ignored).
 * Harness components should be chosen per model (Fan et al. 2026): run lengths that suit one
 * model starve or overpay another, so a model entry wins over its role's.
 */
export function loadRuntimeConfig(file = path.join(getAgentDir(), "agents", "runtime.json"), scope: { role?: string; model?: string } = {}): RuntimeConfig {
	const defaults: RuntimeConfig = { timeoutSeconds: 1200, maxTurns: 80, maxOutputTokens: 100000, updateIntervalMs: 150, thinking: { scout: "low", planner: "medium", executor: "medium", reviewer: "high", discuss: "medium" } };
	let raw;
	try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults; throw new Error(`Cannot load runtime configuration ${file}: ${error}`); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid runtime configuration ${file}`);
	for (const group of ["roles", "models"] as const) {
		const entries = raw[group];
		if (entries === undefined) continue;
		if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error(`Invalid ${group} in ${file}`);
		for (const [name, limits] of Object.entries(entries)) {
			if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new Error(`Invalid ${group}.${name} in ${file}`);
			for (const [key, value] of Object.entries(limits)) {
				if (!(LIMITS as readonly string[]).includes(key)) throw new Error(`Unknown limit ${group}.${name}.${key} in ${file}`);
				if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid ${group}.${name}.${key} in ${file}`);
			}
		}
	}
	const model = scope.model?.replace(/:(off|minimal|low|medium|high|xhigh)$/, "");
	const roleLimits: Limits = (scope.role && raw.roles?.[scope.role]) || {};
	const modelLimits: Limits = (model && raw.models?.[model]) || {};
	const { roles: _roles, models: _models, ...globals } = raw;
	const result = { ...defaults, ...globals, ...roleLimits, ...modelLimits, thinking: { ...defaults.thinking, ...raw.thinking } };
	for (const key of ["timeoutSeconds", "maxTurns", "maxOutputTokens", "updateIntervalMs"] as const) {
		if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error(`Invalid ${key} in ${file}`);
	}
	if (raw.thinking !== undefined && (!raw.thinking || typeof raw.thinking !== "object" || Array.isArray(raw.thinking))) throw new Error(`Invalid thinking in ${file}`);
	for (const level of Object.values(result.thinking)) if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level as string)) throw new Error(`Invalid thinking level in ${file}`);
	return result;
}
