export type ObserverMode =
  | "record-all-retrieve-all"
  | "record-all-retrieve-filtered"
  | "record-filtered-retrieve-filtered";

export const OBSERVER_MODES: readonly ObserverMode[] = [
  "record-all-retrieve-all",
  "record-all-retrieve-filtered",
  "record-filtered-retrieve-filtered",
] as const;

export const DEFAULT_OBSERVER_MODE: ObserverMode = "record-all-retrieve-all";

/** Settings stored in the observer DB (mutable at runtime via wa-pro CLI). */
export type ObserverSettings = {
  mode: ObserverMode;
  filters: ObserverFilters;
  retentionDays: number;
};

/** Full observer config: paths + accounts from openclaw.json, settings from DB. */
export type ObserverConfig = {
  dbPath: string;
  mediaPath: string;
  observerAccounts: string[];
} & ObserverSettings;

export type ObserverFilters = {
  blocklist: string[];
  allowlist: string[];
};

export type MessageType = "message" | "reaction" | "poll" | "edit" | "delete";
export type MessageSource = "observer" | "pipeline";

export type ObserverMessage = {
  messageId?: string;
  fromMe?: boolean;
  accountId: string;
  sender: string;
  senderName?: string;
  senderE164?: string;
  conversationId: string;
  isGroup: boolean;
  groupId?: string;
  groupName?: string;
  content?: string;
  mediaType?: string;
  mediaPath?: string;
  mediaMime?: string;
  timestamp: number;
  messageType?: MessageType;
  refMessageId?: string;
  source?: MessageSource;
};

export type ObserverStats = {
  totalMessages: number;
  uniqueSenders: number;
  uniqueConversations: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
};

export type ConversationSummary = {
  conversationId: string;
  accountId?: string;
  groupName?: string;
  contactName?: string;
  messageCount: number;
  lastMessageAt: number;
  lastSender?: string;
};

export type StatsGroupByResult = {
  key: string;
  count: number;
};

export type ContactInfo = {
  jid: string;
  accountId: string;
  phone?: string;
  pushName?: string;
  businessName?: string;
  isGroup: boolean;
  groupSubject?: string;
  groupDescription?: string;
};

export type ChannelLogSink = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};
