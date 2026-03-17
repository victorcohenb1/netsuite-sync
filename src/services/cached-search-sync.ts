import { prisma } from "../db/client";
import { runAdHocSearch } from "./adhoc-search";
import { childLogger } from "../lib/logger";

const log = childLogger({ module: "cached-search-sync" });

export async function syncCachedSearch(searchId: string): Promise<void> {
  // Soft lock: skip if already syncing (within last 10 min)
  const current = await prisma.cachedSearch.findUnique({ where: { searchId } });
  if (!current) return;

  if (
    current.status === "SYNCING" &&
    current.updatedAt.getTime() > Date.now() - 10 * 60 * 1000
  ) {
    log.info({ searchId }, "Skipping — already syncing");
    return;
  }

  await prisma.cachedSearch.update({
    where: { searchId },
    data: { status: "SYNCING" },
  });

  const start = Date.now();

  try {
    const result = await runAdHocSearch({
      searchId,
      pageSize: 100000,
      pageIndex: 0,
      csvFallback: true,
    });

    await prisma.cachedSearch.update({
      where: { searchId },
      data: {
        columns: result.columns as unknown as any,
        rows: result.rows as unknown as any,
        totalResults: result.totalResults,
        lastSyncAt: new Date(),
        syncDurationMs: Date.now() - start,
        status: "IDLE",
        errorMessage: null,
      },
    });

    log.info(
      { searchId, rows: result.rows.length, durationMs: Date.now() - start },
      "Cached search synced"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.cachedSearch.update({
      where: { searchId },
      data: {
        status: "FAILED",
        errorMessage: msg,
        syncDurationMs: Date.now() - start,
      },
    });
    log.error({ err, searchId }, "Cached search sync failed");
  }
}
