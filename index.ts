import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { whatsappPlugin } from "./src/channel.js";
import { setWhatsAppRuntime } from "./src/runtime.js";
import { registerWhatsAppLoginTool } from "./src/agent-tools-login.js";
import { getChannelConfig } from "./src/channel-config.js";
import { parseObserverConfig, isObserverAccount } from "./src/observer-config.js";
import { configureObserver, ensureObserverState, closeObserver, getObserverConfig } from "./src/observer/state.js";
import { requestBackfill } from "./src/observer/monitor.js";

export { whatsappPlugin } from "./src/channel.js";
export { setWhatsAppRuntime } from "./src/runtime.js";

export default definePluginEntry({
  id: "whatsapp-pro",
  name: "WhatsApp Pro",
  description: "WhatsApp channel with passive SQLite message history",
  register(api) {
    setWhatsAppRuntime(api.runtime);
    api.registerChannel({ plugin: whatsappPlugin });
    registerWhatsAppLoginTool(api);
    const config = parseObserverConfig(getChannelConfig(api.config));
    configureObserver({
      ...config,
      dbPath: api.resolvePath(config.dbPath),
      mediaPath: api.resolvePath(config.mediaPath),
    });
    // Registration also runs during config inspection. Open storage only on startup.
    api.registerService({
      id: "whatsapp-pro-observer",
      start: async () => { await ensureObserverState(); },
      stop: closeObserver,
    });
    api.on("message_sending", (_event, ctx) => {
      if (ctx.channelId === "whatsapp-pro" && ctx.accountId && isObserverAccount(ctx.accountId, getObserverConfig() ?? config)) {
        return { cancel: true };
      }
    }, { priority: 9999 });
    api.registerGatewayMethod("wa-pro.backfill", async ({ params, respond }) => {
      const { accountId, conversationId, count } = params;
      if (typeof accountId !== "string" || !accountId.trim() ||
          typeof conversationId !== "string" || !conversationId.trim() ||
          (count !== undefined && (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 50))) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "accountId, conversationId and a count from 1 to 50 are required" });
        return;
      }
      try {
        const { db } = await ensureObserverState();
        const requested = await requestBackfill({ accountId, conversationId, count: count as number | undefined, db });
        respond(true, { requested });
      } catch (error) {
        respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
      }
    });
  },
});
