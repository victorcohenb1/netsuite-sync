import { FastifyInstance } from "fastify";
import { z } from "zod";
import { runAdHocSearch } from "../../services/adhoc-search";

const runSearchBodySchema = z.object({
  searchId: z.string().min(1),
  pageSize: z.number().int().min(1).max(10000).optional(),
  pageIndex: z.number().int().min(0).optional(),
  csvFallback: z.boolean().optional(),
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /searches/run
   *
   * Execute any NetSuite saved search by ID.
   * Not tied to the dataset registry — supports ad-hoc searches
   * from Google Sheets sidebar or any other client.
   */
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
}
