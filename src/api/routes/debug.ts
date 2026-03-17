import { FastifyInstance } from "fastify";
import { z } from "zod";
import { debugExtractDataset } from "../../services/debug-extract";

const ALLOWED_KEYS = new Set(["transfer_orders_open"]);

const keyParamSchema = z.object({ key: z.string().min(1) });

export async function debugRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /debug/datasets/:key/raw
   *
   * Runs extraction against NetSuite but does NOT write to DB.
   * Returns raw rows, headers, timing, and fallback metadata.
   * Currently restricted to transfer_orders_open for phased validation.
   */
  app.get("/debug/datasets/:key/raw", async (req, reply) => {
    const { key } = keyParamSchema.parse(req.params);

    if (!ALLOWED_KEYS.has(key)) {
      return reply.status(403).send({
        error: `Debug extraction not enabled for dataset: ${key}`,
        allowedKeys: Array.from(ALLOWED_KEYS),
      });
    }

    try {
      const result = await debugExtractDataset(key);
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({
        error: message,
        datasetKey: key,
      });
    }
  });
}
