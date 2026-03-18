import fetch, { Response } from "node-fetch";
import { signRequest, signRestletRequest, getSuiteQLUrl } from "./netsuite-auth";
import { env } from "../config/env";
import { childLogger } from "../lib/logger";
import { withRetry } from "../lib/retry";

const log = childLogger({ module: "netsuite-client" });

export interface SearchResult {
  rows: Record<string, unknown>[];
  totalResults: number;
  hasMore: boolean;
}

export interface CsvExportResult {
  rows: Record<string, unknown>[];
  totalResults: number;
}

class NetSuiteApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody?: string
  ) {
    super(message);
    this.name = "NetSuiteApiError";
  }
}

async function handleResponse(res: Response, context: string): Promise<unknown> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NetSuiteApiError(
      `${context}: HTTP ${res.status} ${res.statusText}`,
      res.status,
      body
    );
  }
  return res.json();
}

/**
 * Execute a SuiteQL query against NetSuite REST API with automatic pagination.
 */
export async function executeSuiteQL(
  query: string,
  limit = 1000
): Promise<Record<string, unknown>[]> {
  const allRows: Record<string, unknown>[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const url = getSuiteQLUrl();
    const paginatedQuery = `${query} OFFSET ${offset} FETCH NEXT ${limit} ROWS ONLY`;
    const headers = signRequest(url, "POST");

    const body = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { ...headers, Prefer: "transient" },
          body: JSON.stringify({ q: paginatedQuery }),
        });
        return handleResponse(res, "SuiteQL");
      },
      {
        attempts: env.SYNC_RETRY_ATTEMPTS,
        delayMs: env.SYNC_RETRY_DELAY_MS,
      },
      log
    );

    const data = body as { items?: Record<string, unknown>[]; hasMore?: boolean };
    const rows = data.items ?? [];
    allRows.push(...rows);
    hasMore = !!data.hasMore && rows.length === limit;
    offset += rows.length;

    log.debug({ offset, fetched: rows.length, hasMore }, "SuiteQL page fetched");
  }

  return allRows;
}

/**
 * Execute a saved search via the NetSuite REST Web Services API with pagination.
 */
export interface SavedSearchOptions {
  /** If true, fetch only 1 row to get totalResults count — returns fast */
  countOnly?: boolean;
}

export async function executeSavedSearch(
  searchId: string,
  options?: SavedSearchOptions
): Promise<SearchResult> {
  const countOnly = options?.countOnly ?? false;
  const allRows: Record<string, unknown>[] = [];
  let offset = 0;
  const limit = countOnly ? 1 : 1000;
  let hasMore = true;
  let totalResults = 0;
  let pageNum = 0;

  log.info({ searchId, countOnly }, "Saved search execution START");
  const searchStart = Date.now();

  while (hasMore) {
    pageNum++;
    const url = `${env.NETSUITE_REST_BASE_URL}/record/v1/search/${searchId}?limit=${limit}&offset=${offset}`;
    const headers = signRequest(url, "GET");

    log.info({ searchId, page: pageNum, offset, limit }, "Fetching saved search page");

    const body = await withRetry(
      async () => {
        const res = await fetch(url, { method: "GET", headers });
        return handleResponse(res, `SavedSearch[${searchId}]`);
      },
      {
        attempts: env.SYNC_RETRY_ATTEMPTS,
        delayMs: env.SYNC_RETRY_DELAY_MS,
      },
      log
    );

    const data = body as {
      items?: Record<string, unknown>[];
      totalResults?: number;
      hasMore?: boolean;
    };

    const rows = data.items ?? [];
    totalResults = data.totalResults ?? totalResults;

    // In countOnly mode, we just need totalResults — stop after first page
    if (countOnly) {
      const searchDuration = Date.now() - searchStart;
      log.info(
        { searchId, totalResults, durationMs: searchDuration },
        "Saved search COUNT ONLY — done after 1 request"
      );
      return { rows: [], totalResults, hasMore: false };
    }

    allRows.push(...rows);
    hasMore = !!data.hasMore && rows.length === limit;
    offset += rows.length;

    log.info(
      { searchId, page: pageNum, fetched: rows.length, cumulativeRows: allRows.length, totalResults, hasMore },
      "Saved search page received"
    );
  }

  const searchDuration = Date.now() - searchStart;
  log.info(
    { searchId, totalRows: allRows.length, totalResults, pages: pageNum, durationMs: searchDuration },
    "Saved search execution END"
  );

  return { rows: allRows, totalResults, hasMore: false };
}

