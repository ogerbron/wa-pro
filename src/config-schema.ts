import { buildChannelConfigSchema } from "../config-api.js";
import { WhatsAppProConfigSchema } from "./channel-config.js";
import { whatsAppChannelConfigUiHints } from "./config-ui-hints.js";

export const WhatsAppChannelConfigSchema = buildChannelConfigSchema(WhatsAppProConfigSchema, {
  uiHints: whatsAppChannelConfigUiHints,
});
