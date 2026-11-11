import { z } from "zod";
import { WhatsAppConfigSchema } from "../config-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/**
 * Zod schema for the observer-specific section of the channel config.
 */
export const ObserverConfigSchema = z.object({
  accounts: z.array(z.string()).optional(),
  dbPath: z.string().optional(),
  mediaPath: z.string().optional(),
  mode: z
    .enum([
      "record-all-retrieve-all",
      "record-all-retrieve-filtered",
      "record-filtered-retrieve-filtered",
    ])
    .optional(),
  filters: z
    .object({
      blocklist: z.array(z.string()).optional(),
      allowlist: z.array(z.string()).optional(),
    })
    .optional(),
  retentionDays: z.number().int().nonnegative().optional(),
});

/**
 * Full channel config schema for "whatsapp-pro".
 *
 * Extends the standard WhatsApp config schema with observer fields.
 * safeExtend preserves the native schema refinements and strict validation.
 */
/**
 * Install/uninstall metadata persisted in the channel config.
 */
export const ChannelMetaSchema = z.object({
  previousWhatsappEnabled: z.boolean().optional(),
});

export const WhatsAppProConfigSchema = WhatsAppConfigSchema.safeExtend({
  observer: ObserverConfigSchema.optional(),
  meta: ChannelMetaSchema.optional(),
});

/** Inferred TypeScript type for the full whatsapp-pro channel config. */
export type WhatsAppProChannelConfig = z.infer<typeof WhatsAppProConfigSchema>;

/**
 * Type-safe accessor for the `channels["whatsapp-pro"]` config section.
 *
 * Since ChannelsConfig uses `[key: string]: any` for extension channels,
 * accessing `cfg.channels?.["whatsapp-pro"]` returns `any`. This function
 * narrows it once at the boundary so the rest of the codebase stays type-safe.
 *
 * Returns `undefined` when the section is missing or not an object.
 */
export function getChannelConfig(cfg: OpenClawConfig): WhatsAppProChannelConfig | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- upstream `[key: string]: any` index signature
  const raw = cfg.channels?.["whatsapp-pro"];
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  return raw as WhatsAppProChannelConfig;
}
