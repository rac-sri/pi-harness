/**
 * url-guard: checks every URL a tool is asked to fetch (fetch_content, source_check, …)
 * before the call runs. See extensions/lib/url-guard.ts for the rules. A block returns its
 * reason to the model so it can take another route.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { urlArguments, urlVerdict } from "./lib/url-guard.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async event => {
		for (const url of urlArguments((event.input ?? {}) as Record<string, unknown>)) {
			const reason = urlVerdict(url);
			if (reason) return { block: true, reason: `Blocked by url-guard: ${reason}` };
		}
	});
}
