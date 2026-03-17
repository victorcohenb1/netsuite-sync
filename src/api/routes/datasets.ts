import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/client";

const keyParamSchema = z.object({ key: z.string().min(1) });

export async function datasetRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /datasets/:key — Fetch all current rows for a dataset
   */
  app.get("/datasets/:key", async (req, reply) => {
    const { key } = keyParamSchema.parse(req.params);

    const dataset = await prisma.dataset.findUnique({ where: { key } });
    if (!dataset) {
      return reply.status(404).send({ error: `Dataset not found: ${key}` });
    }

    const rows = await queryDatasetRows(dataset.targetTable);

    return reply.send({
      dataset: {
        key: dataset.key,
        label: dataset.label,
        extractionMode: dataset.extractionMode,
        enabled: dataset.enabled,
      },
      rowCount: rows.length,
      rows,
    });
  });

  /**
   * GET /datasets/:key/last-sync — Status of the most recent sync job
   */
  app.get("/datasets/:key/last-sync", async (req, reply) => {
    const { key } = keyParamSchema.parse(req.params);

    const dataset = await prisma.dataset.findUnique({ where: { key } });
    if (!dataset) {
      return reply.status(404).send({ error: `Dataset not found: ${key}` });
    }

    const lastJob = await prisma.syncJob.findFirst({
      where: { datasetId: dataset.id },
      orderBy: { createdAt: "desc" },
      include: {
        runs: { orderBy: { attempt: "asc" } },
        errors: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!lastJob) {
      return reply.send({ dataset: key, lastSync: null });
    }

    return reply.send({
      dataset: key,
      lastSync: {
        jobId: lastJob.id,
        status: lastJob.status,
        trigger: lastJob.trigger,
        startedAt: lastJob.startedAt,
        finishedAt: lastJob.finishedAt,
        durationMs: lastJob.durationMs,
        runs: lastJob.runs.map((r) => ({
          id: r.id,
          attempt: r.attempt,
          method: r.method,
          status: r.status,
          rowsFound: r.rowsFound,
          rowsWritten: r.rowsWritten,
          durationMs: r.durationMs,
        })),
        errors: lastJob.errors.map((e) => ({
          id: e.id,
          code: e.code,
          message: e.message,
          createdAt: e.createdAt,
        })),
      },
    });
  });

  /**
   * GET /datasets — List all registered datasets with last-sync summary
   */
  app.get("/datasets", async (_req, reply) => {
    const datasets = await prisma.dataset.findMany({
      orderBy: { key: "asc" },
      include: {
        syncJobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            finishedAt: true,
            durationMs: true,
          },
        },
      },
    });

    return reply.send({
      datasets: datasets.map((d) => ({
        key: d.key,
        label: d.label,
        extractionMode: d.extractionMode,
        targetTable: d.targetTable,
        cronSchedule: d.cronSchedule,
        enabled: d.enabled,
        lastSync: d.syncJobs[0] ?? null,
      })),
    });
  });
}

async function queryDatasetRows(targetTable: string): Promise<unknown[]> {
  switch (targetTable) {
    case "customer_orders_open":
      return prisma.customerOrderOpen.findMany({ orderBy: { createdAt: "desc" } });
    case "purchase_orders_open":
      return prisma.purchaseOrderOpen.findMany({ orderBy: { createdAt: "desc" } });
    case "transfer_orders_open":
      return prisma.transferOrderOpen.findMany({ orderBy: { createdAt: "desc" } });
    case "inventory_by_location":
      return prisma.inventoryByLocation.findMany({ orderBy: { createdAt: "desc" } });
    default:
      throw new Error(`Unknown target table: ${targetTable}`);
  }
}
