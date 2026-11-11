import { createHash } from "node:crypto";
import { isObserverAccount } from "../observer-config.js";
import {
  isJidGroup,
  makeWASocket,
  type ConnectionState,
  type WAMessage,
} from "baileys";
import { extractMessageContent, getContentType, normalizeMessageContent } from "baileys";
import { isBlocked, isAllowed } from "./filter.js";
import { hasMedia, detectMediaType, downloadAndStoreMedia } from "./media.js";
import type { ObserverDB } from "./db.js";
import type { ObserverConfig, ChannelLogSink, MessageSource } from "./types.js";
import { registerObserverCleanup } from "./state.js";

// Active observer sockets keyed by accountId — used for on-demand backfill
const activeSockets = new Map<string, ReturnType<typeof makeWASocket>>();

/** Get the active Baileys socket for an observer account (if connected). */
export function getObserverSocket(accountId: string): ReturnType<typeof makeWASocket> | undefined {
  return activeSockets.get(accountId);
}

/**
 * Request on-demand history backfill for a chat.
 * Uses Baileys' fetchMessageHistory() which requests older messages from the phone.
 * Results arrive via the messaging-history.set event and are automatically processed.
 *
 * @returns Number of messages requested, or null if account not connected.
 */
export async function requestBackfill(params: {
  accountId: string;
  conversationId: string;
  count?: number;
  db: ObserverDB;
  logger?: ChannelLogSink;
}): Promise<number | null> {
  const sock = activeSockets.get(params.accountId);
  if (!sock) {
    params.logger?.warn(`Backfill: account ${params.accountId} not connected`);
    return null;
  }

  const count = Math.max(1, Math.min(params.count ?? 50, 50)); // Baileys max is 50 per request
  const oldest = params.db.getOldestMessage(params.conversationId, params.accountId);

  if (!oldest) {
    params.logger?.info(`Backfill: no messages in ${params.conversationId}, cannot anchor`);
    return null;
  }

  const msgKey = {
    remoteJid: params.conversationId,
    id: oldest.message_id as string,
    fromMe: Boolean(oldest.from_me),
  };
  const timestamp = (oldest.timestamp as number) / 1000; // Baileys uses seconds

  params.logger?.info(
    `Backfill: requesting ${count} messages before ${new Date(oldest.timestamp as number).toISOString()} in ${params.conversationId}`,
  );

  try {
    await sock.fetchMessageHistory(count, msgKey, Math.floor(timestamp));
    return count;
  } catch (err) {
    params.logger?.error(`Backfill failed: ${String(err)}`);
    return null;
  }
}

export type ObserverMonitorParams = {
  accountId: string;
  authDir: string;
  abortSignal: AbortSignal;
  setStatus: (status: Record<string, unknown>) => void;
  config: ObserverConfig;
  db: ObserverDB;
  logger?: ChannelLogSink;
};

function jidToE164(jid: string | undefined | null): string | undefined {
  if (!jid) return undefined;
  const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/);
  if (!match) return undefined;
  return `+${match[1]}`;
}

function extractText(message: import("baileys").proto.IMessage | undefined): string | undefined {
  if (!message) return undefined;
  const normalized = normalizeMessageContent(message);
  if (!normalized) return undefined;
  const extracted = extractMessageContent(normalized);
  const candidates = [normalized, extracted && extracted !== normalized ? extracted : undefined];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate.conversation === "string" && candidate.conversation.trim()) {
      return candidate.conversation.trim();
    }
    const extended = candidate.extendedTextMessage?.text;
    if (extended?.trim()) return extended.trim();
    const caption =
      candidate.imageMessage?.caption ??
      candidate.videoMessage?.caption ??
      candidate.documentMessage?.caption;
    if (caption?.trim()) return caption.trim();
  }
  return undefined;
}

/** Safe jidToE164 that returns null for LID JIDs (which are not real phone numbers). */
function safeJidToE164(jid: string | null | undefined): string | null {
  if (!jid) return null;
  if (jid.endsWith("@lid")) return null;
  return jidToE164(jid) ?? null;
}

