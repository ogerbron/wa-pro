import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObserverDB } from "../src/observer/db.js";
import { closeObserver } from "../src/observer/state.js";
import { WhatsAppProConfigSchema } from "../src/channel-config.js";
import { startObserverMonitor } from "../src/observer/monitor.js";
import { resolveWhatsAppAccount } from "../src/accounts.js";
import entry, { whatsappPlugin } from "../index.js";

vi.mock("../src/observer/monitor.js", async (original) => ({
  ...await original<typeof import("../src/observer/monitor.js")>(),
  startObserverMonitor: vi.fn(async () => {}),
}));

const dirs: string[] = [];
afterEach(async () => { await closeObserver(); vi.restoreAllMocks(); vi.clearAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function register() {
  const dir = mkdtempSync(join(tmpdir(), "wa-plugin-")); dirs.push(dir);
  const config = { channels: { "whatsapp-pro": { observer: { accounts: ["passive"], dbPath: join(dir, "messages.db"), mediaPath: join(dir, "media") } } } };
  const api = {
    runtime: {}, config, resolvePath: (path: string) => path,
    registerChannel: vi.fn(), registerTool: vi.fn(), registerService: vi.fn(), on: vi.fn(), registerGatewayMethod: vi.fn(),
  };
  entry.register!(api as never);
  return { api, dir };
}

describe("OpenClaw 2026.11.3 plugin contract", () => {
  it("registers its channel, owner-scoped login tool and service without opening storage", () => {
    const { api, dir } = register();
    expect(api.registerChannel).toHaveBeenCalledWith({ plugin: whatsappPlugin });
    expect(api.registerTool.mock.calls[0][0].contextVersion).toBe(2);
    expect(existsSync(join(dir, "messages.db"))).toBe(false);
  });

  it("awaits DB initialization before starting an observer, without falling into the agent pipeline", async () => {
    register();
    const create = ObserverDB.create.bind(ObserverDB);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(ObserverDB, "create").mockImplementation(async path => { await gate; return create(path); });
    const pending = whatsappPlugin.gateway!.startAccount!({
      account: { accountId: "passive", authDir: "/tmp/unused" }, accountId: "passive",
      abortSignal: new AbortController().signal, setStatus: vi.fn(),
    } as never);
    expect(startObserverMonitor).not.toHaveBeenCalled();
    release();
    await pending;
    expect(startObserverMonitor).toHaveBeenCalledWith(expect.objectContaining({ accountId: "passive", db: expect.any(ObserverDB) }));
  });

  it("blocks outbound observer hooks and uses the gateway respond callback for invalid requests", async () => {
    const { api } = register();
    const hook = api.on.mock.calls.find(call => call[0] === "message_sending")![1];
    expect(hook({}, { channelId: "whatsapp-pro", accountId: "passive" })).toEqual({ cancel: true });
    expect(hook({}, { channelId: "whatsapp-pro", accountId: "normal" })).toBeUndefined();
    const handler = api.registerGatewayMethod.mock.calls[0][1];
    const respond = vi.fn();
    await handler({ params: { accountId: "passive", count: -2 }, respond });
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("uses refreshed observer account roles when the host restarts an account", async () => {
    const { api } = register();
    await api.registerService.mock.calls[0][0].start();
    const cfg = { channels: { "whatsapp-pro": { observer: { accounts: ["new-passive"] } } } };
    await whatsappPlugin.gateway!.startAccount!({
      cfg, account: { accountId: "new-passive", authDir: "/tmp/unused" }, accountId: "new-passive",
      abortSignal: new AbortController().signal, setStatus: vi.fn(),
    } as never);
    expect(startObserverMonitor).toHaveBeenCalledWith(expect.objectContaining({ accountId: "new-passive" }));
    const hook = api.on.mock.calls.find(call => call[0] === "message_sending")![1];
    expect(hook({}, { channelId: "whatsapp-pro", accountId: "new-passive" })).toEqual({ cancel: true });
  });

  it("fails startup when storage fails instead of starting the normal pipeline", async () => {
    register();
    vi.spyOn(ObserverDB, "create").mockRejectedValueOnce(new Error("database unreadable"));
    await expect(whatsappPlugin.gateway!.startAccount!({
      account: { accountId: "passive", authDir: "/tmp/unused" }, accountId: "passive",
      abortSignal: new AbortController().signal,
    } as never)).rejects.toThrow("database unreadable");
    expect(startObserverMonitor).not.toHaveBeenCalled();
    await closeObserver().catch(() => {});
  });

  it("validates observer fields and preserves native credentials and account config", () => {
    expect(WhatsAppProConfigSchema.safeParse({ observer: { accounts: ["passive"], retentionDays: 0 }, meta: { previousWhatsappEnabled: true } }).success).toBe(true);
    expect(WhatsAppProConfigSchema.safeParse({ observer: { retentionDays: -1 } }).success).toBe(false);
    const cfg = { channels: { "whatsapp-pro": { dmPolicy: "pairing", accounts: { passive: { enabled: true } } } } };
    const account = resolveWhatsAppAccount({ cfg, accountId: "passive" });
    expect(account.authDir).toMatch(/whatsapp\/passive$/);
    expect(account.dmPolicy).toBe("pairing");
    expect(whatsappPlugin.id).toBe("whatsapp-pro");
  });
});
