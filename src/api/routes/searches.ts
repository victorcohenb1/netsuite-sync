import { FastifyInstance } from "fastify";
import { z } from "zod";
import { restletSinglePage } from "../../services/netsuite-client";
import { startSync, getCacheEntry, getCacheRows } from "../../services/memory-cache";
import { logger } from "../../lib/logger";

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  // ── Health check ─────────────────────────────────────
  app.get("/ping-searches", async (_req, reply) => {
    return reply.send({ ok: true, message: "searches plugin is mounted" });
  });

  // ── Single page passthrough (for "Probar" button) ────
  // Fetches 1 page from RESTlet. Used for quick metadata probe.
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
      return reply.status(500).send({ error: message, searchId: body.searchId });
    }
  });

  // ── Start background sync ───────────────────────────
  // Triggers async download of ALL pages from RESTlet into memory.
  // Returns immediately. Poll /searches/:id/status for progress.
  //
  // Smart behavior:
  //   - If data is fresh (< 30 min) → returns "complete" instantly, no re-download
  //   - If data is stale or missing → starts new sync in background
  //   - forceRefresh: true → always re-download from NetSuite
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
        error: "No sync in progress for this search. Call POST /searches/sync first.",
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
  // Only works after sync is complete.
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
        message: "Sync still in progress. Try again shortly.",
      });
    }

    if (entry.status === "failed") {
      return reply.status(500).send({
        status: "failed",
        errorMessage: entry.errorMessage,
      });
    }

    const data = getCacheRows(searchId, query.offset, query.limit);
    if (!data) {
      return reply.status(404).send({ error: "Cache expired or not found." });
    }

    return reply.send(data);
  });
}
