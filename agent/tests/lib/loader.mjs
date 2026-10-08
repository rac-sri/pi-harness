import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = fs.readFileSync(path.join(root, "install/current-version"), "utf8").trim();
export const modules = path.join(root, "install/releases", version, "node_modules");
const require = createRequire(path.join(modules, "@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = require("jiti");
const alias = Object.fromEntries(["compat", "oauth", "providers/all"].map(name => [`@earendil-works/pi-ai/${name}`, path.join(modules, "@earendil-works/pi-ai/dist", name + ".js")]));
Object.assign(alias, Object.fromEntries(["pi-coding-agent", "pi-agent-core", "pi-tui", "pi-ai"].map(name => [`@earendil-works/${name}`, path.join(modules, "@earendil-works", name, "dist", name === "pi-ai" ? "compat.js" : "index.js")])));
alias.typebox = require.resolve("typebox");
export const jiti = createJiti(import.meta.url, { alias, fsCache: false, moduleCache: false });
