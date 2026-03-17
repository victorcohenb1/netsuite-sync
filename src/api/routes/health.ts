import { FastifyInstance } from "fastify";
import { prisma } from "../../db/client";

const BUILD_TIME = new Date().toISOString();
const BUILD_ID = `build-${Date.now()}`;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_req, reply) => {
    const start = Date.now();
    let dbOk = false;

    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const status = dbOk ? "healthy" : "degraded";
    const code = dbOk ? 200 : 503;

    return reply.status(code).send({
      app: "netsuite-sync",
      buildId: BUILD_ID,
      buildTime: BUILD_TIME,
      status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: dbOk ? "connected" : "unreachable",
      latencyMs: Date.now() - start,
    });
  });
}
