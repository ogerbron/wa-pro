import { mkdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { WAMessage, proto, WASocket } from "baileys";
import { downloadMediaMessage, normalizeMessageContent } from "baileys";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "audio/ogg; codecs=opus": ".ogg",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "application/pdf": ".pdf",
};

function resolveMediaMimetype(message: proto.IMessage): string | undefined {
  const explicit =
    message.imageMessage?.mimetype ??
    message.videoMessage?.mimetype ??
    message.documentMessage?.mimetype ??
    message.audioMessage?.mimetype ??
    message.stickerMessage?.mimetype ??
    undefined;
  if (explicit) return explicit;
  if (message.audioMessage) return "audio/ogg; codecs=opus";
  if (message.imageMessage) return "image/jpeg";
  if (message.videoMessage) return "video/mp4";
  if (message.stickerMessage) return "image/webp";
  return undefined;
}

export function hasMedia(message: proto.IMessage | null | undefined): boolean {
  if (!message) return false;
  const normalized = normalizeMessageContent(message);
  if (!normalized) return false;
  return Boolean(
    normalized.imageMessage ??
      normalized.videoMessage ??
      normalized.audioMessage ??
      normalized.documentMessage ??
      normalized.stickerMessage,
  );
}

export function detectMediaType(
  message: proto.IMessage | null | undefined,
): string | undefined {
  if (!message) return undefined;
  const normalized = normalizeMessageContent(message);
  if (!normalized) return undefined;
  if (normalized.imageMessage) return "image";
  if (normalized.videoMessage) return "video";
  if (normalized.audioMessage) return "audio";
  if (normalized.documentMessage) return "document";
  if (normalized.stickerMessage) return "sticker";
  return undefined;
}

export async function downloadAndStoreMedia(
  msg: WAMessage,
  sock: Pick<WASocket, "updateMediaMessage" | "logger">,
  mediaBasePath: string,
): Promise<{ localPath: string; mime?: string } | undefined> {
  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        reuploadRequest: sock.updateMediaMessage,
        logger: sock.logger,
      },
    );

    const message = normalizeMessageContent(msg.message as proto.IMessage | undefined);
    if (!message) return undefined;

    const mime = resolveMediaMimetype(message);
    const ext =
      (mime ? MIME_TO_EXT[mime] : undefined) ??
      (message.documentMessage?.fileName
        ? extname(message.documentMessage.fileName)
        : ".bin");

    const dateDir = new Date().toISOString().slice(0, 10);
    const dir = join(mediaBasePath, dateDir);
    await mkdir(dir, { recursive: true });

    const fileName =
      `${randomUUID()}${ext}`;
    const localPath = join(dir, fileName);
    await writeFile(localPath, buffer);

    return { localPath, mime };
  } catch {
    return undefined;
  }
}
