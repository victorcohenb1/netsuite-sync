/**
 * In-memory cache for large search results.
 *
 * Smart sync:
 *  - If cache is complete and fresh (< FRESH_TTL) → reuse immediately
 *  - If cache is complete but stale → re-sync in background
 *  - If no cache → full sync
 *  - Cache auto-expires after CACHE_TTL
 */

import { restletSinglePage } from "./netsuite-client";
import { childLogger } from "../lib/logger";

const log = childLogger({ module: "memory-cache" });

export interface CacheEntry {
  searchId: string;
  status: "syncing" | "complete" | "failed";
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  progress: number;
  startedAt: number;
  completedAt?: number;
  errorMessage?: string;
  durationMs?: number;
}

const cache = new Map<string, CacheEntry>();

// Cache keeps data for 2 hours max
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

// Data is considered "fresh" for 30 minutes — no re-sync needed
const FRESH_TTL_MS = 30 * 60 * 1000;

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.status !== "syncing" && entry.completedAt && now - entry.completedAt > CACHE_TTL_MS) {
      log.info({ searchId: key }, "Cache entry expired, removing");
      cache.delete(key);
    }
  }
}

export function getCacheEntry(searchId: string): CacheEntry | undefined {
  cleanExpired();
  return cache.get(searchId);
}

export function getCacheRows(
  searchId: string,
  offset: number,
  limit: number
): { rows: Record<string, unknown>[]; columns: string[]; total: number; hasMore: boolean } | null {
  const entry = cache.get(searchId);
  if (!entry || entry.status !== "complete") return null;

  const rows = entry.rows.slice(offset, offset + limit);
  return {
    rows,
    columns: entry.columns,
    total: entry.total,
    hasMore: offset + limit < entry.total,
  };
}

/**
 * Start a background sync for a search.
 *
 * Smart logic:
 *  - Already syncing → return current progress
 *  - Complete + fresh (< 30 min) → return immediately, no re-sync
 *  - Complete + stale (> 30 min) → start new sync in background
 *  - No cache / failed → start new sync
 *
 * forceRefresh: true → always re-sync even if fresh
 */
export function startSync(searchId: string, forceRefresh = false): CacheEntry {
  const existing = cache.get(searchId);

  // Already syncing → just return progress
  if (existing && existing.status === "syncing") {
    return existing;
  }

  // Complete + fresh → reuse without re-downloading
  if (
    existing &&
    existing.status === "complete" &&
    existing.completedAt &&
    !forceRefresh
  ) {
    const ageMs = Date.now() - existing.completedAt;
    if (ageMs < FRESH_TTL_MS) {
      log.info(
        { searchId, ageMs, totalRows: existing.total },
        "Cache is fresh, reusing existing data (no re-sync)"
      );
      return existing;
    }
  }

  // Need a new sync
  const entry: CacheEntry = {
    searchId,
    status: "syncing",
    columns: [],
    rows: [],
    total: 0,
    progress: 0,
    startedAt: Date.now(),
  };

  cache.set(searchId, entry);

  // Fire and forget
  syncAllPages(searchId, entry).catch((err) => {
    log.error({ err, searchId }, "Background sync failed");
    entry.status = "failed";
    entry.errorMessage = err instanceof Error ? err.message : String(err);
    entry.durationMs = Date.now() - entry.startedAt;
  });

  return entry;
}

async function syncAllPages(searchId: string, entry: CacheEntry): Promise<void> {
  const PAGE_SIZE = 1000;
  const PARALLEL_PAGES = 2;

  log.info({ searchId, parallelPages: PARALLEL_PAGES }, "Background sync START (parallel)");

  // First page: get total count and columns
  const firstPage = await restletSinglePage(searchId, 0, PAGE_SIZE);
  entry.columns = firstPage.columns;
  entry.total = firstPage.total;
  entry.rows.push(...firstPage.rows);
  entry.progress = entry.rows.length;

  if (!firstPage.hasMore || firstPage.rows.length < PAGE_SIZE) {
    entry.status = "complete";
    entry.completedAt = Date.now();
    entry.durationMs = entry.completedAt - entry.startedAt;
    entry.total = entry.rows.length;
    log.info({ searchId, totalRows: entry.rows.length }, "Background sync COMPLETE (single page)");
    return;
  }

  const totalPages = Math.ceil(entry.total / PAGE_SIZE);
  let nextPage = 1;

  log.info({ searchId, totalPages, total: entry.total }, "Starting parallel page fetching");

  while (nextPage < totalPages) {
    const batchEnd = Math.min(nextPage + PARALLEL_PAGES, totalPages);
    const promises = [];

    for (let p = nextPage; p < batchEnd; p++) {
      promises.push(
        restletSinglePage(searchId, p, PAGE_SIZE).catch(async (err) => {
          log.warn({ searchId, pageIndex: p, error: String(err) }, "Page failed, retrying after delay");
          await new Promise((r) => setTimeout(r, 5000));
          return restletSinglePage(searchId, p, PAGE_SIZE).catch(() => null);
        })
      );
    }

    const results = await Promise.all(promises);

    for (const result of results) {
      if (result && result.rows) {
        entry.rows.push(...result.rows);
      }
    }

    entry.progress = entry.rows.length;
    nextPage = batchEnd;

    log.info(
      { searchId, pagesCompleted: nextPage, totalPages, progress: entry.progress, total: entry.total },
      "Background sync batch complete"
    );

    if (nextPage > 500) {
      log.warn({ searchId }, "Hit max page cap");
      break;
    }
  }

  entry.status = "complete";
  entry.completedAt = Date.now();
  entry.durationMs = entry.completedAt - entry.startedAt;
  entry.total = entry.rows.length;

  log.info(
    { searchId, totalRows: entry.rows.length, durationMs: entry.durationMs, pages: nextPage },
    "Background sync COMPLETE"
  );
}
