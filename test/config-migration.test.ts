import { describe, expect, it } from "vitest";
import { prepareInstall, finishInstall, prepareUninstall, setAccountMode } from "../scripts/manage-config.mjs";

describe("install and uninstall configuration", () => {
  it("migrates policies and accounts while explicitly disabling native WhatsApp", () => {
    const config: any = { channels: { whatsapp: { dmPolicy: "pairing", accounts: { normal: { enabled: true } } } }, plugins: { allow: ["whatsapp"] } };
    const saved = prepareInstall(config, true);
    expect(config.plugins.entries.whatsapp.enabled).toBe(false);
    expect(config.channels.whatsapp).toBeUndefined();
    finishInstall(config, saved);
    expect(config.channels["whatsapp-pro"].accounts.normal.enabled).toBe(true);
    expect(config.plugins.allow).toContain("whatsapp-pro");
    expect(config.channels["whatsapp-pro"].meta.previousWhatsappEnabled).toBe(true);
    const second = prepareInstall(config, false);
    finishInstall(config, second);
    expect(config.channels["whatsapp-pro"].meta.previousWhatsappEnabled).toBe(true);
  });

  it("migrates normal accounts back before removal and excludes plugin-only fields", () => {
    const config: any = { channels: { "whatsapp-pro": { observer: { accounts: ["passive"] }, meta: { previousWhatsappEnabled: true }, accounts: { normal: { enabled: true }, passive: { enabled: true } } } } };
    expect(prepareUninstall(config, true, "")).toBe(true);
    expect(config.channels.whatsapp.accounts).toEqual({ normal: { enabled: true } });
    expect(config.channels.whatsapp.observer).toBeUndefined();
    expect(config.channels.whatsapp.meta).toBeUndefined();
    expect(config.channels["whatsapp-pro"]).toBeUndefined();
  });

  it("supports switching an observer account back to normal", () => {
    const config: any = {};
    setAccountMode(config, "a", "observer");
    expect(config.channels["whatsapp-pro"].observer.accounts).toEqual(["a"]);
    setAccountMode(config, "a", "normal");
    expect(config.channels["whatsapp-pro"].observer.accounts).toEqual([]);
    expect(config.channels["whatsapp-pro"].accounts.a.dmPolicy).toBe("pairing");
  });
});
