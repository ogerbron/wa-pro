import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ["index.ts", "setup-entry.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
});
