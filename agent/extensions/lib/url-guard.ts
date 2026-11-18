/**
 * Rules for URLs the model asks a web tool to fetch. Web tools run in the main pi process,
 * outside the bash sandbox and its domain allowlist, so this is their only check.
 *
 * Rule-based, per the harness-adapters guard design (HF, 2026): the same call always gets
 * the same verdict, patterns are specific, and only agent-authored arguments are scanned,
 * never tool output. A URL carrying a known credential format is blocked.
 *
 * Not a rule here: requiring the host to appear in the user's messages or tool output.
 * Replaying the saved sessions (scripts/guard-replay.mjs) showed it blocking legitimate
 * block-explorer and API lookups whose hosts the model already knew, and nothing else.
 */

const SECRET_FORMATS: [string, RegExp][] = [
	["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
	["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
	["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
	["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
	["Stripe key", /\b[rs]k_live_[A-Za-z0-9]{20,}/],
	["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
	["private key", /-----BEGIN[ A-Z]*PRIVATE KEY-----/],
	["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/** The credential format found in `text` (URL-decoded too), if any. */
export function secretIn(text: string): string | undefined {
	let decoded = text;
	try { decoded = decodeURIComponent(text); } catch { /* keep raw */ }
	for (const [label, pattern] of SECRET_FORMATS) if (pattern.test(text) || pattern.test(decoded)) return label;
}

/** URL arguments of a tool call (`url`, `urls`). Search queries are not URLs and are not checked. */
export function urlArguments(input: Record<string, unknown>): string[] {
	const urls: string[] = [];
	if (typeof input.url === "string") urls.push(input.url);
	if (Array.isArray(input.urls)) urls.push(...input.urls.filter((value): value is string => typeof value === "string"));
	return urls;
}

/** Why fetching `url` should be blocked, or undefined to allow it. */
export function urlVerdict(url: string): string | undefined {
	const secret = secretIn(url);
	if (secret) return `The URL contains what looks like a ${secret}. Sending credentials to a web host is blocked; remove it from the URL.`;
}
