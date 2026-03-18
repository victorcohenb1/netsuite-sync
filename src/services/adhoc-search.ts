import { childLogger } from "../lib/logger";
import { executeSavedSearch, restletCsvExport } from "./netsuite-client";

const log = childLogger({ module: "adhoc-search" });

export interface AdHocSearchRequest {
  searchId: string;
  pageSize?: number;
  pageIndex?: number;
  csvFallback?: boolean;
  /** If true, only return totalResults count — no rows fetched */
  countOnly?: boolean;
}

export interface AdHocSearchResponse {
  searchId: string;
  method: "STANDARD" | "CSV_RESTLET";
  usedCsvFallback: boolean;
  rowCount: number;
  totalResults: number;
  hasMore: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  durationMs: number;
  standardSearchError: string | null;
}

/**
 * Execute any saved search by ID — not tied to the dataset registry.
 * Tries SuiteTalk REST first. If that returns zero rows or fails,
 * optionally falls back to the CSV RESTlet.
 */
export async function runAdHocSearch(
  req: AdHocSearchRequest
): Promise<AdHocSearchResponse> {
  const { searchId, csvFallback = false, countOnly = false } = req;
  const pageSize = req.pageSize ?? 1000;
  const pageIndex = req.pageIndex ?? 0;

  const start = Date.now();
  let standardError: string | null = null;

  // ── Try standard SuiteTalk REST saved search ──

  log.info({ searchId, pageSize, pageIndex, csvFallback, countOnly }, "Ad-hoc search START");

  try {
    const result = await executeSavedSearch(searchId, { countOnly });

    // countOnly mode — return just the total, no rows
    if (countOnly) {
      const durationMs = Date.now() - start;
      log.info(
        { searchId, method: "STANDARD", totalResults: result.totalResults, durationMs },
        "Ad-hoc search END — countOnly"
      );
      return {
        searchId,
        method: "STANDARD",
        usedCsvFallback: false,
        rowCount: 0,
        totalResults: result.totalResults,
        hasMore: false,
        columns: [],
        rows: [],
        durationMs,
        standardSearchError: null,
      };
    }

    if (result.rows.length > 0) {
      const page = paginate(result.rows, pageSize, pageIndex);
      const durationMs = Date.now() - start;

      log.info(
        { searchId, method: "STANDARD", rowCount: result.rows.length, durationMs },
        "Ad-hoc search END — standard search succeeded"
      );

      return {
        searchId,
        method: "STANDARD",
        usedCsvFallback: false,
        rowCount: page.rows.length,
        totalResults: result.totalResults || result.rows.length,
        hasMore: page.hasMore,
        columns: result.rows.length > 0 ? Object.keys(result.rows[0]) : [],
        rows: page.rows,
        durationMs,
        standardSearchError: null,
      };
    }

    // Zero rows — fall through to CSV fallback if enabled
    standardError = "Standard search returned 0 rows";
    log.warn({ searchId }, "Ad-hoc search — standard returned 0 rows");
  } catch (err) {
    standardError = err instanceof Error ? err.message : String(err);
    log.warn(
      { searchId, error: standardError },
      "Ad-hoc search — standard search failed"
    );

    if (!csvFallback) {
      throw err;
    }
  }

  // ── CSV RESTlet fallback ──

  if (!csvFallback) {
    const durationMs = Date.now() - start;
    return {
      searchId,
      method: "STANDARD",
      usedCsvFallback: false,
      rowCount: 0,
      totalResults: 0,
      hasMore: false,
      columns: [],
      rows: [],
      durationMs,
      standardSearchError: standardError,
    };
  }

  log.info({ searchId }, "Ad-hoc search — falling back to CSV RESTlet");

  const csvResult = await restletCsvExport(searchId, `adhoc_${searchId}`);
  const page = paginate(csvResult.rows, pageSize, pageIndex);
  const durationMs = Date.now() - start;

  log.info(
    { searchId, method: "CSV_RESTLET", rowCount: csvResult.rows.length, durationMs },
    "Ad-hoc search END — CSV fallback succeeded"
  );

  return {
    searchId,
    method: "CSV_RESTLET",
    usedCsvFallback: true,
    rowCount: page.rows.length,
    totalResults: csvResult.totalResults,
    hasMore: page.hasMore,
    columns: csvResult.rows.length > 0 ? Object.keys(csvResult.rows[0]) : [],
    rows: page.rows,
    durationMs,
    standardSearchError: standardError,
  };
}

function paginate(
  allRows: Record<string, unknown>[],
  pageSize: number,
  pageIndex: number
): { rows: Record<string, unknown>[]; hasMore: boolean } {
  const startIdx = pageIndex * pageSize;
  const rows = allRows.slice(startIdx, startIdx + pageSize);
  const hasMore = startIdx + pageSize < allRows.length;
  return { rows, hasMore };
}
