/**
 * Scheduled sync for cached searches.
 * Uses the in-memory cache (not DB) to store results.
 * The scheduler calls this periodically to keep data fresh.
 */

import { startSync, getCacheEntry } from "./memory-cache";
import { childLogger } from "../lib/logger";

const log = childLogger({ module: "cached-search-sync" });

export async function syncCachedSearch(searchId: string): Promise<void> {
  const existing = getCacheEntry(searchId);

  // Skip if already syncing
  if (existing && existing.status === "syncing") {
    log.info({ searchId }, "Skipping — already syncing in memory cache");
    return;
  }

  log.info({ searchId }, "Scheduled sync: starting memory cache sync");

  // forceRefresh = true so it always re-downloads fresh data
  startSync(searchId, true);

  // Don't await — it runs in background. The scheduler just kicks it off.
  log.info({ searchId }, "Scheduled sync: background sync triggered");
}
