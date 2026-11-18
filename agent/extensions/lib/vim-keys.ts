/**
 * Vim-style motions for the full-screen viewers (diff, subagent transcripts): counts (5j),
 * Ctrl+D/U half page, Ctrl+F/B page, Ctrl+E/Y line, gg/G and [count]G, {/} previous/next
 * section, h/l and 0 for horizontal pan. Arrow keys, PgUp/PgDn and Home/End work too.
 */
import { Key, matchesKey } from "@earendil-works/pi-tui";

export type Motion =
	| { kind: "line"; by: number }
	| { kind: "halfPage"; by: number }
	| { kind: "page"; by: number }
	| { kind: "top" }
	| { kind: "bottom" }
	| { kind: "goto"; line: number }
	| { kind: "section"; by: number }
	| { kind: "pan"; by: number }
	| { kind: "panStart" };

export function createVimKeys() {
	let count = "";
	let pendingG = false;

	/** The motion for this key, "pending" while a count or `g` prefix is being typed, or undefined. */
	function feed(data: string): Motion | "pending" | undefined {
		if (/^[1-9]$/.test(data) || count && data === "0") { count += data; pendingG = false; return "pending"; }
		const n = count ? Number(count) : 1;
		const hadCount = count !== "";
		count = "";
		if (data === "g") {
			if (pendingG) { pendingG = false; return { kind: "top" }; }
			pendingG = true;
			return "pending";
		}
		pendingG = false;
		if (data === "j" || matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("e")) || matchesKey(data, Key.ctrl("n"))) return { kind: "line", by: n };
		if (data === "k" || matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("y")) || matchesKey(data, Key.ctrl("p"))) return { kind: "line", by: -n };
		if (matchesKey(data, Key.ctrl("d"))) return { kind: "halfPage", by: n };
		if (matchesKey(data, Key.ctrl("u"))) return { kind: "halfPage", by: -n };
		if (matchesKey(data, Key.ctrl("f")) || matchesKey(data, Key.pageDown) || data === " ") return { kind: "page", by: n };
		if (matchesKey(data, Key.ctrl("b")) || matchesKey(data, Key.pageUp) || data === "b") return { kind: "page", by: -n };
		if (data === "G") return hadCount ? { kind: "goto", line: n } : { kind: "bottom" };
		if (matchesKey(data, Key.home)) return { kind: "top" };
		if (matchesKey(data, Key.end)) return { kind: "bottom" };
		if (data === "}") return { kind: "section", by: n };
		if (data === "{") return { kind: "section", by: -n };
		if (data === "l" || matchesKey(data, Key.right)) return { kind: "pan", by: 8 * n };
		if (data === "h" || matchesKey(data, Key.left)) return { kind: "pan", by: -8 * n };
		if (data === "0") return { kind: "panStart" };
		return undefined;
	}

	return { feed };
}

/**
 * New scroll offset for a motion. `room` is the visible height; `sections` are line indices of
 * section starts (hunks, transcript headings), sorted.
 */
export function applyMotion(motion: Motion, scroll: number, room: number, length: number, sections: number[] = []): number {
	const max = Math.max(0, length - room);
	const clamp = (value: number) => Math.max(0, Math.min(max, value));
	switch (motion.kind) {
		case "line": return clamp(scroll + motion.by);
		case "halfPage": return clamp(scroll + motion.by * Math.max(1, Math.floor(room / 2)));
		case "page": return clamp(scroll + motion.by * Math.max(1, room - 2));
		case "top": return 0;
		case "bottom": return max;
		case "goto": return clamp(motion.line - 1);
		case "section": {
			let target = scroll;
			for (let step = 0; step < Math.abs(motion.by); step++) {
				const next = motion.by > 0 ? sections.find(line => line > target) : [...sections].reverse().find(line => line < target);
				if (next === undefined) break;
				target = next;
			}
			return clamp(target);
		}
		default: return scroll;
	}
}

/** New selected index in a list of `length` items, `room` of them visible. */
export function applySelection(motion: Motion, selected: number, room: number, length: number): number {
	const clamp = (value: number) => Math.max(0, Math.min(length - 1, value));
	switch (motion.kind) {
		case "line": return clamp(selected + motion.by);
		case "halfPage": return clamp(selected + motion.by * Math.max(1, Math.floor(room / 2)));
		case "page": return clamp(selected + motion.by * Math.max(1, room - 1));
		case "top": return 0;
		case "bottom": return clamp(length - 1);
		case "goto": return clamp(motion.line - 1);
		default: return selected;
	}
}

/** Full-size overlay: in fullscreen mode pi scrolls the chat on PgUp/PgDn unless an overlay has focus. */
export const FULL_OVERLAY = { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } } as const;