/**
 * Execute search via the custom RESTlet (POST-based).
 *
 * Contract:
 *  1. POST { mode: "search", searchId, pageSize, pageIndex, csvFolderId }
 *     RESTlet tries runPaged → getRange → CSV export task.
 *     - If search succeeds: returns rows as JSON directly.
 *     - If CSV task created: { ok, mode: "csvTask", taskStatus: "PENDING", taskId, fileId }
 *
 *  2. POST { mode: "taskStatus", taskId, fileId, pageSize, pageIndex }
 *     Poll until taskStatus === "COMPLETE".
 *     COMPLETE response contains CSV rows already parsed to JSON.
 */
export async function restletCsvExport(
  searchId: string,
  datasetKey: string
): Promise<CsvExportResult> {
  const restletUrl = process.env.NETSUITE_CSV_RESTLET_URL;
  if (!restletUrl) {
    throw new Error("NETSUITE_CSV_RESTLET_URL is not configured");
  }
  const folderId = env.NETSUITE_CSV_FOLDER_ID;
  const pageSize = 1000;

  // ── Step 1: POST mode=search (with pagination) ───────

  log.info(
    { searchId, datasetKey, folderId, pageSize },
    "RESTlet CSV export — POST search START"
  );

  let allRows: Record<string, unknown>[] = [];
  let pageIndex = 0;
  let isCsvTask = false;
  let csvTaskData: Record<string, unknown> = {};

  // Paginate through direct responses from the RESTlet
  while (true) {
    const searchPayload = {
      mode: "search",
      searchId,
      pageSize,
      pageIndex,
      csvFolderId: folderId,
    };

    const searchResponse = await withRetry(
      async () => {
        const headers = signRestletRequest(restletUrl, "POST");
        const res = await fetch(restletUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(searchPayload),
        });
        return handleResponse(res, `RESTletSearch[${searchId}]`);
      },
      { attempts: env.SYNC_RETRY_ATTEMPTS, delayMs: env.SYNC_RETRY_DELAY_MS },
      log
    );

    const searchData = searchResponse as Record<string, unknown>;

    log.info(
      {
        searchId,
        pageIndex,
        responseMode: searchData.mode,
        ok: searchData.ok,
        taskStatus: searchData.taskStatus,
        hasTaskId: !!searchData.taskId,
        hasRows: Array.isArray(searchData.rows) || Array.isArray(searchData.data),
      },
      "RESTlet CSV export — POST search END"
    );

    // If RESTlet kicked off a CSV task, break out to the polling loop
    if (searchData.mode === "csvTask") {
      isCsvTask = true;
      csvTaskData = searchData;
      break;
    }

    // Direct response — collect rows and paginate
    const rows = extractRowsFromResponse(searchData);
    allRows.push(...rows);

    log.info(
      { searchId, pageIndex, pageRows: rows.length, cumulativeRows: allRows.length },
      "RESTlet CSV export — search returned rows directly"
    );

    // Stop if we got fewer rows than pageSize (last page)
    if (rows.length < pageSize) break;

    pageIndex++;

    // Safety cap to prevent infinite loops
    if (pageIndex > 500) {
      log.warn({ searchId, pageIndex }, "RESTlet CSV export — hit max page cap");
      break;
    }
  }

  // If all pages were fetched directly, return them
  if (!isCsvTask) {
    log.info(
      { searchId, totalRows: allRows.length, pages: pageIndex + 1 },
      "RESTlet CSV export — all pages fetched directly"
    );
    return { rows: allRows, totalResults: allRows.length };
  }

  const searchData = csvTaskData;

  // ── Step 2: CSV task created → poll until COMPLETE ───

  const taskId = searchData.taskId as string;
  const fileId = (searchData.fileId as string) ?? "";

  if (!taskId) {
    throw new Error(
      `RESTlet csvTask response missing taskId. Response: ${JSON.stringify(searchData)}`
    );
  }

  log.info(
    { searchId, taskId, fileId, taskStatus: searchData.taskStatus },
    "RESTlet CSV export — CSV task created, starting poll loop"
  );

  const maxWaitMs = 180_000;
  const pollIntervalMs = 5_000;
  const pollStart = Date.now();
  let pollAttempt = 0;

  while (Date.now() - pollStart < maxWaitMs) {
    pollAttempt++;
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const pollPayload = {
      mode: "taskStatus",
      taskId,
      fileId,
      pageSize,
      pageIndex: 0,
    };

    log.info(
      { taskId, pollAttempt, elapsedMs: Date.now() - pollStart },
      "RESTlet CSV export — poll POST START"
    );

    const pollResponse = await withRetry(
      async () => {
        const headers = signRestletRequest(restletUrl, "POST");
        const res = await fetch(restletUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(pollPayload),
        });
        return handleResponse(res, `RESTletPoll[${taskId}]`);
      },
      { attempts: 2, delayMs: 1000 },
      log
    );

    const pollData = pollResponse as Record<string, unknown>;
    const status = String(pollData.taskStatus ?? "UNKNOWN").toUpperCase();

    log.info(
      {
        taskId,
        pollAttempt,
        taskStatus: status,
        ok: pollData.ok,
        hasRows: Array.isArray(pollData.rows) || Array.isArray(pollData.data),
        elapsedMs: Date.now() - pollStart,
      },
      "RESTlet CSV export — poll POST END"
    );

    if (status === "COMPLETE") {
      const rows = extractRowsFromResponse(pollData);
      log.info(
        { taskId, pollAttempt, rowCount: rows.length },
        "RESTlet CSV export — task COMPLETE, rows received"
      );
      return { rows, totalResults: rows.length };
    }

    if (status === "FAILED") {
      throw new Error(
        `RESTlet CSV task ${taskId} FAILED. Response: ${JSON.stringify(pollData)}`
      );
    }

    // PENDING or PROCESSING — continue polling
  }

  throw new Error(
    `RESTlet CSV task ${taskId} timed out after ${maxWaitMs}ms (${pollAttempt} polls)`
  );
}