export async function processObserverMessage(
  msg: WAMessage,
  sock: ReturnType<typeof makeWASocket> | null,
  ctx: {
    accountId: string;
    config: ObserverConfig;
    db: ObserverDB;
    logger?: ChannelLogSink;
    source?: MessageSource;
    /** LID→E.164 lookup from Baileys signal repository (for resolving LID JIDs). */
    lidLookup?: NonNullable<Parameters<typeof import("../targets-runtime.js").resolveJidToE164>[1]>["lidLookup"];
    /** Auth dir for JID resolution fallback. */
    authDir?: string;
  },
): Promise<void> {
  // Strip leading '+' from JIDs — WhatsApp JIDs use digits only before the @
  const normalizeJid = (jid: string): string => jid.replace(/^\+/, "");

  // Resolve JID: prefer remoteJidAlt (E.164-based) when remoteJid uses LID format
  const rawJid = msg.key?.remoteJid;
  const altJid = (msg.key as Record<string, unknown>)?.remoteJidAlt as string | undefined;

  let remoteJid = rawJid?.endsWith("@lid") && altJid?.endsWith("@s.whatsapp.net")
    ? normalizeJid(altJid)
    : rawJid ? normalizeJid(rawJid) : undefined;
  if (!remoteJid) return;

  // Resolve LID JIDs to E.164 using the signal repository's lid mapping
  if (remoteJid.endsWith("@lid") && (ctx.lidLookup || ctx.authDir)) {
    try {
      const { resolveJidToE164 } = await import("../targets-runtime.js");
      const resolved = await resolveJidToE164(remoteJid, {
        authDir: ctx.authDir,
        lidLookup: ctx.lidLookup,
      });
      if (resolved) {
        const normalized = normalizeJid(resolved);
        remoteJid = normalized.includes("@") ? normalized : `${normalized}@s.whatsapp.net`;
      }
    } catch {
      // SDK not available (e.g., in tests) — fall back to raw JID
    }
  }

  if (
    !remoteJid.endsWith("@s.whatsapp.net") &&
    !remoteJid.endsWith("@g.us") &&
    !remoteJid.endsWith("@newsletter") &&
    !remoteJid.endsWith("@lid")
  ) {
    return;
  }

  const isGroup = Boolean(isJidGroup(remoteJid));
  const selfJid = sock?.user?.id?.replace(/:\d+@/, "@");
  const participantAlt = msg.key?.participantAlt?.endsWith("@s.whatsapp.net") ? msg.key.participantAlt : undefined;
  const sender = msg.key?.fromMe
    ? (selfJid ?? msg.key.participant ?? "self")
    : isGroup ? (participantAlt ?? msg.key?.participant ?? remoteJid) : remoteJid;
  let senderE164 = safeJidToE164(sender) ?? safeJidToE164(altJid);

  // Resolve sender LID if still unresolved
  if (!senderE164 && sender.endsWith("@lid") && (ctx.lidLookup || ctx.authDir)) {
    try {
      const { resolveJidToE164 } = await import("../targets-runtime.js");
      senderE164 = await resolveJidToE164(sender, {
        authDir: ctx.authDir,
        lidLookup: ctx.lidLookup,
      }) ?? null;
    } catch {
      // SDK not available — keep senderE164 as-is
    }
  }

  // Apply blocklist/allowlist at ingestion time only in record-filtered mode
  // Use per-account settings from DB when available, otherwise fall back to config
  const accountSettings = ctx.db.getAccountSettings(ctx.accountId);
  if (accountSettings.mode === "record-filtered-retrieve-filtered") {
    if (isBlocked(senderE164 ?? sender, remoteJid, accountSettings.filters)) return;
    if (!isAllowed(senderE164 ?? sender, remoteJid, accountSettings.filters)) return;
  }

  const rawMessage = msg.message as import("baileys").proto.IMessage | undefined;
  const normalized = normalizeMessageContent(rawMessage);
  const editTimestamp = normalized?.protocolMessage?.editedMessage ? normalized.protocolMessage.timestampMs : undefined;
  const timestamp = Number(editTimestamp) || Number(msg.messageTimestamp) * 1000 || Date.now();

  // --- Reaction message ---
  const reactionMsg = normalized?.reactionMessage;
  if (reactionMsg) {
    ctx.db.insertMessage({
      messageId: msg.key?.id ?? undefined,
      fromMe: msg.key?.fromMe ?? false,
      accountId: ctx.accountId,
      sender: senderE164 ?? sender,
      senderName: msg.pushName ?? undefined,
      senderE164: senderE164 ?? undefined,
      conversationId: remoteJid,
      isGroup,
      content: reactionMsg.text || "[reaction removed]",
      refMessageId: reactionMsg.key?.id ?? undefined,
      messageType: "reaction",
      source: ctx.source ?? "observer",
      timestamp,
    });
    ctx.logger?.debug?.(`Observer ${ctx.accountId}: logged reaction from ${senderE164 ?? sender}`);
    return;
  }

  // --- Poll creation ---
  const pollMsg = normalized?.pollCreationMessage ?? normalized?.pollCreationMessageV2 ?? normalized?.pollCreationMessageV3 ?? normalized?.pollCreationMessageV5;
  if (pollMsg) {
    const options = pollMsg.options?.map((o) => o.optionName).join(", ") ?? "";
    ctx.db.insertMessage({
      messageId: msg.key?.id ?? undefined,
      fromMe: msg.key?.fromMe ?? false,
      accountId: ctx.accountId,
      sender: senderE164 ?? sender,
      senderName: msg.pushName ?? undefined,
      senderE164: senderE164 ?? undefined,
      conversationId: remoteJid,
      isGroup,
      content: `[poll] ${pollMsg.name ?? "Poll"}: ${options}`,
      messageType: "poll",
      source: ctx.source ?? "observer",
      timestamp,
    });
    ctx.logger?.debug?.(`Observer ${ctx.accountId}: logged poll from ${senderE164 ?? sender}`);
    return;
  }

  // --- Protocol messages: edits and deletions ---
  const protoMsg = normalized?.protocolMessage;
  if (protoMsg) {
    // Message edit
    if (protoMsg.editedMessage) {
      const editedText = extractText(
        protoMsg.editedMessage as import("baileys").proto.IMessage,
      );
      ctx.db.insertMessage({
        messageId: msg.key?.id ? `edit:${protoMsg.key?.id ?? msg.key.id}:${Math.floor(timestamp / 1000)}:${createHash("sha256").update(editedText ?? "").digest("hex").slice(0, 16)}` : undefined,
        fromMe: msg.key?.fromMe ?? false,
        accountId: ctx.accountId,
        sender: senderE164 ?? sender,
        senderName: msg.pushName ?? undefined,
        senderE164: senderE164 ?? undefined,
        conversationId: remoteJid,
        isGroup,
        content: editedText ?? "[edited message]",
        refMessageId: protoMsg.key?.id ?? undefined,
        messageType: "edit",
        source: ctx.source ?? "observer",
        timestamp,
      });
      ctx.logger?.debug?.(`Observer ${ctx.accountId}: logged edit from ${senderE164 ?? sender}`);
      return;
    }
    // Message deletion (type 0 = REVOKE)
    if (protoMsg.type === 0 && protoMsg.key) {
      ctx.db.insertMessage({
        messageId: msg.key?.id ? `delete:${protoMsg.key?.id ?? msg.key.id}` : undefined,
        fromMe: msg.key?.fromMe ?? false,
        accountId: ctx.accountId,
        sender: senderE164 ?? sender,
        senderName: msg.pushName ?? undefined,
        senderE164: senderE164 ?? undefined,
        conversationId: remoteJid,
        isGroup,
        content: "[message deleted]",
        refMessageId: protoMsg.key.id ?? undefined,
        messageType: "delete",
        source: ctx.source ?? "observer",
        timestamp,
      });
      ctx.logger?.debug?.(`Observer ${ctx.accountId}: logged deletion from ${senderE164 ?? sender}`);
      return;
    }
    // Other protocol messages (e.g. ephemeral settings) — skip
    ctx.logger?.info(`Observer ${ctx.accountId}: skipping protocol message type=${protoMsg.type}`);
    return;
  }

  // --- Regular text/media message ---
  const text = extractText(msg.message as import("baileys").proto.IMessage | undefined);

  let groupName: string | undefined;
  if (isGroup && sock) {
    try {
      const meta = await sock.groupMetadata(remoteJid);
      groupName = meta?.subject;
    } catch {
      // group metadata may fail
    }
  }

  // Download media if present (requires sock for download)
  let mediaLocalPath: string | undefined;
  let mediaMime: string | undefined;
  if (sock && hasMedia(msg.message as import("baileys").proto.IMessage | undefined)) {
    const result = await downloadAndStoreMedia(msg, sock, ctx.config.mediaPath);
    if (result) {
      mediaLocalPath = result.localPath;
      mediaMime = result.mime;
    }
  }

  const mediaType = detectMediaType(msg.message as import("baileys").proto.IMessage | undefined);

  ctx.db.insertMessage({
    messageId: msg.key?.id ?? undefined,
    fromMe: msg.key?.fromMe ?? false,
    accountId: ctx.accountId,
    sender: senderE164 ?? sender,
    senderName: msg.pushName ?? undefined,
    senderE164: senderE164 ?? undefined,
    conversationId: remoteJid,
    isGroup,
    groupName,
    content: text ?? (mediaType ? `[${mediaType}]` : undefined),
    mediaType,
    mediaPath: mediaLocalPath,
    mediaMime,
    messageType: "message",
    source: ctx.source ?? "observer",
    timestamp,
  });

  ctx.logger?.debug?.(
    `Observer ${ctx.accountId}: logged message from ${senderE164 ?? sender} in ${remoteJid}`,
  );
}

