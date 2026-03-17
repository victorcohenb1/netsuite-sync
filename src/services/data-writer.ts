import { prisma } from "../db/client";
import { childLogger } from "../lib/logger";

const log = childLogger({ module: "data-writer" });

type ModelDelegate = {
  deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
  createMany: (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => Promise<{ count: number }>;
};

const TABLE_MODEL_MAP: Record<string, ModelDelegate> = {
  customer_orders_open: prisma.customerOrderOpen as unknown as ModelDelegate,
  purchase_orders_open: prisma.purchaseOrderOpen as unknown as ModelDelegate,
  transfer_orders_open: prisma.transferOrderOpen as unknown as ModelDelegate,
  inventory_by_location: prisma.inventoryByLocation as unknown as ModelDelegate,
};

/**
 * Replace-write strategy: delete all rows from previous sync for this
 * dataset, then bulk-insert the new rows. Runs inside a transaction.
 */
export async function writeDatasetRows(
  targetTable: string,
  rows: Record<string, unknown>[],
  syncJobId: string
): Promise<{ deleted: number; written: number }> {
  const model = TABLE_MODEL_MAP[targetTable];
  if (!model) {
    throw new Error(`No model mapping for target table: ${targetTable}`);
  }

  const BATCH_SIZE = 500;
  let totalWritten = 0;
  let totalDeleted = 0;

  await prisma.$transaction(async (tx) => {
    const txModel = getTransactionModel(tx, targetTable);

    const deleteResult = await txModel.deleteMany({ where: {} });
    totalDeleted = deleteResult.count;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const result = await txModel.createMany({
        data: batch,
        skipDuplicates: true,
      });
      totalWritten += result.count;
    }
  });

  log.info(
    { targetTable, syncJobId, deleted: totalDeleted, written: totalWritten },
    "Dataset rows written"
  );

  return { deleted: totalDeleted, written: totalWritten };
}

function getTransactionModel(tx: any, targetTable: string): ModelDelegate {
  const map: Record<string, ModelDelegate> = {
    customer_orders_open: tx.customerOrderOpen,
    purchase_orders_open: tx.purchaseOrderOpen,
    transfer_orders_open: tx.transferOrderOpen,
    inventory_by_location: tx.inventoryByLocation,
  };
  const model = map[targetTable];
  if (!model) throw new Error(`No tx model for: ${targetTable}`);
  return model;
}
