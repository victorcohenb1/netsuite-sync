import { prisma } from "../db/client";
import { childLogger } from "../lib/logger";
import { startSync, getCacheEntry, getCacheRows } from "./memory-cache";
import { writeToSheet } from "./sheets-writer";

const log = childLogger({ module: "sheet-sync-orchestrator" });

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_TIME_MS = 3600000; // 60 minutes

export async function syncAndWriteToSheet(sheetTargetId: string): Promise<void> {
  const target = await prisma.sheetTarget.findUnique({ where: { id: sheetTargetId } });
  if (!target) throw new Error(`SheetTarget not found: ${sheetTargetId}`);
  if (!target.enabled) {
    log.info({ sheetTargetId }, "SheetTarget is disabled, skipping");
    return;
  }

  // Create write log
  const writeLog = await prisma.sheetWriteLog.create({
    data: { sheetTargetId, status: "RUNNING" },
  });

  const startTime = Date.now();

  try {
    log.info({ sheetTargetId, searchId: target.searchId, spreadsheetId: target.spreadsheetId, tabName: target.tabName }, "Starting sync+write");

    // Step 1: Trigger sync in memory cache
    startSync(target.searchId, false);

    // Step 2: Poll until complete
    const pollStart = Date.now();
    while (Date.now() - pollStart < MAX_POLL_TIME_MS) {
      const entry = getCacheEntry(target.searchId);

      if (entry?.status === "complete") {
        break;
      }

      if (entry?.status === "failed") {
        throw new Error(`Sync failed: ${entry.errorMessage || "unknown error"}`);
      }

      log.debug({ searchId: target.searchId, status: entry?.status, progress: entry?.progress, total: entry?.total }, "Polling sync status");

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Verify complete
    const finalEntry = getCacheEntry(target.searchId);
    if (!finalEntry || finalEntry.status !== "complete") {
      throw new Error(`Sync timed out after ${MAX_POLL_TIME_MS / 1000}s. Status: ${finalEntry?.status || "unknown"}`);
    }

    // Step 3: Read all rows from cache
    const allRows: Record<string, string>[] = [];
    let headers: string[] = [];
    let offset = 0;
    const CHUNK_SIZE = 10000;
    let hasMore = true;

    while (hasMore) {
      const chunk = getCacheRows(target.searchId, offset, CHUNK_SIZE);
      if (!chunk || !chunk.rows || chunk.rows.length === 0) break;

      if (offset === 0) {
        headers = chunk.columns || [];
      }

      allRows.push(...(chunk.rows as Record<string, string>[]));
      hasMore = !!chunk.hasMore;
      offset += chunk.rows.length;
    }

    if (allRows.length === 0) {
      throw new Error("No rows found in cache after sync completed");
    }

    log.info({ searchId: target.searchId, totalRows: allRows.length, columns: headers.length }, "Data fetched from cache");

    // Step 4: Write to Google Sheet
    const result = await writeToSheet({
      spreadsheetId: target.spreadsheetId,
      tabName: target.tabName,
      headers,
      rows: allRows,
      colorHex: target.colorHex,
      timeZone: target.timeZone,
    });

    // Step 5: Update write log with success
    const durationMs = Date.now() - startTime;
    await prisma.sheetWriteLog.update({
      where: { id: writeLog.id },
      data: {
        status: "COMPLETED",
        rowsWritten: result.rowsWritten,
        durationMs,
      },
    });

    log.info({ sheetTargetId, rowsWritten: result.rowsWritten, durationMs }, "Sync+write completed successfully");

  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err?.message || String(err);

    await prisma.sheetWriteLog.update({
      where: { id: writeLog.id },
      data: {
        status: "FAILED",
        durationMs,
        errorMessage,
      },
    });

    log.error({ sheetTargetId, error: errorMessage, durationMs }, "Sync+write failed");
    throw err;
  }
}

export async function syncAndWriteAllForSpreadsheet(spreadsheetId: string): Promise<void> {
  const targets = await prisma.sheetTarget.findMany({
    where: { spreadsheetId, enabled: true },
  });

  log.info({ spreadsheetId, targetCount: targets.length }, "Writing all targets for spreadsheet");

  for (const target of targets) {
    try {
      await syncAndWriteToSheet(target.id);
    } catch (err: any) {
      log.error({ sheetTargetId: target.id, tabName: target.tabName, error: err?.message }, "Failed to write target (continuing with others)");
    }
  }
}
