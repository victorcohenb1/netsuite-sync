import { prisma } from "./client";
import { DATASET_DEFINITIONS } from "../config/datasets";
import { logger } from "../lib/logger";

/**
 * Upserts all dataset definitions from the registry into the database.
 * Safe to run on every startup—creates missing datasets and updates existing ones.
 */
export async function seedDatasets(): Promise<void> {
  for (const def of DATASET_DEFINITIONS) {
    await prisma.dataset.upsert({
      where: { key: def.key },
      update: {
        label: def.label,
        savedSearchId: def.savedSearchId,
        extractionMode: def.extractionMode,
        targetTable: def.targetTable,
        cronSchedule: def.cronSchedule,
      },
      create: {
        key: def.key,
        label: def.label,
        savedSearchId: def.savedSearchId,
        extractionMode: def.extractionMode,
        targetTable: def.targetTable,
        cronSchedule: def.cronSchedule,
      },
    });
    logger.debug({ key: def.key }, "Dataset definition upserted");
  }
  logger.info(
    { count: DATASET_DEFINITIONS.length },
    "Dataset registry seeded"
  );
}
