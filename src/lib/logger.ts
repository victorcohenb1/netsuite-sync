import pino from "pino";
import { env } from "../config/env";

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  base: { service: "netsuite-sync" },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: pino.stdSerializers,
});

export type Logger = pino.Logger;

export function childLogger(context: Record<string, unknown>): Logger {
  return logger.child(context);
}
