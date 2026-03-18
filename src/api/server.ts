import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { healthRoutes } from "./routes/health";
import { datasetRoutes } from "./routes/datasets";
import { syncRoutes } from "./routes/sync";
import { debugRoutes } from "./routes/debug";
import { searchRoutes } from "./routes/searches";
import { sheetTargetRoutes } from "./routes/sheet-targets";

export async function buildServer() {
  const app = Fastify({
    logger: false,
    requestTimeout: 300_000,
  });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  app.addHook("onRequest", (req, _reply, done) => {
    logger.info({ method: req.method, url: req.url }, "Incoming request");
    done();
  });

  app.addHook("onResponse", (req, reply, done) => {
    logger.info(
      {
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      "Request completed"
    );
    done();
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    logger.error(
      { err, method: req.method, url: req.url },
      "Unhandled error"
    );

    const statusCode = err.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: err.message,
      statusCode,
      ...(env.NODE_ENV === "development" ? { stack: err.stack } : {}),
    });
  });

  await app.register(healthRoutes);
  await app.register(datasetRoutes);
  await app.register(syncRoutes);
  await app.register(debugRoutes);
  await app.register(searchRoutes);
  await app.register(sheetTargetRoutes);

  app.get("/routes", async (_req, reply) => {
    return reply.send({
      routes: app.printRoutes({ commonPrefix: false }),
    });
  });

  // Log all registered routes on startup for debugging deploys
  app.addHook("onReady", () => {
    logger.info("=== REGISTERED ROUTES ===");
    logger.info(app.printRoutes({ commonPrefix: false }));
    logger.info("=========================");
  });

  return app;
}
