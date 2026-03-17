import { ExtractionMode } from "@prisma/client";
import { prisma } from "../db/client";
import { childLogger } from "../lib/logger";
import { withRetry } from "../lib/retry";
import { env } from "../config/env";
import { executeSavedSearch, restletCsvExport } from "./netsuite-client";

const log = childLogger({ module: "debug-extract" });

export interface DebugExtractResult {
  datasetKey: string;
  extractionMode: ExtractionMode;
  methodUsed: ExtractionMode;
  usedCsvFallback: boolean;
  rowCount: number;
  headers: string[];
  sampleRows: Record<string, unknown>[];
  durationMs: number;
  standardSearchAttempted: boolean;
  standardSearchRowCount: number | null;
  standardSearchError: string | null;
  csvFallbackAttempted: boolean;
  csvFallbackRowCount: number | null;
  csvFallbackError: string | null;
}

/**
 * Runs the full extraction flow for a dataset but does NOT write anything
 * to the data tables. Only reads from the dataset registry in DB.
 * Designed for phase-by-phase validation.
 */
export async function debugExtractDataset(
  datasetKey: string
): Promise<DebugExtractResult> {
  const dataset = await prisma.dataset.findUnique({ where: { key: datasetKey } });
  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetKey}`);
  }

  log.info(
    {
      datasetKey,
      savedSearchId: dataset.savedSearchId,
      extractionMode: dataset.extractionMode,
    },
    "DEBUG EXTRACT — starting dry-run extraction"
  );

  const start = Date.now();

  const result: DebugExtractResult = {
    datasetKey,
    extractionMode: dataset.extractionMode,
    methodUsed: dataset.extractionMode,
    usedCsvFallback: false,
    rowCount: 0,
    headers: [],
    sampleRows: [],
    durationMs: 0,
    standardSearchAttempted: false,
    standardSearchRowCount: null,
    standardSearchError: null,
    csvFallbackAttempted: false,
    csvFallbackRowCount: null,
    csvFallbackError: null,
  };

  if (dataset.extractionMode === ExtractionMode.CSV_EXPORT) {
    await runDebugCsvExport(dataset.savedSearchId, datasetKey, result);
    result.methodUsed = ExtractionMode.CSV_EXPORT;
    result.usedCsvFallback = true;
  } else {
    await runDebugStandardSearch(
      dataset.savedSearchId,
      dataset.extractionMode,
      datasetKey,
      result
    );
  }

  result.durationMs = Date.now() - start;

  log.info(
    {
      datasetKey,
      methodUsed: result.methodUsed,
      usedCsvFallback: result.usedCsvFallback,
      rowCount: result.rowCount,
      headerCount: result.headers.length,
      durationMs: result.durationMs,
    },
    "DEBUG EXTRACT — dry-run complete"
  );

  return result;
}

async function runDebugStandardSearch(
  savedSearchId: string,
  extractionMode: ExtractionMode,
  datasetKey: string,
  result: DebugExtractResult
): Promise<void> {
  result.standardSearchAttempted = true;

  log.info(
    { datasetKey, savedSearchId },
    "DEBUG EXTRACT — standard search START"
  );
  const searchStart = Date.now();

  try {
    const searchResult = await withRetry(
      () => executeSavedSearch(savedSearchId),
      { attempts: env.SYNC_RETRY_ATTEMPTS, delayMs: env.SYNC_RETRY_DELAY_MS },
      log
    );

    const searchDuration = Date.now() - searchStart;
    result.standardSearchRowCount = searchResult.rows.length;

    log.info(
      {
        datasetKey,
        savedSearchId,
        rowCount: searchResult.rows.length,
        totalResults: searchResult.totalResults,
        durationMs: searchDuration,
      },
      "DEBUG EXTRACT — standard search END"
    );

    const needsFallback =
      searchResult.rows.length === 0 &&
      extractionMode === ExtractionMode.STANDARD_WITH_CSV_FALLBACK;

    if (needsFallback) {
      log.warn(
        { datasetKey, savedSearchId },
        "DEBUG EXTRACT — standard search returned 0 rows, triggering CSV fallback"
      );
      await runDebugCsvExport(savedSearchId, datasetKey, result);
      result.methodUsed = ExtractionMode.CSV_EXPORT;
      result.usedCsvFallback = true;
      return;
    }

    fillResultFromRows(result, searchResult.rows);
    result.methodUsed = ExtractionMode.STANDARD;
  } catch (err) {
    const searchDuration = Date.now() - searchStart;
    const errorMsg = err instanceof Error ? err.message : String(err);
    result.standardSearchError = errorMsg;

    log.error(
      { datasetKey, savedSearchId, error: errorMsg, durationMs: searchDuration },
      "DEBUG EXTRACT — standard search FAILED"
    );

    if (extractionMode === ExtractionMode.STANDARD_WITH_CSV_FALLBACK) {
      log.warn(
        { datasetKey },
        "DEBUG EXTRACT — standard search error, triggering CSV fallback"
      );
      await runDebugCsvExport(savedSearchId, datasetKey, result);
      result.methodUsed = ExtractionMode.CSV_EXPORT;
      result.usedCsvFallback = true;
      return;
    }

    throw err;
  }
}

async function runDebugCsvExport(
  savedSearchId: string,
  datasetKey: string,
  result: DebugExtractResult
): Promise<void> {
  result.csvFallbackAttempted = true;

  log.info(
    { datasetKey, savedSearchId },
    "DEBUG EXTRACT — CSV export START"
  );
  const csvStart = Date.now();

  try {
    const csvResult = await restletCsvExport(savedSearchId, datasetKey);

    const csvDuration = Date.now() - csvStart;
    result.csvFallbackRowCount = csvResult.totalResults;

    log.info(
      {
        datasetKey,
        savedSearchId,
        rowCount: csvResult.totalResults,
        durationMs: csvDuration,
      },
      "DEBUG EXTRACT — CSV fallback END"
    );

    fillResultFromRows(result, csvResult.rows);
  } catch (err) {
    const csvDuration = Date.now() - csvStart;
    const errorMsg = err instanceof Error ? err.message : String(err);
    result.csvFallbackError = errorMsg;

    log.error(
      { datasetKey, savedSearchId, error: errorMsg, durationMs: csvDuration },
      "DEBUG EXTRACT — CSV fallback FAILED"
    );

    throw err;
  }
}

function fillResultFromRows(
  result: DebugExtractResult,
  rows: Record<string, unknown>[]
): void {
  result.rowCount = rows.length;
  result.headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  result.sampleRows = rows.slice(0, 5);
}
