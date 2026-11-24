import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { transform } from "esbuild";

const require = createRequire(import.meta.url);
const hostRoot = dirname(dirname(dirname(require.resolve("openclaw/plugin-sdk/core"))));
const host = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.11.3", "Run compatibility checks against OpenClaw 2026.11.3");
const imports = new Map<string, Set<string>>();
async function scan(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (["node_modules", ".git", "test-plugin"].includes(entry.name)) continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) { await scan(file); continue; }
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
    const source = await readFile(file, "utf8");
    await transform(source, { loader: "ts", target: "node22", format: "esm", sourcefile: file });
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      const specifier = node.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith("openclaw/")) continue;
      const clause = ts.isImportDeclaration(node) ? node.importClause : node;
      if (clause?.isTypeOnly) continue;
      const names = imports.get(specifier.text) ?? new Set<string>();
      imports.set(specifier.text, names);
      if (ts.isImportDeclaration(node) && node.importClause?.name) names.add("default");
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
        for (const item of bindings.elements) {
          if (!item.isTypeOnly) names.add((item.propertyName ?? item.name).text);
        }
      }
    }
  }
}
await scan(".");
for (const [specifier, names] of imports) {
  const module = await import(specifier);
  for (const name of names) assert(name in module, `${specifier} no longer exports ${name}`);
}
const { WhatsAppChannelConfigSchema } = await import("../src/config-schema.js");
const manifest = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
assert.deepEqual(manifest.channelConfigs["whatsapp-pro"].schema, WhatsAppChannelConfigSchema.schema,
  "Manifest schema must match the runtime channel schema");
await import("../index.js");
await import("../setup-entry.js");
console.log(`OpenClaw ${host.version}: ${imports.size} SDK modules and all TypeScript syntax verified`);
