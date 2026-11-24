import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import JSON5 from "json5";

export function migrateToNative(channel) {
  const { observer, meta, ...native } = channel;
  const excluded = new Set(observer?.accounts ?? []);
  if (native.accounts) native.accounts = Object.fromEntries(Object.entries(native.accounts).filter(([id]) => !excluded.has(id)));
  return native;
}

export function prepareInstall(config, migrate) {
  const previous = config.channels?.["whatsapp-pro"];
  const native = config.channels?.whatsapp;
  const saved = {
    ...(migrate ? native : {}), ...previous,
    meta: {
      ...previous?.meta,
      previousWhatsappEnabled: previous?.meta?.previousWhatsappEnabled ??
        Boolean(native && config.plugins?.entries?.whatsapp?.enabled !== false),
    },
  };
  config.channels ??= {};
  delete config.channels.whatsapp;
  delete config.channels["whatsapp-pro"];
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries.whatsapp = { ...config.plugins.entries.whatsapp, enabled: false };
  delete config.plugins.entries["whatsapp-pro"];
  if (Array.isArray(config.plugins.allow)) config.plugins.allow = config.plugins.allow.filter(id => id !== "whatsapp-pro");
  return saved;
}

export function finishInstall(config, saved) {
  config.channels ??= {};
  config.channels["whatsapp-pro"] = saved;
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries.whatsapp = { ...config.plugins.entries.whatsapp, enabled: false };
  config.plugins.entries["whatsapp-pro"] = { enabled: true };
  if (Array.isArray(config.plugins.allow) && !config.plugins.allow.includes("whatsapp-pro")) config.plugins.allow.push("whatsapp-pro");
}

export function prepareUninstall(config, migrate, restore) {
  const channel = config.channels?.["whatsapp-pro"];
  const wasEnabled = channel?.meta?.previousWhatsappEnabled === true;
  const restoreNative = restore === "yes" || (restore !== "no" && wasEnabled);
  if (channel && migrate) {
    config.channels ??= {};
    config.channels.whatsapp = { ...migrateToNative(channel), enabled: restoreNative };
  }
  if (config.channels) delete config.channels["whatsapp-pro"];
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries.whatsapp = { ...config.plugins.entries.whatsapp, enabled: restoreNative };
  return restoreNative;
}

export function setAccountMode(config, accountId, mode) {
  accountId = accountId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountId)) throw new Error("Invalid account ID");
  config.channels ??= {};
  const channel = config.channels["whatsapp-pro"] ??= {};
  channel.accounts ??= {};
  const account = channel.accounts[accountId] ??= {};
  account.enabled = true;
  const observer = channel.observer ??= {};
  observer.accounts = (observer.accounts ?? []).filter(id => id !== accountId);
  if (mode === "observer") observer.accounts.push(accountId);
  else account.dmPolicy = "pairing";
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries["whatsapp-pro"] = { ...config.plugins.entries["whatsapp-pro"], enabled: true };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [action, path, ...args] = process.argv.slice(2);
  const config = existsSync(path) ? JSON5.parse(readFileSync(path, "utf8")) : {};
  const save = () => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 }); };
  switch (action) {
    case "has-native": console.log(config.channels?.whatsapp ? "yes" : "no"); break;
    case "has-pro": console.log(config.channels?.["whatsapp-pro"] ? "yes" : "no"); break;
    case "prepare-install": {
      if (existsSync(path)) copyFileSync(path, `${path}.pre-whatsapp-pro.bak`);
      const saved = prepareInstall(config, args[0] === "yes");
      writeFileSync(args[1], JSON.stringify(saved), { mode: 0o600 });
      save(); break;
    }
    case "finish-install": finishInstall(config, JSON.parse(readFileSync(args[0], "utf8"))); save(); break;
    case "prepare-uninstall":
      if (existsSync(path)) copyFileSync(path, `${path}.pre-uninstall-whatsapp-pro.bak`);
      prepareUninstall(config, args[0] === "yes", args[1]); save(); break;
    case "account": setAccountMode(config, args[0], args[1]); save(); break;
    default: throw new Error(`Unknown config action: ${action}`);
  }
}
