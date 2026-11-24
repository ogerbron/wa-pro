import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));

describe("compiled plugin package", () => {
  it("declares built runtime and setup entries and a build tool available to the production installer", () => {
    expect(manifest.openclaw.runtimeExtensions).toEqual(["./dist/index.js"]);
    expect(manifest.openclaw.runtimeSetupEntry).toBe("./dist/setup-entry.js");
    expect(manifest.scripts.prepack).toBe("npm run build");
    expect(manifest.dependencies.esbuild).toBeDefined();
  });

  it("packs JavaScript entries and lazy chunks that load without TypeScript source or a loader", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-package-"));
    try {
      execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "pipe" });
      const report = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], { encoding: "utf8" }));
      const packed = Array.isArray(report) ? report[0] : report[manifest.name];
      expect(packed).toBeDefined();
      const files = packed.files.map((file: { path: string }) => file.path);
      expect(files).toContain("dist/index.js");
      expect(files).toContain("dist/setup-entry.js");
      expect(files).toContain("openclaw.plugin.json");
      expect(files).toContain("skills/wa-pro/SKILL.md");
      expect(files.some((file: string) => file.startsWith("test/"))).toBe(false);
      expect(files.some((file: string) => file.includes("node_modules/"))).toBe(false);
      execFileSync("tar", ["-xzf", join(dir, packed.filename), "-C", dir]);
      const root = join(dir, "package");
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
      // Compiled code must not rely on source checkout fallback.
      rmSync(join(root, "src"), { recursive: true, force: true });
      rmSync(join(root, "index.ts"));
      rmSync(join(root, "setup-entry.ts"));
      execFileSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { readdir } from 'node:fs/promises';
        import { pathToFileURL } from 'node:url';
        import { join } from 'node:path';
        const root = process.argv[1];
        const runtime = await import(pathToFileURL(join(root, 'dist/index.js')));
        const setup = await import(pathToFileURL(join(root, 'dist/setup-entry.js')));
        assert.equal(runtime.default.id, 'whatsapp-pro');
        assert.equal(setup.whatsappSetupPlugin.id, 'whatsapp-pro');
        for (const file of await readdir(join(root, 'dist'))) {
          if (file.endsWith('.js')) await import(pathToFileURL(join(root, 'dist', file)));
        }
      `, root], { stdio: "pipe" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
