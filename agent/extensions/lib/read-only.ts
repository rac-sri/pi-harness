import { parse } from "../sandbox/node_modules/shell-quote/index.js";

const SAFE = new Set(["ls", "cat", "head", "tail", "grep", "rg", "find", "stat", "wc", "du", "pwd", "echo", "true", "date", "uname", "whoami", "basename", "dirname", "sort", "uniq", "cut", "tr", "seq", "df", "ps"]);
const GIT_SAFE = new Set(["status", "log", "diff", "show", "blame", "ls-files", "rev-parse", "describe", "cat-file"]);

function safeSegment(words: string[]): boolean {
	const [head, ...args] = words;
	if (!head) return false;
	if (head === "git") {
		if (!GIT_SAFE.has(args[0])) return false;
		// Textconv, external diffs and pagers can execute repository-controlled code.
		if (args.some(a => /^(--ext-diff|--textconv|--filters|--output|--config|--exec-path)(=|$)/.test(a))) return false;
		if (["log", "diff", "show", "blame"].includes(args[0])) {
			return args.includes("--no-ext-diff") && args.includes("--no-textconv");
		}
		return true;
	}
	if (["node", "python", "python3", "bun", "deno", "cargo", "go", "brew", "pi"].includes(head)) {
		return args.length === 1 && args[0] === "--version";
	}
	if (!SAFE.has(head)) return false;
	if (head === "find" && args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))) return false;
	if (head === "rg" && args.some(a => /^(--pre|--pre-glob)(=|$)/.test(a))) return false;
	if (head === "sort" && args.some(a => a.startsWith("-") && !/^-[bdfginrRsuhV]+$/.test(a) && a !== "--")) return false;
	// uniq's second operand is an output file. Keep only its stdin form.
	if (head === "uniq" && args.some(a => !/^-[cdu]+$/.test(a))) return false;
	if (head === "date" && args.some(a => !/^\+/.test(a) && !/^-([uR]|I.*)$/.test(a))) return false;
	return true;
}

/** Conservative shell subset: no expansions, redirects, substitutions or scripts. */
export function isReadOnlyCommand(command: string): boolean {
	if (!command.trim() || /[$`\\\n\r<>()[\]{}]/.test(command)) return false;
	try {
		const tokens = parse(command, () => { throw new Error("Shell expansion disabled"); });
		let words: string[] = [];
		for (const token of tokens) {
			if (typeof token === "string") words.push(token);
			else if (token && "op" in token && ["|", "&&", ";"].includes(token.op)) {
				if (!safeSegment(words)) return false;
				words = [];
			} else return false;
		}
		return safeSegment(words);
	} catch {
		return false;
	}
}