/**
 * Fetch a SINGLE page from the RESTlet — no accumulation, returns immediately.
 * Apps Script calls this repeatedly with incrementing pageIndex.
 */
export async function restletSinglePage(
  searchId: string,
  pageIndex: number,
  pageSize: number = 1000
): Promise<{
  rows: Record<string, unknown>[];
  columns: string[];
  total: number;
  hasMore: boolean;
  pageIndex: number;
}> {
  const restletUrl = process.env.NETSUITE_CSV_RESTLET_URL;
  if (!restletUrl) {
    throw new Error("NETSUITE_CSV_RESTLET_URL is not configured");
  }

  const payload = {
    mode: "search",
    searchId,
    pageSize,
    pageIndex,
  };

  log.info({ searchId, pageIndex, pageSize }, "RESTlet single page START");

  const response = await withRetry(
    async () => {
      const headers = signRestletRequest(restletUrl, "POST");
      const res = await fetch(restletUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      return handleResponse(res, `RESTletPage[${searchId}][${pageIndex}]`);
    },
    { attempts: env.SYNC_RETRY_ATTEMPTS, delayMs: env.SYNC_RETRY_DELAY_MS },
    log
  );

  const data = response as Record<string, unknown>;
  const rows = extractRowsFromResponse(data);
  const columns = Array.isArray(data.columns) ? (data.columns as string[]) : (rows.length > 0 ? Object.keys(rows[0]) : []);
  const total = typeof data.total === "number" ? data.total : 0;
  const hasMore = !!data.hasMore;

  log.info(
    { searchId, pageIndex, rowCount: rows.length, total, hasMore },
    "RESTlet single page END"
  );

  return { rows, columns, total, hasMore, pageIndex };
}

function extractRowsFromResponse(
  data: Record<string, unknown>
): Record<string, unknown>[] {
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.items)) return data.items;
  return [];
}