/** Attach capture before startup events; observer accounts also reject socket sends. */
export function attachObserverListeners(
  sock: ReturnType<typeof makeWASocket>,
  ctx: {
    accountId: string;
    config: ObserverConfig;
    db: ObserverDB;
    logger?: ChannelLogSink;
    authDir?: string;
    source?: MessageSource;
  },
): () => Promise<void> {
  let pending = Promise.resolve();
  let disposed = false;
  const process = (msg: WAMessage) => {
    if (disposed) return;
    pending = pending.then(() => processObserverMessage(msg, sock, {
      ...ctx,
      lidLookup: sock.signalRepository?.lidMapping,
    })).catch((error) => ctx.logger?.error(`Observer ${ctx.accountId}: ${String(error)}`));
  };
  const upsert = ({ messages }: { messages: WAMessage[] }) => messages.forEach(process);
  const history: Parameters<typeof sock.ev.on<"messaging-history.set">>[1] = (data) => {
    upsert({ messages: data.messages ?? [] });
    contacts(data.contacts ?? []);
    for (const chat of data.chats ?? []) {
      if (chat.id && chat.name && isJidGroup(chat.id)) {
        ctx.db.upsertContact({ jid: chat.id, accountId: ctx.accountId, isGroup: true, groupSubject: chat.name });
      }
    }
  };
  const contacts = (updates: Array<{ id?: string; notify?: string; name?: string; verifiedName?: string }>) => {
    for (const contact of updates) {
      if (!contact.id) continue;
      ctx.db.upsertContact({
        jid: contact.id, accountId: ctx.accountId,
        pushName: contact.notify ?? contact.name,
        businessName: contact.verifiedName,
        phone: safeJidToE164(contact.id) ?? undefined,
      });
    }
  };
  const groups = (updates: Array<{ id?: string; subject?: string; desc?: string }>) => {
    for (const group of updates) {
      if (group.id) ctx.db.upsertContact({
        jid: group.id, accountId: ctx.accountId, isGroup: true,
        groupSubject: group.subject, groupDescription: group.desc,
      });
    }
  };
  const reactions: Parameters<typeof sock.ev.on<"messages.reaction">>[1] = (updates) => {
    for (const { key, reaction } of updates) {
      process({
        key: { ...reaction.key, remoteJid: key.remoteJid },
        message: { reactionMessage: { ...reaction, key } },
        messageTimestamp: reaction.senderTimestampMs
          ? Math.floor(Number(reaction.senderTimestampMs) / 1000) : Math.floor(Date.now() / 1000),
      });
    }
  };
  const updates: Parameters<typeof sock.ev.on<"messages.update">>[1] = (entries) => {
    for (const { key, update } of entries) {
      if (update.messageStubType === 1) {
        process({ key, message: { protocolMessage: { type: 0, key } }, messageTimestamp: Math.floor(Date.now() / 1000) });
      } else if (update.message?.editedMessage?.message) {
        process({
          key,
          message: { protocolMessage: { key, editedMessage: update.message.editedMessage.message } },
          messageTimestamp: update.messageTimestamp ?? Math.floor(Date.now() / 1000),
        });
      } else if (update.message) {
        process({ key, ...update, messageTimestamp: update.messageTimestamp ?? Math.floor(Date.now() / 1000) });
      }
    }
  };
  // Baileys does not consistently emit upserts for locally sent messages.
  const observerOnly = isObserverAccount(ctx.accountId, ctx.config);
  const originalSend = sock.sendMessage;
  sock.sendMessage = async (...args) => {
    if (observerOnly) throw new Error("Observer accounts cannot send messages");
    const result = await originalSend.apply(sock, args);
    if (result) process(result);
    return result;
  };
  const connection = (update: Partial<ConnectionState>) => {
    if (update.connection === "open") activeSockets.set(ctx.accountId, sock);
    if (update.connection === "close") void dispose();
  };
  sock.ev.on("messages.upsert", upsert);
  sock.ev.on("messaging-history.set", history);
  sock.ev.on("messages.reaction", reactions);
  sock.ev.on("messages.update", updates);
  sock.ev.on("contacts.upsert", contacts);
  sock.ev.on("contacts.update", contacts);
  sock.ev.on("groups.upsert", groups);
  sock.ev.on("groups.update", groups);
  sock.ev.on("connection.update", connection);
  let polling = false;
  const interval = setInterval(async () => {
    if (polling || disposed) return;
    polling = true;
    try {
      for (const { key, value } of ctx.db.getPendingBackfills(ctx.accountId)) {
        if (disposed) break;
        const requested = await requestBackfill({
          ...ctx, conversationId: String(value.conversationId), count: Number(value.count) || 50,
        });
        if (!disposed && requested !== null) ctx.db.deleteSetting(key);
      }
      if (!disposed) ctx.db.prune(ctx.db.getAccountSettings(ctx.accountId).retentionDays, ctx.accountId);
    } catch (error) {
      ctx.logger?.error(`Observer ${ctx.accountId}: maintenance failed: ${String(error)}`);
    } finally {
      polling = false;
    }
  }, 5_000);
  interval.unref();
  const unregisterCleanup = registerObserverCleanup(dispose);
  async function dispose() {
    if (disposed) return pending;
    disposed = true;
    unregisterCleanup();
    clearInterval(interval);
    if (activeSockets.get(ctx.accountId) === sock) activeSockets.delete(ctx.accountId);
    sock.ev.off("messages.upsert", upsert);
    sock.ev.off("messaging-history.set", history);
    sock.ev.off("messages.reaction", reactions);
    sock.ev.off("messages.update", updates);
    sock.ev.off("contacts.upsert", contacts);
    sock.ev.off("contacts.update", contacts);
    sock.ev.off("groups.upsert", groups);
    sock.ev.off("groups.update", groups);
    sock.ev.off("connection.update", connection);
    if (!observerOnly) sock.sendMessage = originalSend;
    await pending;
  }
  return dispose;
}

