import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};

export const unsupportedSecretRefSurfacePatterns = [
  "channels.whatsapp-pro.creds.json",
  "channels.whatsapp-pro.accounts.*.creds.json",
] as const;

export function collectUnsupportedSecretRefConfigCandidates(
  raw: unknown,
): UnsupportedSecretRefConfigCandidate[] {
  if (!isRecord(raw)) {
    return [];
  }
  if (!isRecord(raw.channels) || !isRecord(raw.channels["whatsapp-pro"])) {
    return [];
  }

  const candidates: UnsupportedSecretRefConfigCandidate[] = [];
  const whatsapp = raw.channels["whatsapp-pro"];
  const creds = isRecord(whatsapp.creds) ? whatsapp.creds : null;
  if (creds) {
    candidates.push({
      path: "channels.whatsapp-pro.creds.json",
      value: creds.json,
    });
  }

  const accounts = isRecord(whatsapp.accounts) ? whatsapp.accounts : null;
  if (!accounts) {
    return candidates;
  }
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!isRecord(account) || !isRecord(account.creds)) {
      continue;
    }
    candidates.push({
      path: `channels.whatsapp-pro.accounts.${accountId}.creds.json`,
      value: account.creds.json,
    });
  }
  return candidates;
}
