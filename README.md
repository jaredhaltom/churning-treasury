# Churning Treasury

A personal treasury dashboard for credit-card churning and manufactured spend.
Tracks cards, MSR velocity, working capital tied up in gift cards / fuel
points / MR, and the liquidation pipeline that turns those back into cash.

Built with Next.js 15, Prisma, SQLite, and Plaid (optional, for automatic
card-charge ingestion).

## Live demo

A public demo with seeded fake data is deployed at the URL shared with the
churning community. Plaid is disabled in the demo; mutations work but reset
every few minutes as the serverless container goes cold.

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

Set `NEXT_PUBLIC_DEMO_MODE=true` to:

- Replace the Plaid Link button with a "disabled in demo" placeholder
- Make every `/api/plaid/*` route return 503
- Render a top-of-page demo banner
- Read/write the seeded SQLite database at `/tmp/demo.db` (copied on first
  request from `prisma/demo.db` shipped in the build)

```bash
npm run build:demo   # builds prisma/demo.db + production bundle
NEXT_PUBLIC_DEMO_MODE=true DATABASE_URL="file:$(pwd)/prisma/demo.db" npm run dev:http
```

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
3. Set environment variables in the Vercel dashboard:
   - `NEXT_PUBLIC_DEMO_MODE=true`
   - `DATABASE_URL=file:/tmp/demo.db`
4. Vercel runs `npm run build:demo` (configured in `vercel.json`), which
   regenerates `prisma/demo.db` from scratch on each deploy
5. `next.config.ts`'s `outputFileTracingIncludes` bundles the seeded DB into
   the serverless function

Do **not** set any `PLAID_*` env vars on the demo deployment — the demo
mode flag short-circuits the Plaid surface before any client is constructed.
