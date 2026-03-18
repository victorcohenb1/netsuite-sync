import { FastifyInstance } from "fastify";
import { z } from "zod";
import { runAdHocSearch } from "../../services/adhoc-search";
import { prisma } from "../../db/client";
import { syncCachedSearch } from "../../services/cached-search-sync";
import {
  scheduleCachedSearch,
  unscheduleCachedSearch,
} from "../../services/scheduler";
import { logger } from "../../lib/logger";

const runSearchBodySchema = z.object({
  searchId: z.string().min(1),
  pageSize: z.number().int().min(1).max(100000).optional(),
  pageIndex: z.number().int().min(0).optional(),
  csvFallback: z.boolean().optional(),
  countOnly: z.boolean().optional(),
});

const registerBodySchema = z.object({
  searchId: z.string().min(1),
  cronSchedule: z.string().optional(),
});

const searchIdParamSchema = z.object({
  searchId: z.string().min(1),
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ping-searches", async (_req, reply) => {
    return reply.send({ ok: true, message: "searches plugin is mounted" });
  });

  // ── Live search (existing) ─────────────────────────────
  app.post("/searches/run", async (req, reply) => {
    const body = runSearchBodySchema.parse(req.body);

    try {
      const result = await runAdHocSearch(body);
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({
        error: message,
        searchId: body.searchId,
      });
    }
  });

  // ── Register search for caching ────────────────────────
  app.post("/searches/register", async (req, reply) => {
    const { searchId, cronSchedule } = registerBodySchema.parse(req.body);
    const cron = cronSchedule || "0 */2 * * *";

    const record = await prisma.cachedSearch.upsert({
      where: { searchId },
      create: { searchId, cronSchedule: cron, enabled: true },
      update: { cronSchedule: cron, enabled: true },
    });

    // Schedule the cron
    scheduleCachedSearch(searchId, cron);

    // Fire initial sync (non-blocking)
    syncCachedSearch(searchId).catch((err) =>
      logger.error({ err, searchId }, "Initial cached search sync failed")
    );

    return reply.send({
      ok: true,
      searchId: record.searchId,
      status: "SYNCING",
      cronSchedule: cron,
    });
  });

  // ── Read cached search data ────────────────────────────
  app.get("/searches/:searchId/cached", async (req, reply) => {
    const { searchId } = searchIdParamSchema.parse(req.params);

    const cached = await prisma.cachedSearch.findUnique({
      where: { searchId },
    });

    if (!cached) {
      return reply.status(404).send({ error: `No cache for: ${searchId}` });
    }

    return reply.send({
      searchId: cached.searchId,
      columns: cached.columns,
      rows: cached.rows,
      totalResults: cached.totalResults,
      lastSyncAt: cached.lastSyncAt,
      syncDurationMs: cached.syncDurationMs,
      status: cached.status,
      errorMessage: cached.errorMessage,
    });
  });

  // ── Deregister cached search ───────────────────────────
  app.delete("/searches/:searchId/register", async (req, reply) => {
    const { searchId } = searchIdParamSchema.parse(req.params);

    const existing = await prisma.cachedSearch.findUnique({
      where: { searchId },
    });

    if (!existing) {
      return reply.status(404).send({ error: `Not found: ${searchId}` });
    }

    await prisma.cachedSearch.delete({ where: { searchId } });
    unscheduleCachedSearch(searchId);

    return reply.send({ ok: true, searchId });
  });

  // ── List all cached searches ───────────────────────────
  app.get("/searches/cached", async (_req, reply) => {
    const searches = await prisma.cachedSearch.findMany({
      orderBy: { searchId: "asc" },
      select: {
        searchId: true,
        totalResults: true,
        lastSyncAt: true,
        syncDurationMs: true,
        status: true,
        cronSchedule: true,
        enabled: true,
      },
    });

    return reply.send({ searches });
  });
}
