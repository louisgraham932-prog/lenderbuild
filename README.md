# LenderBuild

A lending platform connecting borrowers and lenders. Built with React, Express, Supabase, and Stripe.

## Prerequisites

- [Bun](https://bun.sh) — frontend package manager & runner
- [Node.js](https://nodejs.org) (v18+) — backend runtime
- A [Supabase](https://supabase.com) project
- A [Stripe](https://stripe.com) account

## Frontend

```bash
cd frontend
bun install
bun run dev       # starts on http://localhost:3000
```

Create `frontend/.env`:
```
REACT_APP_SUPABASE_URL=your_supabase_url
REACT_APP_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Backend

```bash
cd backend
npm install
npm run dev       # starts on http://localhost:4000
```

Create `backend/.env`:
```
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret
CLIENT_URL=http://localhost:3000
PORT=4000
```

## Deploy

The frontend deploys automatically to Vercel on push to `main`. The backend (`backend/api.js`) is a standalone Express server — deploy it separately (Railway, Render, etc.).
