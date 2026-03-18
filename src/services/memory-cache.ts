/**
 * In-memory cache for large search results.
 *
 * Flow:
 *  1. Apps Script calls POST /searches/sync → triggers background download
 *  2. Backend downloads all pages from RESTlet (no timeout pressure)
 *  3. Apps Script polls GET /searches/:id/status every 10s
 *  4. When done, Apps Script fetches GET /searches/:id/rows?offset=0&limit=10000
 *  5. Cache auto-expires after 30 minutes
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
  progress: number;       // rows fetched so far
  startedAt: number;      // Date.now()
  completedAt?: number;
  errorMessage?: string;
  durationMs?: number;
}

// In-memory store — survives as long as the process runs
const cache = new Map<string, CacheEntry>();

// Auto-expire after 30 minutes
const CACHE_TTL_MS = 30 * 60 * 1000;

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.status !== "syncing" && now - entry.startedAt > CACHE_TTL_MS) {
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
 * Downloads all pages from the RESTlet sequentially and stores in memory.
 * Returns immediately — caller should poll status.
 */
export function startSync(searchId: string): CacheEntry {
  // If already syncing, return current status
  const existing = cache.get(searchId);
  if (existing && existing.status === "syncing") {
    return existing;
  }

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

  // Fire and forget — runs in background
  syncAllPages(searchId, entry).catch((err) => {
    log.error({ err, searchId }, "Background sync failed");
    entry.status = "failed";
    entry.errorMessage = err instanceof Error ? err.message : String(err);
    entry.durationMs = Date.now() - entry.startedAt;
  });

  return entry;
}

async function syncAllPages(searchId: string, entry: CacheEntry): Promise<void> {
  let pageIndex = 0;
  let hasMore = true;
  const PAGE_SIZE = 1000;

  log.info({ searchId }, "Background sync START");

  while (hasMore) {
    try {
      const page = await restletSinglePage(searchId, pageIndex, PAGE_SIZE);

      if (pageIndex === 0) {
        entry.columns = page.columns;
        entry.total = page.total;
      }

      entry.rows.push(...page.rows);
      entry.progress = entry.rows.length;
      hasMore = page.hasMore;

      log.info(
        { searchId, pageIndex, pageRows: page.rows.length, progress: entry.progress, total: entry.total },
        "Background sync page fetched"
      );

      pageIndex++;

      // Safety cap
      if (pageIndex > 500) {
        log.warn({ searchId, pageIndex }, "Background sync hit max page cap");
        break;
      }
    } catch (err) {
      // Retry once after 3 seconds
      log.warn({ searchId, pageIndex, error: String(err) }, "Page fetch failed, retrying in 3s");
      await new Promise((r) => setTimeout(r, 3000));

      try {
        const page = await restletSinglePage(searchId, pageIndex, PAGE_SIZE);
        if (pageIndex === 0) {
          entry.columns = page.columns;
          entry.total = page.total;
        }
        entry.rows.push(...page.rows);
        entry.progress = entry.rows.length;
        hasMore = page.hasMore;
        pageIndex++;
      } catch (retryErr) {
        throw retryErr; // Give up after 1 retry
      }
    }
  }

  entry.status = "complete";
  entry.completedAt = Date.now();
  entry.durationMs = entry.completedAt - entry.startedAt;
  entry.total = entry.rows.length; // Use actual count

  log.info(
    { searchId, totalRows: entry.rows.length, durationMs: entry.durationMs, pages: pageIndex },
    "Background sync COMPLETE"
  );
}
