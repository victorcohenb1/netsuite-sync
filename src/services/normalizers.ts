/**
 * Each normalizer maps raw NetSuite search/CSV rows into the shape
 * expected by the corresponding Prisma model.
 * Fields not present in the raw data are left undefined (Prisma will store NULL).
 */

type RawRow = Record<string, unknown>;

function str(val: unknown): string | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  return String(val);
}

function num(val: unknown): number | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  const n = Number(val);
  return isNaN(n) ? undefined : n;
}

function date(val: unknown): Date | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  const d = new Date(String(val));
  return isNaN(d.getTime()) ? undefined : d;
}

export function normalizeCustomerOrder(row: RawRow, syncJobId: string) {
  return {
    externalId: str(row.id ?? row.internalid ?? row.internal_id),
    orderNumber: str(row.tranid ?? row.order_number ?? row.tranId),
    customerName: str(row.entity ?? row.customer_name ?? row.companyname),
    customerId: str(row.entity_id ?? row.customer_id),
    itemName: str(row.item ?? row.item_name ?? row.itemid),
    itemId: str(row.item_id ?? row.itemId),
    quantity: num(row.quantity ?? row.qty),
    rate: num(row.rate),
    amount: num(row.amount),
    status: str(row.status ?? row.statusref),
    orderDate: date(row.trandate ?? row.order_date),
    shipDate: date(row.shipdate ?? row.ship_date ?? row.expectedshipdate),
    location: str(row.location),
    memo: str(row.memo),
    rawData: row,
    syncJobId,
  };
}

export function normalizePurchaseOrder(row: RawRow, syncJobId: string) {
  return {
    externalId: str(row.id ?? row.internalid ?? row.internal_id),
    orderNumber: str(row.tranid ?? row.order_number ?? row.tranId),
    vendorName: str(row.entity ?? row.vendor_name ?? row.companyname),
    vendorId: str(row.entity_id ?? row.vendor_id),
    itemName: str(row.item ?? row.item_name ?? row.itemid),
    itemId: str(row.item_id ?? row.itemId),
    quantity: num(row.quantity ?? row.qty),
    rate: num(row.rate),
    amount: num(row.amount),
    status: str(row.status ?? row.statusref),
    orderDate: date(row.trandate ?? row.order_date),
    expectedDate: date(row.expectedreceiptdate ?? row.expected_date),
    location: str(row.location),
    memo: str(row.memo),
    rawData: row,
    syncJobId,
  };
}

export function normalizeTransferOrder(row: RawRow, syncJobId: string) {
  return {
    externalId: str(row.id ?? row.internalid ?? row.internal_id),
    orderNumber: str(row.tranid ?? row.order_number ?? row.tranId),
    fromLocation: str(row.transferlocation ?? row.from_location ?? row.location),
    toLocation: str(row.transferlocationto ?? row.to_location),
    itemName: str(row.item ?? row.item_name ?? row.itemid),
    itemId: str(row.item_id ?? row.itemId),
    quantity: num(row.quantity ?? row.qty),
    quantityShipped: num(row.quantityshiprecv ?? row.quantity_shipped),
    quantityReceived: num(row.quantityreceived ?? row.quantity_received),
    status: str(row.status ?? row.statusref),
    orderDate: date(row.trandate ?? row.order_date),
    shipDate: date(row.shipdate ?? row.ship_date),
    memo: str(row.memo),
    rawData: row,
    syncJobId,
  };
}

export function normalizeInventoryByLocation(row: RawRow, syncJobId: string) {
  return {
    externalId: str(row.id ?? row.internalid ?? row.internal_id),
    itemName: str(row.item ?? row.item_name ?? row.itemid ?? row.displayname),
    itemId: str(row.item_id ?? row.itemId ?? row.internalid),
    location: str(row.location ?? row.inventorylocation),
    locationId: str(row.location_id ?? row.locationId),
    quantityOnHand: num(row.quantityonhand ?? row.quantity_on_hand ?? row.locationquantityonhand),
    quantityAvailable: num(row.quantityavailable ?? row.quantity_available ?? row.locationquantityavailable),
    quantityOnOrder: num(row.quantityonorder ?? row.quantity_on_order ?? row.locationquantityonorder),
    quantityInTransit: num(row.quantityintransit ?? row.quantity_in_transit),
    reorderPoint: num(row.reorderpoint ?? row.reorder_point ?? row.locationreorderpoint),
    rawData: row,
    syncJobId,
  };
}

export type NormalizerFn = (row: RawRow, syncJobId: string) => Record<string, unknown>;

export const NORMALIZERS: Record<string, NormalizerFn> = {
  customer_orders_open: normalizeCustomerOrder,
  purchase_orders_open: normalizePurchaseOrder,
  transfer_orders_open: normalizeTransferOrder,
  inventory_by_location: normalizeInventoryByLocation,
};
