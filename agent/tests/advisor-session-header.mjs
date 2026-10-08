// Verifies the local pi-advisor-flow patch that forwards Pi's session id on Advisor
// requests. OpenCode (and OpenCode Go) reject requests without `x-opencode-session`
// (HTTP 400 MissingSessionID), and pi-ai only derives that header from options.sessionId:
// pi-ai/dist/providers/opencode-headers.js -> withSessionHeader().
// Run: node agent/tests/advisor-session-header.mjs   (safe inside the bash sandbox)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { root, modules, jiti } from "./lib/loader.mjs";

const SESSION = "01a10d82-4e47-70c4-842f-d41ffbd4c146";
const MODEL = { id: "kimi-k3", provider: "opencode-go", api: "openai-completions", name: "Kimi K3" };
const checks = [];
const check = (cond, label) => { assert.ok(cond, "FAIL: " + label); checks.push(label); };

// An AssistantMessageEventStream stand-in: async-iterable with result().
const fakeStream = () => {
  const done = { role: "assistant", stopReason: "stop", provider: MODEL.provider, model: MODEL.id, content: [{ type: "text", text: "OK" }], usage: {} };
  return {
    async *[Symbol.asyncIterator]() { yield { type: "text_delta", contentIndex: 0, delta: "OK", partial: done }; },
    result: async () => done,
  };
};

const ctxWithRegistry = (captured, useGetAuth) => ({
  sessionManager: { getSessionId: () => SESSION },
  modelRegistry: {
    find: (provider, id) => (provider === MODEL.provider && id === MODEL.id ? MODEL : undefined),
    ...(useGetAuth ? {} : { streamSimple: (model, context, options) => { captured.options = options; return fakeStream(); } }),
    ...(useGetAuth ? { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: undefined, env: undefined }) } : {}),
  },
});

const streamOptions = { messages: [], systemPrompt: "test" };

// 1. Registry streamSimple path (what pi-advisor-flow uses when Pi exposes it).
{
  const { collectTextStream, resolveConfiguredModel } = await jiti.import(path.join(root, "npm/node_modules/pi-advisor-flow/src/model-stream.ts"));
  const captured = {};
  const resolved = await resolveConfiguredModel(ctxWithRegistry(captured, false), "opencode-go/kimi-k3", "Advisor");
  check(resolved.sessionId === SESSION, "resolveConfiguredModel attaches the session id (registry path)");
  await collectTextStream(resolved, streamOptions);
  check(captured.options?.sessionId === SESSION, "streamSimple receives options.sessionId");

  // 2. getApiKeyAndHeaders fallback path: pi-ai's plain stream() must also get it.
  const viaAuth = {};
  const resolved2 = await resolveConfiguredModel(ctxWithRegistry(viaAuth, true), "opencode-go/kimi-k3", "Advisor");
  check(resolved2.sessionId === SESSION, "resolveConfiguredModel attaches the session id (auth-header path)");
  await collectTextStream(resolved2, streamOptions, (model, context, options) => { viaAuth.options = options; return fakeStream(); });
  check(viaAuth.options?.sessionId === SESSION, "stream() receives options.sessionId");
}

// 3. Pi derives the provider header from that option — this is the header OpenCode Go demands.
const { withOpenCodeSessionHeader } = await jiti.import(path.join(modules, "@earendil-works/pi-ai/dist/providers/opencode-headers.js"));
for (const [label, options, expected] of [
  ["advisor request now carries the header", { sessionId: SESSION }, SESSION],
  ["unpatched request has no header", {}, undefined],
]) {
  let seen;
  const wrapped = withOpenCodeSessionHeader({ stream: (m, c, o) => { seen = o; return fakeStream(); }, streamSimple: (m, c, o) => { seen = o; return fakeStream(); } });
  await wrapped.streamSimple(MODEL, { messages: [], systemPrompt: "x" }, options).result();
  const header = Object.entries(seen?.headers ?? {}).find(([k]) => k.toLowerCase() === "x-opencode-session")?.[1];
  check(header === expected, `${label} (${header === undefined ? "no header" : header})`);
}

// 4. The file Pi actually loads (package.json "pi": {"extensions": ["./dist/index.js"]})
//    is patched too, and still loads as an extension.
const dist = fs.readFileSync(path.join(root, "npm/node_modules/pi-advisor-flow/dist/index.js"), "utf8");
check(/sessionId: resolved\.sessionId/.test(dist) && /const sessionId = ctx\.sessionManager\?\.getSessionId\?\.\(\)/.test(dist), "dist/index.js (the loaded bundle) contains the same fix");
const loader = await import(path.join(modules, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
const loaded = await loader.loadExtensions([path.join(root, "npm/node_modules/pi-advisor-flow/dist/index.js")], root);
assert.deepEqual(loaded.errors, []);
checks.push(`patched bundle loads cleanly (${loaded.extensions?.length ?? 1} extension)`);

console.log(checks.map(c => "ok   " + c).join("\n"));
console.log(`\nPassed ${checks.length} advisor session-header checks.`);
