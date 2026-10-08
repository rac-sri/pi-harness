import os from "node:os";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Keep the native read operation; only replace its terminal presentation. */
export default function compactRead(pi: ExtensionAPI) {
	const read = createReadToolDefinition(process.cwd());
	pi.registerTool({
		...read,
		// The default tool shell paints successful reads green, like mutations.
		renderShell: "self",
		renderCall(args, theme) {
			const home = os.homedir();
			const rawPath = args.path || "…";
			const filePath = rawPath.startsWith(home + "/") ? "~" + rawPath.slice(home.length) : rawPath;
			const start = args.offset ?? 1;
			const range = args.offset !== undefined || args.limit !== undefined
				? `:${start}${args.limit !== undefined ? `–${start + args.limit - 1}` : ""}` : "";
			return new Text(theme.fg("muted", `READ ${filePath}`) + theme.fg("dim", range), 0, 0);
		},
		renderResult(result, { isPartial }, theme, context) {
			if (context.isError) {
				const message = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
				return new Text(theme.fg("error", `Read failed: ${message.split("\n")[0].slice(0, 240) || "unknown error"}`), 0, 0);
			}
			if (isPartial) return new Text(theme.fg("dim", "Reading…"), 0, 0);
			if (result.content.some(block => block.type === "image")) return new Text(theme.fg("dim", "Image read"), 0, 0);
			const truncation = result.details?.truncation;
			if (truncation?.firstLineExceedsLimit) return new Text(theme.fg("muted", "Read limited: first line exceeds the size limit"), 0, 0);
			const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			const contents = text.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, "");
			const lines = truncation?.outputLines ?? (contents ? contents.split("\n").length : 0);
			const limited = truncation?.truncated || contents !== text;
			return new Text(theme.fg("dim", `${lines} ${lines === 1 ? "line" : "lines"} read${limited ? " · more available" : ""} · contents hidden`), 0, 0);
		},
	});
}
