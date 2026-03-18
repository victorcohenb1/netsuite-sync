import { FastifyInstance } from "fastify";
import { prisma } from "../../db/client";
import { childLogger } from "../../lib/logger";
import { syncAndWriteToSheet, syncAndWriteAllForSpreadsheet } from "../../services/sheet-sync-orchestrator";
import { scheduleSheetTarget, unscheduleSheetTarget } from "../../services/scheduler";

const log = childLogger({ module: "sheet-targets-routes" });

export async function sheetTargetRoutes(app: FastifyInstance) {

  // POST /sheet-targets — Register/upsert a sheet target
  app.post("/sheet-targets", async (req, reply) => {
    const body = req.body as any;
    const { spreadsheetId, tabName, searchId, colorHex, cronSchedule, timeZone } = body;

    if (!spreadsheetId || !tabName || !searchId) {
      return reply.status(400).send({ ok: false, error: "Missing required fields: spreadsheetId, tabName, searchId" });
    }

    const target = await prisma.sheetTarget.upsert({
      where: {
        spreadsheetId_tabName: { spreadsheetId, tabName },
      },
      create: {
        spreadsheetId,
        tabName,
        searchId,
        colorHex: colorHex || null,
        cronSchedule: cronSchedule || "0 */2 * * *",
        timeZone: timeZone || "America/Mexico_City",
        enabled: true,
      },
      update: {
        searchId,
        colorHex: colorHex || null,
        cronSchedule: cronSchedule || undefined,
        timeZone: timeZone || undefined,
        enabled: true,
      },
    });

    // Schedule the cron job
    try {
      scheduleSheetTarget(target.id, target.cronSchedule);
    } catch (err: any) {
      log.warn({ targetId: target.id, error: err?.message }, "Failed to schedule cron (will retry on next restart)");
    }

    log.info({ targetId: target.id, spreadsheetId, tabName, searchId, cronSchedule: target.cronSchedule }, "SheetTarget registered");

    return { ok: true, target };
  });

  // GET /sheet-targets — List all targets (optional filter by spreadsheetId)
  app.get("/sheet-targets", async (req, reply) => {
    const query = req.query as any;
    const where: any = {};
    if (query.spreadsheetId) where.spreadsheetId = query.spreadsheetId;

    const targets = await prisma.sheetTarget.findMany({
      where,
      include: {
        writeLogs: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      ok: true,
      targets: targets.map(t => ({
        ...t,
        lastWrite: t.writeLogs[0] || null,
        writeLogs: undefined,
      })),
    };
  });

  // DELETE /sheet-targets/:id
  app.delete("/sheet-targets/:id", async (req, reply) => {
    const { id } = req.params as any;

    try {
      unscheduleSheetTarget(id);
    } catch (e) { /* ignore */ }

    await prisma.sheetTarget.delete({ where: { id } });

    log.info({ targetId: id }, "SheetTarget deleted");
    return { ok: true, id };
  });

  // POST /sheet-targets/:id/write-now — Manual trigger
  app.post("/sheet-targets/:id/write-now", async (req, reply) => {
    const { id } = req.params as any;

    const target = await prisma.sheetTarget.findUnique({ where: { id } });
    if (!target) return reply.status(404).send({ ok: false, error: "Target not found" });

    // Run async (don't block the response)
    syncAndWriteToSheet(id).catch(err => {
      log.error({ targetId: id, error: err?.message }, "Async write-now failed");
    });

    return reply.status(202).send({ ok: true, status: "triggered", targetId: id });
  });

  // POST /sheet-targets/write-all — Trigger all targets for a spreadsheet
  app.post("/sheet-targets/write-all", async (req, reply) => {
    const body = req.body as any;
    const { spreadsheetId } = body;

    if (!spreadsheetId) {
      return reply.status(400).send({ ok: false, error: "Missing spreadsheetId" });
    }

    // Run async
    syncAndWriteAllForSpreadsheet(spreadsheetId).catch(err => {
      log.error({ spreadsheetId, error: err?.message }, "Async write-all failed");
    });

    return reply.status(202).send({ ok: true, status: "triggered", spreadsheetId });
  });

  // GET /sheet-targets/:id/logs — Write history
  app.get("/sheet-targets/:id/logs", async (req, reply) => {
    const { id } = req.params as any;
    const query = req.query as any;
    const take = Math.min(parseInt(query.limit || "20"), 100);

    const logs = await prisma.sheetWriteLog.findMany({
      where: { sheetTargetId: id },
      orderBy: { createdAt: "desc" },
      take,
    });

    return { ok: true, logs };
  });
}
