import { FastifyInstance } from "fastify";
import { z } from "zod";
import { SyncTrigger } from "@prisma/client";
import { syncDataset, syncAllDatasets } from "../../services/sync-service";

const keyParamSchema = z.object({ key: z.string().min(1) });

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /sync/:key — Trigger a manual sync for a single dataset
   */
  app.post("/sync/:key", async (req, reply) => {
    const { key } = keyParamSchema.parse(req.params);

    const result = await syncDataset(key, SyncTrigger.MANUAL);

    const statusCode = result.status === "COMPLETED" ? 200 : 500;
    return reply.status(statusCode).send(result);
  });

  /**
   * POST /sync/all — Trigger a manual sync for all enabled datasets
   */
  app.post("/sync/all", async (_req, reply) => {
    const results = await syncAllDatasets(SyncTrigger.MANUAL);

    const failed = results.filter((r) => r.status === "FAILED");
    const statusCode = failed.length === 0 ? 200 : 207;

    return reply.status(statusCode).send({
      total: results.length,
      completed: results.filter((r) => r.status === "COMPLETED").length,
      failed: failed.length,
      results,
    });
  });
}
