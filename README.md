# NetSuite Sync

Production backend that extracts data from NetSuite saved searches, stores it in PostgreSQL, and exposes a REST API for downstream consumers (Google Sheets, dashboards, etc.).

## Architecture

```
NetSuite  ──►  Extractor Service  ──►  PostgreSQL  ──►  REST API  ──►  Google Sheets
                (this project)          (Supabase)
```

**Datasets synced:**
| Key | Description | Default schedule |
|-----|-------------|-----------------|
| `customer_orders_open` | Open customer/sales orders | Every 4 hours |
| `purchase_orders_open` | Open purchase orders | Every 4 hours |
| `transfer_orders_open` | Open transfer orders (CSV fallback) | Every 4 hours |
| `inventory_by_location` | Inventory levels by location | Every 2 hours |

## Prerequisites

- Node.js >= 20
- PostgreSQL 15+ (or Supabase)
- NetSuite account with Token-Based Authentication (TBA) configured
- A RESTlet deployed for CSV export fallback (for transfer orders)

## Quick Start

### 1. Clone and install

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Start PostgreSQL (Docker)

```bash
docker compose up db -d
```

### 4. Run migrations

```bash
npx prisma migrate dev
```

### 5. Start development server

```bash
npm run dev
```

The server starts at `http://localhost:3000`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with DB status |
| `GET` | `/datasets` | List all registered datasets |
| `GET` | `/datasets/:key` | Fetch all rows for a dataset |
| `GET` | `/datasets/:key/last-sync` | Last sync job details |
| `POST` | `/sync/:key` | Trigger manual sync for one dataset |
| `POST` | `/sync/all` | Trigger manual sync for all datasets |

### Example: trigger a sync

```bash
curl -X POST http://localhost:3000/sync/customer_orders_open
```

### Example: get dataset rows

```bash
curl http://localhost:3000/datasets/inventory_by_location
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run db:migrate` | Run Prisma migrations (dev) |
| `npm run db:migrate:prod` | Deploy migrations (production) |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:studio` | Open Prisma Studio |
| `npm run lint` | Type-check without emitting |

## Production Deployment (Docker)

```bash
# Build and start all services
docker compose up --build -d

# Migrations run automatically on startup
```

The `docker-compose.yml` includes PostgreSQL and the app. For Supabase, point `DATABASE_URL` at your Supabase connection string and remove the `db` service.

## Project Structure

```
src/
├── index.ts                    # Entrypoint: boot DB, seed, server, scheduler
├── config/
│   ├── env.ts                  # Zod-validated environment config
│   └── datasets.ts             # Dataset registry definitions
├── db/
│   ├── client.ts               # Prisma client singleton
│   └── seed-datasets.ts        # Upsert dataset definitions on startup
├── lib/
│   ├── logger.ts               # Pino structured logger
│   └── retry.ts                # Generic retry with exponential backoff
├── services/
│   ├── netsuite-auth.ts        # OAuth 1.0 request signing
│   ├── netsuite-client.ts      # Search execution + CSV export + polling
│   ├── normalizers.ts          # Raw row → Prisma model mappers
│   ├── data-writer.ts          # Bulk write with replace strategy
│   ├── sync-service.ts         # Orchestrates extraction → normalize → write
│   └── scheduler.ts            # node-cron job management
└── api/
    ├── server.ts               # Fastify app builder
    └── routes/
        ├── health.ts           # GET /health
        ├── datasets.ts         # GET /datasets, /datasets/:key, /datasets/:key/last-sync
        └── sync.ts             # POST /sync/:key, /sync/all
prisma/
└── schema.prisma               # Database schema
```

## Extraction Modes

Each dataset can use one of three extraction strategies:

- **STANDARD** — Uses the NetSuite REST saved search API with pagination.
- **CSV_EXPORT** — Triggers a RESTlet that runs a CSV export task.
- **STANDARD_WITH_CSV_FALLBACK** — Tries standard first; falls back to CSV if it returns zero rows or throws an error. Transfer orders use this mode by default.

## Sync Tracking

Every sync creates:
- A `sync_job` record (status, trigger, duration)
- One or more `sync_run` records (per extraction attempt, with row counts)
- `sync_error` records for any failures

Query these via the `/datasets/:key/last-sync` endpoint or directly in the database.

## Adding a New Dataset

1. Add a search in NetSuite and note the saved search ID
2. Add a Prisma model in `prisma/schema.prisma`
3. Add a normalizer function in `src/services/normalizers.ts`
4. Register the model in `src/services/data-writer.ts`
5. Add the dataset definition in `src/config/datasets.ts`
6. Run `npx prisma migrate dev` and restart

## License

Private — UNLICENSED
