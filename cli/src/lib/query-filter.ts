import { isBlocked, isAllowed } from "../../../src/observer/filter.js";
import type { ObserverFilters, ObserverMode } from "../../../src/observer/types.js";

/**
 * Apply retrieve-time filtering for `record-all-retrieve-filtered` mode.
 * For other modes, returns the results unchanged.
 */
export function applyRetrieveFilter(
  results: Array<Record<string, unknown>>,
  mode: ObserverMode,
  filters: ObserverFilters,
): Array<Record<string, unknown>> {
  if (mode === "record-all-retrieve-all") {
    return results;
  }

  return results.filter((row) => {
    const sender = (row.sender_e164 as string | undefined) ?? (row.sender as string | undefined);
    const conversationId = row.conversation_id as string | undefined;
    if (isBlocked(sender, conversationId, filters)) return false;
    if (!isAllowed(sender, conversationId, filters)) return false;
    return true;
  });
}

/**
 * When filtering at query time, over-fetch to compensate for filtered-out rows.
 * Returns the adjusted limit for the DB query.
 */
export function adjustLimitForFiltering(requestedLimit: number, mode: ObserverMode): number {
  if (mode === "record-all-retrieve-all") {
    return requestedLimit;
  }
  return requestedLimit * 3;
}
