import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function install(options: { stopFails?: boolean; installFails?: boolean; alreadyStopped?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wa-install-"));
  fixtures.push(dir);
  const plugin = join(dir, "plugin");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const configPath = join(state, "openclaw.json");
  for (const path of [bin, state, join(plugin, "scripts"), join(plugin, "cli"), join(dir, "tmp")]) {
    mkdirSync(path, { recursive: true });
  }
  for (const name of ["install.sh", "manage-config.mjs"]) {
    copyFileSync(resolve("scripts", name), join(plugin, "scripts", name));
  }
  symlinkSync(resolve("node_modules"), join(plugin, "node_modules"), "dir");
  const original = `// existing operator configuration\n{
    channels: { whatsapp: { dmPolicy: 'pairing', accounts: { personal: { enabled: true } } } },
    plugins: { entries: { whatsapp: { enabled: true } } },
  }\n`;
  writeFileSync(configPath, original);
  // A failed stop must not restore an unrelated backup from an earlier install.
  writeFileSync(`${configPath}.pre-whatsapp-pro.bak`, "stale backup");
  writeFileSync(join(bin, "openclaw"), `#!/usr/bin/env bash
set -euo pipefail
printf 'openclaw %s\\n' "$*" >> "$INSTALL_TRACE"
if [ "$1 $2" = 'gateway stop' ]; then
  cp "$OPENCLAW_CONFIG_PATH" "$CONFIG_AT_STOP"
  if [ "$STOP_FAILS" = 1 ]; then echo 'owner refused stop' >&2; exit 1; fi
  if [ "$ALREADY_STOPPED" = 1 ]; then echo 'Gateway service not loaded.'; fi
  touch "$STOPPED_MARKER"
elif [ "$1 $2" = 'plugins install' ]; then
  test -f "$STOPPED_MARKER"
  if [ "$INSTALL_FAILS" = 1 ]; then echo 'plugin install failed' >&2; exit 1; fi
fi
`, { mode: 0o755 });
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash
set -euo pipefail
test -f "$STOPPED_MARKER"
printf 'npm %s %s\\n' "$(basename "$PWD")" "$*" >> "$INSTALL_TRACE"
`, { mode: 0o755 });
  // Exercise the whole installer without touching the real system CLI link.
  writeFileSync(join(bin, "ln"), `#!/usr/bin/env bash
printf 'link\\n' >> "$INSTALL_TRACE"
`, { mode: 0o755 });
  const result = spawnSync("bash", [join(plugin, "scripts", "install.sh"), "--migrate"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      TMPDIR: join(dir, "tmp"),
      INSTALL_TRACE: join(dir, "trace"),
      CONFIG_AT_STOP: join(dir, "config-at-stop"),
      STOPPED_MARKER: join(dir, "stopped"),
      STOP_FAILS: options.stopFails ? "1" : "0",
      INSTALL_FAILS: options.installFails ? "1" : "0",
      ALREADY_STOPPED: options.alreadyStopped ? "1" : "0",
    },
  });
  if (result.error) throw result.error;
  return {
    result, original,
    config: readFileSync(configPath, "utf8"),
    configAtStop: readFileSync(join(dir, "config-at-stop"), "utf8"),
    backup: readFileSync(`${configPath}.pre-whatsapp-pro.bak`, "utf8"),
    trace: readFileSync(join(dir, "trace"), "utf8").trim().split("\n"),
  };
}

describe("installer offline ownership", () => {
  it("stops the gateway before dependency changes and config migration", () => {
    const { result, original, config, configAtStop, backup, trace } = install();
    expect(result.status, result.stderr).toBe(0);
    expect(configAtStop).toBe(original);
    expect(backup).toBe(original);
    expect(trace[0]).toBe("openclaw gateway stop --force");
    expect(trace[1]).toMatch(/^npm plugin ci /);
    expect(trace[2]).toMatch(/^npm cli ci /);
    expect(trace[3]).toMatch(/^openclaw plugins install --force --accept-capabilities /);
    expect(trace[4]).toBe("link");
    const saved = JSON.parse(config);
    expect(saved.channels["whatsapp-pro"].accounts.personal.enabled).toBe(true);
    expect(saved.plugins.entries.whatsapp.enabled).toBe(false);
  });

  it("aborts without changing dependencies, config, or backups when the owner cannot stop", () => {
    const { result, original, config, backup, trace } = install({ stopFails: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("owner refused stop");
    expect(result.stderr).toContain("No dependencies or configuration were changed");
    expect(result.stderr).toContain("gateway status --deep");
    expect(config).toBe(original);
    expect(backup).toBe("stale backup");
    expect(trace).toEqual(["openclaw gateway stop --force"]);
  });

  it("continues when the native stop command confirms the gateway is already stopped", () => {
    const { result } = install({ alreadyStopped: true });
    expect(result.status, result.stderr).toBe(0);
  });

  it("still restores the original config if native plugin installation fails", () => {
    const { result, original, config, trace } = install({ installFails: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("plugin install failed");
    expect(config).toBe(original);
    expect(trace).not.toContain("link");
  });
});
