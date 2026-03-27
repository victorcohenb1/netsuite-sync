import { FastifyInstance } from "fastify";
import { z } from "zod";
import { restletSinglePage, restletDebugSearch } from "../../services/netsuite-client";
import { startSync, getCacheEntry, getCacheRows } from "../../services/memory-cache";
import { prisma } from "../../db/client";
import { scheduleCachedSearch, unscheduleCachedSearch } from "../../services/scheduler";
import { syncCachedSearch } from "../../services/cached-search-sync";
import { logger } from "../../lib/logger";

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  // ── Health check ─────────────────────────────────────
  app.get("/ping-searches", async (_req, reply) => {
    return reply.send({ ok: true, message: "searches plugin is mounted" });
  });

  // ── Single page passthrough (for "Probar" button) ────
  app.post("/searches/page", async (req, reply) => {
    const body = z.object({
      searchId: z.string().min(1),
      pageIndex: z.number().int().min(0).default(0),
      pageSize: z.number().int().min(1).max(1000).default(1000),
    }).parse(req.body);

    try {
      const result = await restletSinglePage(body.searchId, body.pageIndex, body.pageSize);
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = (err as any)?.statusCode ?? 500;
      // Try to extract the RESTlet error message from the response body
      let detail = message;
      const responseBody = (err as any)?.responseBody;
      if (responseBody) {
        try {
          const parsed = JSON.parse(responseBody);
          detail = parsed?.error?.message || parsed?.message || responseBody;
        } catch {
          detail = responseBody;
        }
      }
      return reply.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).send({
        error: detail,
        searchId: body.searchId,
      });
    }
  });

  // ── Debug search (filters, columns, metadata) ──────
  app.get("/searches/:searchId/debug", async (req, reply) => {
    const { searchId } = req.params as { searchId: string };
    try {
      const result = await restletDebugSearch(searchId);
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message, searchId });
    }
  });

  // ── Start background sync ───────────────────────────
  app.post("/searches/sync", async (req, reply) => {
    const body = z.object({
      searchId: z.string().min(1),
      forceRefresh: z.boolean().optional(),
    }).parse(req.body);

    const entry = startSync(body.searchId, body.forceRefresh ?? false);

    return reply.send({
      ok: true,
      searchId: body.searchId,
      status: entry.status,
      progress: entry.progress,
      total: entry.total,
    });
  });

  // ── Check sync status ───────────────────────────────
  app.get("/searches/:searchId/status", async (req, reply) => {
    const { searchId } = z.object({ searchId: z.string().min(1) }).parse(req.params);
    const entry = getCacheEntry(searchId);

    if (!entry) {
      return reply.status(404).send({
        error: "No sync in progress. Call POST /searches/sync first.",
        searchId,
      });
    }

    return reply.send({
      searchId,
      status: entry.status,
      progress: entry.progress,
      total: entry.total,
      durationMs: entry.durationMs ?? (Date.now() - entry.startedAt),
      errorMessage: entry.errorMessage,
    });
  });

  // ── Fetch rows from memory cache ────────────────────
  app.get("/searches/:searchId/rows", async (req, reply) => {
    const { searchId } = z.object({ searchId: z.string().min(1) }).parse(req.params);
    const query = z.object({
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(50000).default(10000),
    }).parse(req.query);

    const entry = getCacheEntry(searchId);
    if (!entry) {
      return reply.status(404).send({ error: "No cached data. Call POST /searches/sync first." });
    }

    if (entry.status === "syncing") {
      return reply.status(202).send({
        status: "syncing",
        progress: entry.progress,
        total: entry.total,
        message: "Sync still in progress.",
      });
    }

    if (entry.status === "failed") {
      return reply.status(500).send({ status: "failed", errorMessage: entry.errorMessage });
    }

    const data = getCacheRows(searchId, query.offset, query.limit);
    if (!data) {
      return reply.status(404).send({ error: "Cache expired or not found." });
    }

    return reply.send(data);
  });

  // ── Register search for auto-sync ───────────────────
  // Saves to DB (survives restarts) + schedules cron + kicks off first sync
  app.post("/searches/register", async (req, reply) => {
    const body = z.object({
      searchId: z.string().min(1),
      cronSchedule: z.string().optional(),
    }).parse(req.body);

    const cron = body.cronSchedule || "0 */2 * * *";

    // Save to DB (only metadata, no rows)
    await prisma.cachedSearch.upsert({
      where: { searchId: body.searchId },
      create: {
        searchId: body.searchId,
        cronSchedule: cron,
        enabled: true,
        columns: [],
        rows: [],
        totalResults: 0,
      },
      update: {
        cronSchedule: cron,
        enabled: true,
      },
    });

    // Schedule the cron job
    scheduleCachedSearch(body.searchId, cron);

    // Kick off first sync into memory cache (non-blocking)
    syncCachedSearch(body.searchId);

    return reply.send({
      ok: true,
      searchId: body.searchId,
      cronSchedule: cron,
      status: "registered",
    });
  });

  // ── Deregister search ───────────────────────────────
  app.delete("/searches/:searchId/register", async (req, reply) => {
    const { searchId } = z.object({ searchId: z.string().min(1) }).parse(req.params);

    const existing = await prisma.cachedSearch.findUnique({ where: { searchId } });
    if (!existing) {
      return reply.status(404).send({ error: `Not found: ${searchId}` });
    }

    await prisma.cachedSearch.delete({ where: { searchId } });
    unscheduleCachedSearch(searchId);

    return reply.send({ ok: true, searchId });
  });

  // ── List registered searches ────────────────────────
  app.get("/searches/registered", async (_req, reply) => {
    const searches = await prisma.cachedSearch.findMany({
      orderBy: { searchId: "asc" },
      select: {
        searchId: true,
        cronSchedule: true,
        enabled: true,
        createdAt: true,
      },
    });

    // Enrich with memory cache status
    const enriched = searches.map((s) => {
      const cache = getCacheEntry(s.searchId);
      return {
        ...s,
        cacheStatus: cache?.status ?? "no_cache",
        cacheProgress: cache?.progress ?? 0,
        cacheTotal: cache?.total ?? 0,
        cacheCompletedAt: cache?.completedAt
          ? new Date(cache.completedAt).toISOString()
          : null,
      };
    });

    return reply.send({ searches: enriched });
  });
}
