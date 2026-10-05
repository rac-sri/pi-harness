/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	noContext?: boolean;
	scratch?: boolean;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Single per-agent model config: ~/.pi/agent/agents/models.json
 *
 * {
 *   "default": "opencode-go/glm-5.3",
 *   "planner": "opencode-go/glm-5.3:high",
 *   "executor": "opencode-go/deepseek-v4-pro",
 *   "discuss": null
 * }
 *
 * Value is a provider/model string, optionally with ":<thinking>".
 * null/omitted agent entries use the JSON default. Frontmatter/session models
 * do not override this file. Missing or invalid configuration is an error.
 */
export function loadModelOverrides(filePath = path.join(getAgentDir(), "agents", "models.json")): Record<string, string | null> {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		throw new Error(`Cannot load model configuration ${filePath}: ${error}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`Invalid model configuration: ${filePath}`);
	const overrides: Record<string, string | null> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key.startsWith("_")) continue; // _comment, _doc, etc.
		if (value === null) {
			overrides[key] = null;
		} else if (typeof value === "string" && value.trim()) {
			overrides[key] = value.trim();
		} else throw new Error(`Invalid model entry "${key}" in ${filePath}`);
	}
	if (typeof overrides.default !== "string" || !overrides.default.includes("/")) throw new Error(`Model configuration requires a provider/model default: ${filePath}`);
	return overrides;
}

export function configuredModel(overrides: Record<string, string | null>, agent: string): string {
	const model = overrides[agent] ?? overrides.default;
	if (!model || !/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error(`Invalid configured model for ${agent}`);
	return model;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	noContext?: unknown;
	scratch?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
export function parseToolList(value: unknown): string[] | undefined {
	// Explicit "no tools at all": `tools: []` or `tools: none`.
	// Distinguished from omitting `tools:` (inherit default tools).
	if (Array.isArray(value) && value.length === 0) return [];
	if (typeof value === "string" && /^\s*none\s*$/i.test(value)) return [];
	if (Array.isArray(value) && value.some(t => typeof t !== "string" || !t.trim())) return [];
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : value === undefined ? undefined : [];
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			noContext: frontmatter.noContext === true || frontmatter.noContext === "true",
			scratch: frontmatter.scratch === true || frontmatter.scratch === "true",
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	const resolved = Array.from(agentMap.values());

	// JSON is authoritative; null/omitted role entries use its default.
	const overrides = loadModelOverrides();
	for (const agent of resolved) {
		agent.model = configuredModel(overrides, agent.name);
	}

	return { agents: resolved, projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
