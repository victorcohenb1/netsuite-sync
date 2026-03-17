import { env } from "./config/env";
import { logger } from "./lib/logger";
import { connectDatabase, disconnectDatabase } from "./db/client";
import { seedDatasets } from "./db/seed-datasets";
import { buildServer } from "./api/server";
import { startScheduler, stopScheduler } from "./services/scheduler";

async function main(): Promise<void> {
  logger.info({ env: env.NODE_ENV }, "Starting netsuite-sync service");

  await connectDatabase();
  await seedDatasets();

  const app = await buildServer();
  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT, host: env.HOST }, "HTTP server listening");

  await startScheduler();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    stopScheduler();
    await app.close();
    await disconnectDatabase();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (err) => {
    logger.fatal({ err }, "Unhandled rejection");
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
