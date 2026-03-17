import { ExtractionMode, SyncStatus, SyncTrigger, Dataset } from "@prisma/client";
import { prisma } from "../db/client";
import { childLogger } from "../lib/logger";
import { withRetry } from "../lib/retry";
import { env } from "../config/env";
import { executeSavedSearch, restletCsvExport } from "./netsuite-client";
import { NORMALIZERS } from "./normalizers";
import { writeDatasetRows } from "./data-writer";

const log = childLogger({ module: "sync-service" });

export interface SyncResult {
  jobId: string;
  datasetKey: string;
  status: SyncStatus;
  method: ExtractionMode;
  rowsFound: number;
  rowsWritten: number;
  durationMs: number;
  error?: string;
}

export async function syncDataset(
  datasetKey: string,
  trigger: SyncTrigger = SyncTrigger.MANUAL
): Promise<SyncResult> {
  const dataset = await prisma.dataset.findUnique({ where: { key: datasetKey } });
  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetKey}`);
  }
  if (!dataset.enabled) {
    throw new Error(`Dataset is disabled: ${datasetKey}`);
  }

  const normalizer = NORMALIZERS[dataset.key];
  if (!normalizer) {
    throw new Error(`No normalizer registered for dataset: ${dataset.key}`);
  }

  const job = await prisma.syncJob.create({
    data: {
      datasetId: dataset.id,
      status: SyncStatus.RUNNING,
      trigger,
      startedAt: new Date(),
    },
  });

  const startTime = Date.now();

  try {
    const result = await executeExtraction(dataset, job.id, normalizer);
    const durationMs = Date.now() - startTime;

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: SyncStatus.COMPLETED,
        finishedAt: new Date(),
        durationMs,
      },
    });

    log.info(
      { datasetKey, jobId: job.id, ...result, durationMs },
      "Sync completed"
    );

    return {
      jobId: job.id,
      datasetKey,
      status: SyncStatus.COMPLETED,
      method: result.method,
      rowsFound: result.rowsFound,
      rowsWritten: result.rowsWritten,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: SyncStatus.FAILED,
        finishedAt: new Date(),
        durationMs,
      },
    });

    await prisma.syncError.create({
      data: {
        jobId: job.id,
        code: "SYNC_FAILED",
        message: errorMessage,
        stack: err instanceof Error ? err.stack : undefined,
        context: { datasetKey, trigger },
      },
    });

    log.error({ err, datasetKey, jobId: job.id, durationMs }, "Sync failed");

    return {
      jobId: job.id,
      datasetKey,
      status: SyncStatus.FAILED,
      method: dataset.extractionMode,
      rowsFound: 0,
      rowsWritten: 0,
      durationMs,
      error: errorMessage,
    };
  }
}

async function executeExtraction(
  dataset: Dataset,
  jobId: string,
  normalizer: (row: Record<string, unknown>, syncJobId: string) => Record<string, unknown>
): Promise<{ method: ExtractionMode; rowsFound: number; rowsWritten: number }> {
  const { extractionMode, savedSearchId, targetTable, key } = dataset;

  if (extractionMode === ExtractionMode.CSV_EXPORT) {
    return runCsvExport(savedSearchId, targetTable, jobId, normalizer, key);
  }

  // STANDARD or STANDARD_WITH_CSV_FALLBACK: try standard first
  const run = await prisma.syncRun.create({
    data: {
      jobId,
      attempt: 1,
      method: ExtractionMode.STANDARD,
      status: SyncStatus.RUNNING,
    },
  });

  try {
    const searchResult = await withRetry(
      () => executeSavedSearch(savedSearchId),
      { attempts: env.SYNC_RETRY_ATTEMPTS, delayMs: env.SYNC_RETRY_DELAY_MS },
      log
    );

    const zeroResultsButFallbackAvailable =
      searchResult.rows.length === 0 &&
      extractionMode === ExtractionMode.STANDARD_WITH_CSV_FALLBACK;

    if (zeroResultsButFallbackAvailable) {
      log.warn(
        { datasetKey: key, searchId: savedSearchId },
        "Standard search returned 0 rows — falling back to CSV export"
      );

      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          status: SyncStatus.COMPLETED,
          rowsFound: 0,
          rowsWritten: 0,
          finishedAt: new Date(),
          durationMs: 0,
        },
      });

      return runCsvExport(savedSearchId, targetTable, jobId, normalizer, key, 2);
    }

    const normalizedRows = searchResult.rows.map((r) => normalizer(r, jobId));
    const { written } = await writeDatasetRows(targetTable, normalizedRows, jobId);

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: SyncStatus.COMPLETED,
        rowsFound: searchResult.rows.length,
        rowsWritten: written,
        finishedAt: new Date(),
        durationMs: Date.now() - run.startedAt.getTime(),
      },
    });

    return {
      method: ExtractionMode.STANDARD,
      rowsFound: searchResult.rows.length,
      rowsWritten: written,
    };
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: SyncStatus.FAILED, finishedAt: new Date() },
    });

    await prisma.syncError.create({
      data: {
        jobId,
        runId: run.id,
        code: "STANDARD_EXTRACTION_FAILED",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    });

    if (extractionMode === ExtractionMode.STANDARD_WITH_CSV_FALLBACK) {
      log.warn(
        { err, datasetKey: key },
        "Standard extraction failed — falling back to CSV export"
      );
      return runCsvExport(savedSearchId, targetTable, jobId, normalizer, key, 2);
    }

    throw err;
  }
}

async function runCsvExport(
  savedSearchId: string,
  targetTable: string,
  jobId: string,
  normalizer: (row: Record<string, unknown>, syncJobId: string) => Record<string, unknown>,
  datasetKey: string,
  attempt = 1
): Promise<{ method: ExtractionMode; rowsFound: number; rowsWritten: number }> {
  const run = await prisma.syncRun.create({
    data: {
      jobId,
      attempt,
      method: ExtractionMode.CSV_EXPORT,
      status: SyncStatus.RUNNING,
    },
  });

  try {
    const csvResult = await restletCsvExport(savedSearchId, datasetKey);

    const normalizedRows = csvResult.rows.map((r) => normalizer(r, jobId));
    const { written } = await writeDatasetRows(targetTable, normalizedRows, jobId);

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: SyncStatus.COMPLETED,
        rowsFound: csvResult.totalResults,
        rowsWritten: written,
        finishedAt: new Date(),
        durationMs: Date.now() - run.startedAt.getTime(),
      },
    });

    log.info(
      { datasetKey, method: "CSV_EXPORT", rowsFound: csvResult.totalResults, written },
      "CSV export extraction completed"
    );

    return {
      method: ExtractionMode.CSV_EXPORT,
      rowsFound: csvResult.totalResults,
      rowsWritten: written,
    };
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: SyncStatus.FAILED, finishedAt: new Date() },
    });

    await prisma.syncError.create({
      data: {
        jobId,
        runId: run.id,
        code: "CSV_EXPORT_FAILED",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    });

    throw err;
  }
}

export async function syncAllDatasets(
  trigger: SyncTrigger = SyncTrigger.MANUAL
): Promise<SyncResult[]> {
  const datasets = await prisma.dataset.findMany({
    where: { enabled: true },
    orderBy: { key: "asc" },
  });

  log.info({ count: datasets.length }, "Starting sync for all datasets");

  const results: SyncResult[] = [];
  for (const ds of datasets) {
    const result = await syncDataset(ds.key, trigger);
    results.push(result);
  }

  return results;
}