export async function startObserverMonitor(params: ObserverMonitorParams): Promise<void> {
  const { createWaSocket } = await import("../session.js");
  const { getStatusCode } = await import("../session-errors.js");
  const { sleepWithAbort } = await import("openclaw/plugin-sdk/runtime-env");
  const { accountId, authDir, abortSignal, logger } = params;
  let attempts = 0;
  let terminalDisconnect = false;
  try {
    while (!abortSignal.aborted && !terminalDisconnect) {
      let sock: Awaited<ReturnType<typeof createWaSocket>> | undefined;
      try {
        sock = await createWaSocket(false, false, { authDir, observerAccountId: accountId });
        const current = sock;
        await new Promise<void>((resolve, reject) => {
          let opened = false;
          const timeout = setTimeout(() => finish(new Error("Observer connection timed out")), 60_000);
          const abort = () => finish();
          const connection = (update: Partial<ConnectionState>) => {
            if (update.connection === "open") {
              opened = true;
              attempts = 0;
              clearTimeout(timeout);
              params.setStatus({ running: true, connected: true, lastConnectedAt: Date.now() });
            }
            if (update.connection === "close") {
              const error = update.lastDisconnect?.error;
              const status = getStatusCode(error);
              if (status === 401 || status === 440) {
                terminalDisconnect = true;
                params.setStatus({ healthState: status === 401 ? "logged-out" : "disconnected", lastError: String(error ?? status) });
              }
              if (abortSignal.aborted || opened) finish();
              else finish(error ?? new Error("Observer connection closed"));
            }
          };
          const finish = (error?: unknown) => {
            clearTimeout(timeout);
            abortSignal.removeEventListener("abort", abort);
            current.ev.off("connection.update", connection);
            error ? reject(error) : resolve();
          };
          current.ev.on("connection.update", connection);
          abortSignal.addEventListener("abort", abort, { once: true });
          if (abortSignal.aborted) abort();
        });
      } catch (error) {
        if (!abortSignal.aborted) {
          logger?.error(`Observer ${accountId}: ${String(error)}`);
          params.setStatus({ lastError: String(error) });
        }
      } finally {
        sock?.end(new Error("Observer connection stopped"));
        params.setStatus({ connected: false });
      }
      if (!abortSignal.aborted && !terminalDisconnect) {
        await sleepWithAbort(Math.min(2000 * 2 ** attempts++, 60_000), abortSignal).catch(() => {});
      }
    }
  } finally {
    params.setStatus({ running: false, connected: false });
  }
}
