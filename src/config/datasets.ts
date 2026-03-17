import { ExtractionMode } from "@prisma/client";

export interface DatasetDefinition {
  key: string;
  label: string;
  savedSearchId: string;
  extractionMode: ExtractionMode;
  targetTable: string;
  cronSchedule: string;
}

/**
 * Registry of all datasets synced from NetSuite.
 * Update saved search IDs to match your NetSuite environment.
 */
export const DATASET_DEFINITIONS: DatasetDefinition[] = [
  {
    key: "customer_orders_open",
    label: "Open Customer Orders",
    savedSearchId: "customsearch_open_customer_orders",
    extractionMode: ExtractionMode.STANDARD,
    targetTable: "customer_orders_open",
    cronSchedule: "0 */4 * * *",
  },
  {
    key: "purchase_orders_open",
    label: "Open Purchase Orders",
    savedSearchId: "customsearch_open_purchase_orders",
    extractionMode: ExtractionMode.STANDARD,
    targetTable: "purchase_orders_open",
    cronSchedule: "0 */4 * * *",
  },
  {
    key: "transfer_orders_open",
    label: "Open Transfer Orders",
    savedSearchId: "customsearch_netstock_outstanding_tos",
    extractionMode: ExtractionMode.CSV_EXPORT,
    targetTable: "transfer_orders_open",
    cronSchedule: "0 */4 * * *",
  },
  {
    key: "inventory_by_location",
    label: "Inventory by Location",
    savedSearchId: "customsearch_inventory_by_location",
    extractionMode: ExtractionMode.STANDARD,
    targetTable: "inventory_by_location",
    cronSchedule: "0 */2 * * *",
  },
];
