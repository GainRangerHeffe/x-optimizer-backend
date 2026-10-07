# X Optimizer backend

API for X Optimizer, a tool from the [Bloksi](https://github.com/GainRangerHeffe/bloksi) project that rewrites social posts to perform better. It uses Claude to optimize posts, write threads and draft replies for X, and to produce captions, carousels and reel scripts for Instagram. Usage is metered per user, with paid plans through Stripe and crypto payments through NOWPayments.

## Stack

Node.js, Express, MySQL (`mysql2`), the Anthropic SDK and Stripe. Deployed as a serverless function on Vercel (`vercel.json`).

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/usage` | Current usage and plan for a user |
| POST | `/api/optimize` | Optimize a post for X |
| POST | `/api/generate-thread` | Turn an idea into an X thread |
| POST | `/api/generate-reply` | Draft a reply to a post |
| POST | `/api/optimize-ig` | Optimize an Instagram caption |
| POST | `/api/generate-carousel` | Write Instagram carousel slides |
| POST | `/api/generate-reel` | Write an Instagram reel script |
| POST | `/api/create-checkout` | Start a Stripe checkout for a plan |
| POST | `/api/create-crypto-checkout` | Start a NOWPayments checkout |
| POST | `/api/stripe-webhook` | Stripe webhook |
| POST | `/api/nowpayments-webhook` | NOWPayments webhook |

The prompts are in `prompts.js` (X) and `ig-prompts.js` (Instagram).

## Run locally

```bash
npm install
npm run dev
```

Create a `.env` file first:

| Variable | Purpose |
|---|---|
| `CLAUDE_API_KEY` | Anthropic API key |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | MySQL connection |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe credentials |
| `STRIPE_STARTER_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, `STRIPE_UNLIMITED_PRICE_ID`, `STRIPE_YEARLY_PRICE_ID` | Stripe price IDs for each plan |
| `NOWPAYMENTS_API_KEY` | NOWPayments key for crypto checkout |
| `FRONTEND_URL` | Where checkout redirects back to |
| `PORT` | Defaults to 3000 |

## Status

Built in early 2026. The hosted deployment is offline and the project is not actively maintained. The model ID in `server.js` should be updated to a current Claude model before reuse.
