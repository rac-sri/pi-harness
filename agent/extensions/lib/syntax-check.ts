/**
 * Fast, parse-only syntax check run after an executor edit, so a broken edit shows up
 * in the edit's own result instead of a later test run (Fan et al. 2026 keep this
 * fixed in every configuration). Never blocks or undoes an edit.
 *
 * Each checker reads the file content on stdin from a temporary cwd: it can't follow
 * `mod`/import declarations, run build scripts or pick up project config. Missing
 * tools, timeouts and unknown extensions are silent. TypeScript and JavaScript use
 * Node's own parser; only real syntax errors are reported, not "unsupported in
 * strip-only mode" ones such as enums.
 */
import { spawn } from "node:child_process";
import * as module from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const TIMEOUT_MS = 5000;
const MAX_LINES = 15;

type Checker = { label: string; command: string; args: string[] };
const PYTHON = "import ast, sys\ntry: ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n    print(f'<stdin>:{e.lineno}:{e.offset}: {e.msg}', file=sys.stderr); sys.exit(1)";
const CHECKERS: Record<string, Checker> = {
	".rs": { label: "rustfmt", command: "rustfmt", args: ["--edition", "2021", "--emit", "stdout"] },
	".go": { label: "gofmt", command: "gofmt", args: ["-e"] },
	".py": { label: "python ast", command: "python3", args: ["-I", "-c", PYTHON] },
};
const NODE = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
type Strip = (code: string) => string;

function clip(text: string, display: string): string {
	const lines = text.replace(/<stdin>|<standard input>/g, display).trim().split("\n");
	return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`].join("\n") : lines.join("\n");
}

function run(checker: Checker, text: string): Promise<{ code: number | null; output: string } | undefined> {
	return new Promise(resolve => {
		let output = "", done = false;
		const finish = (value?: { code: number | null; output: string }) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
		const child = spawn(checker.command, checker.args, { cwd: os.tmpdir(), stdio: ["pipe", "ignore", "pipe"] });
		const timer = setTimeout(() => { child.kill("SIGKILL"); finish(); }, TIMEOUT_MS);
		child.on("error", () => finish());
		child.stderr.on("data", chunk => { if (output.length < 16384) output += chunk; });
		child.stdin.on("error", () => {});
		child.on("close", code => finish({ code, output }));
		child.stdin.end(text);
	});
}

/** The syntax errors in `text`, labelled with `display`, or undefined if it parses or can't be checked. */
export async function syntaxErrors(file: string, text: string, display = file): Promise<{ checker: string; message: string } | undefined> {
	const ext = path.extname(file).toLowerCase();
	if (NODE.has(ext)) {
		const strip = (module as unknown as { stripTypeScriptTypes?: Strip }).stripTypeScriptTypes;
		if (!strip) return undefined;
		// Node warns once that the parser is experimental; keep that out of the child's stderr.
		const emitWarning = process.emitWarning;
		process.emitWarning = () => {};
		try { strip(text); return undefined; }
		catch (error) {
			const { code, message } = error as { code?: string; message?: string };
			return code === "ERR_INVALID_TYPESCRIPT_SYNTAX" ? { checker: "node parser", message: clip(String(message), display) } : undefined;
		} finally { process.emitWarning = emitWarning; }
	}
	const checker = CHECKERS[ext];
	if (!checker) return undefined;
	const result = await run(checker, text);
	if (!result || result.code === 0 || !result.output.trim()) return undefined;
	return { checker: checker.label, message: clip(result.output, display) };
}

export function syntaxNote(found: { checker: string; message: string }): string {
	return `\n\nSyntax check (${found.checker}) failed after this edit. The edit was applied; fix it before running checks:\n${found.message}`;
}
