-- CreateEnum
CREATE TYPE "ExtractionMode" AS ENUM ('STANDARD', 'CSV_EXPORT', 'STANDARD_WITH_CSV_FALLBACK');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('SCHEDULED', 'MANUAL', 'RETRY');

-- CreateTable
CREATE TABLE "datasets" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "saved_search_id" TEXT NOT NULL,
    "extraction_mode" "ExtractionMode" NOT NULL DEFAULT 'STANDARD',
    "target_table" TEXT NOT NULL,
    "cron_schedule" TEXT NOT NULL DEFAULT '0 */4 * * *',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" "SyncTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "method" "ExtractionMode" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "rows_found" INTEGER,
    "rows_written" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_errors" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "run_id" TEXT,
    "code" TEXT,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_orders_open" (
    "id" TEXT NOT NULL,
    "external_id" TEXT,
    "order_number" TEXT,
    "customer_name" TEXT,
    "customer_id" TEXT,
    "item_name" TEXT,
    "item_id" TEXT,
    "quantity" DOUBLE PRECISION,
    "rate" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,
    "status" TEXT,
    "order_date" TIMESTAMP(3),
    "ship_date" TIMESTAMP(3),
    "location" TEXT,
    "memo" TEXT,
    "raw_data" JSONB,
    "sync_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_orders_open_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders_open" (
    "id" TEXT NOT NULL,
    "external_id" TEXT,
    "order_number" TEXT,
    "vendor_name" TEXT,
    "vendor_id" TEXT,
    "item_name" TEXT,
    "item_id" TEXT,
    "quantity" DOUBLE PRECISION,
    "rate" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,
    "status" TEXT,
    "order_date" TIMESTAMP(3),
    "expected_date" TIMESTAMP(3),
    "location" TEXT,
    "memo" TEXT,
    "raw_data" JSONB,
    "sync_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_open_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_orders_open" (
    "id" TEXT NOT NULL,
    "external_id" TEXT,
    "order_number" TEXT,
    "from_location" TEXT,
    "to_location" TEXT,
    "item_name" TEXT,
    "item_id" TEXT,
    "quantity" DOUBLE PRECISION,
    "quantity_shipped" DOUBLE PRECISION,
    "quantity_received" DOUBLE PRECISION,
    "status" TEXT,
    "order_date" TIMESTAMP(3),
    "ship_date" TIMESTAMP(3),
    "memo" TEXT,
    "raw_data" JSONB,
    "sync_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_orders_open_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_by_location" (
    "id" TEXT NOT NULL,
    "external_id" TEXT,
    "item_name" TEXT,
    "item_id" TEXT,
    "location" TEXT,
    "location_id" TEXT,
    "quantity_on_hand" DOUBLE PRECISION,
    "quantity_available" DOUBLE PRECISION,
    "quantity_on_order" DOUBLE PRECISION,
    "quantity_in_transit" DOUBLE PRECISION,
    "reorder_point" DOUBLE PRECISION,
    "raw_data" JSONB,
    "sync_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_by_location_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "datasets_key_key" ON "datasets"("key");

-- CreateIndex
CREATE INDEX "sync_jobs_dataset_id_created_at_idx" ON "sync_jobs"("dataset_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_runs_job_id_idx" ON "sync_runs"("job_id");

-- CreateIndex
CREATE INDEX "sync_errors_job_id_idx" ON "sync_errors"("job_id");

-- CreateIndex
CREATE INDEX "customer_orders_open_order_number_idx" ON "customer_orders_open"("order_number");

-- CreateIndex
CREATE INDEX "customer_orders_open_customer_id_idx" ON "customer_orders_open"("customer_id");

-- CreateIndex
CREATE INDEX "customer_orders_open_sync_job_id_idx" ON "customer_orders_open"("sync_job_id");

-- CreateIndex
CREATE INDEX "purchase_orders_open_order_number_idx" ON "purchase_orders_open"("order_number");

-- CreateIndex
CREATE INDEX "purchase_orders_open_vendor_id_idx" ON "purchase_orders_open"("vendor_id");

-- CreateIndex
CREATE INDEX "purchase_orders_open_sync_job_id_idx" ON "purchase_orders_open"("sync_job_id");

-- CreateIndex
CREATE INDEX "transfer_orders_open_order_number_idx" ON "transfer_orders_open"("order_number");

-- CreateIndex
CREATE INDEX "transfer_orders_open_sync_job_id_idx" ON "transfer_orders_open"("sync_job_id");

-- CreateIndex
CREATE INDEX "inventory_by_location_item_id_idx" ON "inventory_by_location"("item_id");

-- CreateIndex
CREATE INDEX "inventory_by_location_location_id_idx" ON "inventory_by_location"("location_id");

-- CreateIndex
CREATE INDEX "inventory_by_location_sync_job_id_idx" ON "inventory_by_location"("sync_job_id");

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "sync_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_errors" ADD CONSTRAINT "sync_errors_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "sync_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_errors" ADD CONSTRAINT "sync_errors_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
