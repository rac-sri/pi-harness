/** The installed shell-quote package does not ship TypeScript declarations. */
declare module "*shell-quote/index.js" {
	export function parse(command: string, env?: (...args: unknown[]) => unknown): Array<string | { op: string; pattern?: string } | { comment: string }>;
}
