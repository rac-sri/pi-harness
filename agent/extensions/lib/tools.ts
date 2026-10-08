/**
 * Tools that change files in place. The credential guard, the writer lock and
 * completion invalidation all read this set, so a new editing tool is added once.
 * lsp_navigation is included because rename and code actions can write.
 */
export const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "hashline_edit", "ast_grep_replace", "lsp_navigation"]);
