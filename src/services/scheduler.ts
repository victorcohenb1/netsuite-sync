import cron from "node-cron";
import { SyncTrigger } from "@prisma/client";
import { prisma } from "../db/client";
import { syncDataset } from "./sync-service";
import { syncCachedSearch } from "./cached-search-sync";
import { childLogger } from "../lib/logger";

const log = childLogger({ module: "scheduler" });

const scheduledTasks: Map<string, ReturnType<typeof cron.schedule>> = new Map();

export async function startScheduler(): Promise<void> {
  // Schedule predefined datasets
  const datasets = await prisma.dataset.findMany({ where: { enabled: true } });

  for (const ds of datasets) {
    scheduleDataset(ds.key, ds.cronSchedule);
  }

  log.info(
    { scheduled: datasets.length },
    "Scheduler started for all enabled datasets"
  );

  // Schedule cached searches
  const cachedSearches = await prisma.cachedSearch.findMany({
    where: { enabled: true },
  });

  for (const cs of cachedSearches) {
    scheduleCachedSearch(cs.searchId, cs.cronSchedule);
  }

  log.info(
    { scheduled: cachedSearches.length },
    "Scheduler started for cached searches"
  );

  // Schedule sheet targets
  const sheetTargets = await prisma.sheetTarget.findMany({ where: { enabled: true } });
  for (const st of sheetTargets) {
    scheduleSheetTarget(st.id, st.cronSchedule);
  }
  log.info({ scheduled: sheetTargets.length }, "Scheduler started for sheet targets");
}

export function scheduleDataset(key: string, cronExpression: string): void {
  if (!cron.validate(cronExpression)) {
    log.error({ key, cronExpression }, "Invalid cron expression — skipping");
    return;
  }

  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    log.debug({ key }, "Stopped previous schedule");
  }

  const task = cron.schedule(cronExpression, async () => {
    log.info({ key }, "Scheduled sync triggered");
    try {
      await syncDataset(key, SyncTrigger.SCHEDULED);
    } catch (err) {
      log.error({ err, key }, "Scheduled sync failed");
    }
  });

  scheduledTasks.set(key, task);
  log.info({ key, cronExpression }, "Dataset scheduled");
}

export function scheduleCachedSearch(
  searchId: string,
  cronExpression: string
): void {
  const mapKey = `cache:${searchId}`;

  if (!cron.validate(cronExpression)) {
    log.error({ searchId, cronExpression }, "Invalid cron — skipping cached search");
    return;
  }

  const existing = scheduledTasks.get(mapKey);
  if (existing) {
    existing.stop();
  }

  const task = cron.schedule(cronExpression, async () => {
    log.info({ searchId }, "Scheduled cached search sync triggered");
    try {
      await syncCachedSearch(searchId);
    } catch (err) {
      log.error({ err, searchId }, "Scheduled cached search sync failed");
    }
  });

  scheduledTasks.set(mapKey, task);
  log.info({ searchId, cronExpression }, "Cached search scheduled");
}

export function unscheduleCachedSearch(searchId: string): void {
  const mapKey = `cache:${searchId}`;
  const existing = scheduledTasks.get(mapKey);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(mapKey);
    log.info({ searchId }, "Cached search unscheduled");
  }
}

export function scheduleSheetTarget(targetId: string, cronExpression: string): void {
  const key = `sheet:${targetId}`;

  // Stop existing if any
  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(key);
  }

  if (!cron.validate(cronExpression)) {
    log.warn({ targetId, cronExpression }, "Invalid cron expression for sheet target");
    return;
  }

  const task = cron.schedule(cronExpression, async () => {
    log.info({ targetId }, "Sheet target cron triggered");
    try {
      const { syncAndWriteToSheet } = await import("./sheet-sync-orchestrator");
      await syncAndWriteToSheet(targetId);
    } catch (err: any) {
      log.error({ targetId, error: err?.message }, "Sheet target cron failed");
    }
  });

  scheduledTasks.set(key, task);
  log.info({ targetId, cronExpression }, "Sheet target scheduled");
}

export function unscheduleSheetTarget(targetId: string): void {
  const key = `sheet:${targetId}`;
  const existing = scheduledTasks.get(key);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(key);
    log.info({ targetId }, "Sheet target unscheduled");
  }
}

export function stopScheduler(): void {
  for (const [key, task] of scheduledTasks) {
    task.stop();
    log.debug({ key }, "Schedule stopped");
  }
  scheduledTasks.clear();
  log.info("All schedules stopped");
}
