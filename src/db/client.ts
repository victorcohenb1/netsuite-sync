import { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger";

export const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === "development"
      ? [
          { emit: "event", level: "query" },
          { emit: "event", level: "warn" },
          { emit: "event", level: "error" },
        ]
      : [
          { emit: "event", level: "warn" },
          { emit: "event", level: "error" },
        ],
});

prisma.$on("warn", (e) => logger.warn(e, "Prisma warning"));
prisma.$on("error", (e) => logger.error(e, "Prisma error"));

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info("Database connected");
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info("Database disconnected");
}
