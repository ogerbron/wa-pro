import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ make: vi.fn(), save: vi.fn(async () => {}) }));
vi.mock("baileys", () => ({
  fetchLatestBaileysVersion: async () => ({ version: [2, 0, 0] }),
  makeCacheableSignalKeyStore: (keys: unknown) => keys,
  makeWASocket: mocks.make,
  useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: mocks.save }),
}));

describe("standalone setup", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it("reconnects after pairing's restart-required close and finishes credential persistence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-setup-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", join(dir, "openclaw.json"));
    vi.resetModules();
    const close = vi.fn();
    let calls = 0;
    mocks.make.mockImplementation(() => {
      const ev = new EventEmitter();
      const attempt = ++calls;
      queueMicrotask(() => {
        if (attempt === 1) {
          ev.emit("connection.update", { qr: "test-qr" });
          ev.emit("creds.update", {});
          ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
        } else ev.emit("connection.update", { connection: "open" });
      });
      return { ev, ws: { close } };
    });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const { default: Setup } = await import("../cli/src/commands/setup.js");
      await Setup.prototype.run.call({ parse: async () => ({ args: { account: "test" }, flags: { format: "json", timeout: 1, force: false } }) } as never);
      expect(calls).toBe(2);
      expect(mocks.save).toHaveBeenCalled();
      expect(output.mock.calls.map(call => call[0]).join("")).toContain('"status": "connected"');
      expect(close).toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
