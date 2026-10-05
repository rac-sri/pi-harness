#!/usr/bin/env node
// Re-applies the local pi-advisor-flow patch that forwards Pi's session id on Advisor calls.
//
// WHY. OpenCode / OpenCode Go reject any request without `x-opencode-session`
// (HTTP 400 {"type":"MissingSessionID"}). pi-ai derives that header ONLY from
// options.sessionId (pi-ai/dist/providers/opencode-headers.js -> withSessionHeader),
// and pi-advisor-flow 0.11.1 builds Advisor stream options as {reasoning, signal}
// (or {apiKey, env, headers, reasoning, signal}) — never a session id. So every
// Advisor consultation aimed at an OpenCode model fails, while the Executor's own
// requests succeed because Pi's agent loop passes sessionId (core/agent-session.js).
// The Advisor runs outside that loop, so it must supply the id itself.
//
// FIX. Thread ctx.sessionManager.getSessionId() through ResolvedConfiguredModel and
// forward it on both stream paths. Worth filing upstream: https://github.com/philipbrembeck/pi-advisor
//
// `pi update` replaces the package, so re-run this after every update:
//   node agent/patches/advisor-session-header.mjs            # the installed package
//   node agent/patches/advisor-session-header.mjs <dir>      # any package dir (used by tests)
// Then /reload or start a new session — extensions load at startup — and verify with
//   node agent/tests/advisor-session-header.mjs
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = "/Users/rachitsrivastava/.pi/agent/npm/node_modules/pi-advisor-flow";

// Exact literal anchors taken from pi-advisor-flow@0.11.1. Each must match once;
// anything else means upstream changed the shape and this script needs review.
const EDITS = {
  "dist/index.js": [
    ["  const { streamSimple } = ctx.modelRegistry;\n  if (streamSimple) {\n    return {\n      model,\n      ref,\n      streamSimple: streamSimple.bind(ctx.modelRegistry)\n    };\n  }\n",
     "  const { streamSimple } = ctx.modelRegistry;\n  const sessionId = ctx.sessionManager?.getSessionId?.();\n  if (streamSimple) {\n    return {\n      model,\n      ref,\n      sessionId,\n      streamSimple: streamSimple.bind(ctx.modelRegistry)\n    };\n  }\n"],
    ["    headers: auth.headers,\n    model,\n    ref\n  };\n};\n",
     "    headers: auth.headers,\n    model,\n    ref,\n    sessionId\n  };\n};\n"],
    ["      reasoning: toSimpleReasoning(options.reasoning),\n      signal: options.signal\n    });\n",
     "      reasoning: toSimpleReasoning(options.reasoning),\n      sessionId: resolved.sessionId,\n      signal: options.signal\n    });\n"],
    ["    headers: resolved.headers,\n    reasoning: options.reasoning,\n    signal: options.signal\n  };\n",
     "    headers: resolved.headers,\n    reasoning: options.reasoning,\n    sessionId: resolved.sessionId,\n    signal: options.signal\n  };\n"],
  ],
  "src/model-stream.ts": [
    ["  model: Model<Api>;\n  ref: string;\n  streamSimple?: (",
     "  model: Model<Api>;\n  ref: string;\n  /** Pi's conversation id, forwarded so session-aware providers can route the request. */\n  sessionId?: string;\n  streamSimple?: ("],
    ["  const { streamSimple } = ctx.modelRegistry;\n  if (streamSimple) {\n    return {\n      model,\n      ref,\n      streamSimple: streamSimple.bind(ctx.modelRegistry),\n    };\n  }\n",
     "  const { streamSimple } = ctx.modelRegistry;\n  const sessionId = ctx.sessionManager?.getSessionId?.();\n  if (streamSimple) {\n    return {\n      model,\n      ref,\n      sessionId,\n      streamSimple: streamSimple.bind(ctx.modelRegistry),\n    };\n  }\n"],
    ["    headers: auth.headers,\n    model,\n    ref,\n  };\n};\n",
     "    headers: auth.headers,\n    model,\n    ref,\n    sessionId,\n  };\n};\n"],
    ["      reasoning: toSimpleReasoning(options.reasoning),\n      signal: options.signal,\n    });\n",
     "      reasoning: toSimpleReasoning(options.reasoning),\n      sessionId: resolved.sessionId,\n      signal: options.signal,\n    });\n"],
    ["    headers: resolved.headers,\n    reasoning: options.reasoning,\n    signal: options.signal,\n  };\n",
     "    headers: resolved.headers,\n    reasoning: options.reasoning,\n    sessionId: resolved.sessionId,\n    signal: options.signal,\n  };\n"],
  ],
};

const MARKER = "sessionId: resolved.sessionId";
const root = process.argv[2] ?? DEFAULT_ROOT;
if (!fs.existsSync(path.join(root, "package.json"))) { console.error(`not a pi-advisor-flow package: ${root}`); process.exit(1); }

let patched = 0;
for (const [name, edits] of Object.entries(EDITS)) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) { console.error(`missing ${file}`); process.exit(1); }
  let text = fs.readFileSync(file, "utf8");
  if (text.includes(MARKER)) { console.log(`already patched: ${name}`); continue; }
  for (const [find, replace] of edits) {
    const count = text.split(find).length - 1;
    if (count !== 1) {
      console.error(`UPSTREAM CHANGED: expected exactly 1 match in ${name} for\n  ${find.trim().split("\n")[0]}\nfound ${count}. Update this script against the new source.`);
      process.exit(1);
    }
    text = text.replace(find, replace);
  }
  fs.writeFileSync(file, text);
  patched++;
  console.log(`patched: ${name}`);
}
console.log(patched
  ? `\n${patched} file(s) patched. Run /reload (or a new session), then: node agent/tests/advisor-session-header.mjs`
  : "\nNothing to do. Verify with: node agent/tests/advisor-session-header.mjs");
