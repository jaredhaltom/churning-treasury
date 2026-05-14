# Churning Treasury

A personal treasury dashboard for credit-card churning and manufactured spend.
Tracks cards, MSR velocity, working capital tied up in gift cards / fuel
points / MR, and the liquidation pipeline that turns those back into cash.

Built with Next.js 15, Prisma, SQLite, and Plaid (optional, for automatic
card-charge ingestion).

## Live demo

A public demo with seeded fake data is deployed at the URL shared with the
churning community. Plaid is disabled in the demo. Mutations are persistent
(shared, serverless Postgres) and the database is wiped + reseeded back to
the reference state on every deploy and on a daily Vercel Cron.

## Local development

```bash
npm install
cp .env.example .env   # fill in PLAID_* keys if you want bank linking
npm run db:push        # create dev.db
npm run dev:http       # http://localhost:3000
```

`npm run dev` runs with `--experimental-https` so OAuth-only Plaid
institutions (Amex, Chase, etc.) work without redirect-URI complaints.

## Demo mode

`NEXT_PUBLIC_DEMO_MODE=true` (set automatically by `npm run build:demo` via
`next.config.ts`) toggles:

- Replace the Plaid Link button with a "disabled in demo" placeholder
- Make every `/api/plaid/*` route return 503
- Render a top-of-page demo banner

The demo uses a **shared Postgres database** (Vercel Storage / Neon) so that
mutations persist across the serverless lambda fleet. Every deploy runs
`npm run build:demo`, which:

1. Generates `prisma/schema.gen.prisma` (same models, `provider = postgresql`)
2. `prisma db push` against the attached Postgres
3. Runs `scripts/seed-demo.ts` to wipe + reseed the deterministic fixture
4. Builds Next.js with `NEXT_PUBLIC_DEMO_MODE=true`

A daily Vercel Cron (`vercel.json`) hits `/api/reset-demo` to reset the
playground back to seed.

## Architecture notes

- **Cards** carry a velocity (cooldown) clock plus running MSR spend
- **Transactions** can be manually entered (King Soopers runs) or ingested
  via Plaid `/transactions/sync`
- **InventoryAssets** are the floating positions waiting to be sold —
  gift cards, fuel points, MR points, cashback
- **LiquidationEvents** close out assets with realized revenue + days held

Business logic lives in [`src/lib/constants.ts`](src/lib/constants.ts) and
[`src/lib/inventory-ops.ts`](src/lib/inventory-ops.ts). Both are used
identically by the live API routes and the demo seed script, so the demo
math matches production exactly.

## Deploying the demo

The demo is designed for Vercel's free tier:

1. Push this directory to a GitHub repo
2. Import into Vercel as a Next.js project
3. **Attach a Postgres database to the project**
   - In the Vercel dashboard for this project: **Storage → Create Database
     → Postgres** (Neon-powered, free tier is sufficient)
   - Vercel auto-injects `POSTGRES_PRISMA_URL` and `POSTGRES_URL_NON_POOLING`
     into the project's env, which the generated demo schema reads
4. Set a `CRON_SECRET` env var (any long random string). The daily cron job
   that resets the playground uses this as its bearer token; without it the
   `/api/reset-demo` route returns 401.
5. Vercel runs `npm run build:demo` (configured in `vercel.json`), which
   pushes the schema, seeds the database, and builds the app.

Do **not** set any `PLAID_*` env vars on the demo deployment — the demo
mode flag short-circuits the Plaid surface before any client is constructed.

To force-reset the playground manually:

```bash
curl -X POST https://<your-demo>.vercel.app/api/reset-demo \
  -H "Authorization: Bearer $CRON_SECRET"
```
