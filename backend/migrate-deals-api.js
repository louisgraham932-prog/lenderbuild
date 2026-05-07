/**
 * Migration: creates deals and milestones tables in Supabase.
 * Run with: node migrate-deals-api.js
 * Uses SUPABASE_SERVICE_KEY from .env
 */

require("dotenv").config();

const https = require("https");

const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PROJECT_REF = "qvywhdsaeiufdlaewwby";

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_KEY not found in .env");
  process.exit(1);
}

const SQL = `
-- deals table
create table if not exists public.deals (
  id           uuid primary key default gen_random_uuid(),
  lender_id    uuid not null,
  builder_id   uuid,
  lender_name  text,
  builder_name text not null,
  title        text not null,
  status       text default 'active',
  created_at   timestamptz default now()
);

alter table public.deals enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'deals' and policyname = 'users can view their deals'
  ) then
    create policy "users can view their deals"
      on public.deals for select
      to authenticated
      using (lender_id = auth.uid() or builder_id = auth.uid());
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'deals' and policyname = 'lenders can insert deals'
  ) then
    create policy "lenders can insert deals"
      on public.deals for insert
      to authenticated
      with check (lender_id = auth.uid());
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'deals' and policyname = 'lenders can update their deals'
  ) then
    create policy "lenders can update their deals"
      on public.deals for update
      to authenticated
      using (lender_id = auth.uid())
      with check (lender_id = auth.uid());
  end if;
end $$;

-- milestones table
create table if not exists public.milestones (
  id                   uuid primary key default gen_random_uuid(),
  deal_id              uuid references public.deals(id) on delete cascade not null,
  title                text not null,
  description          text,
  amount               numeric not null,
  order_index          int not null,
  status               text default 'pending',
  completed_at         timestamptz,
  approved_at          timestamptz,
  completion_photo_url text,
  stripe_session_id    text,
  created_at           timestamptz default now()
);

alter table public.milestones enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'milestones' and policyname = 'users can view their milestones'
  ) then
    create policy "users can view their milestones"
      on public.milestones for select
      to authenticated
      using (
        exists (
          select 1 from public.deals d
          where d.id = deal_id
          and (d.lender_id = auth.uid() or d.builder_id = auth.uid())
        )
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'milestones' and policyname = 'builders can update milestones'
  ) then
    create policy "builders can update milestones"
      on public.milestones for update
      to authenticated
      using (
        exists (
          select 1 from public.deals d
          where d.id = deal_id
          and d.builder_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.deals d
          where d.id = deal_id
          and d.builder_id = auth.uid()
        )
      );
  end if;
end $$;
`;

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function migrate() {
  console.log("Running deals/milestones migration via Supabase Management API…");

  const { status, body } = await post(
    "api.supabase.com",
    `/v1/projects/${PROJECT_REF}/database/query`,
    {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_KEY}`,
    },
    { query: SQL }
  );

  if (status === 200 || status === 201) {
    console.log("Migration complete. deals and milestones tables are ready.");
    return;
  }

  console.error(`Management API returned HTTP ${status}:`, JSON.stringify(body, null, 2));

  if (status === 401 || status === 403) {
    console.error(
      "\nThe service role key is not accepted by the Management API.\n" +
      "Paste the SQL below into the Supabase SQL Editor:\n" +
      `  https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new\n`
    );
    console.log("──── SQL to paste ────────────────────────────────────────");
    console.log(SQL);
    console.log("──────────────────────────────────────────────────────────");
  }

  process.exit(1);
}

if (process.env.SUPABASE_PAT) {
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_PAT;
}

migrate().catch((err) => {
  console.error("Unexpected error:", err.message);
  process.exit(1);
});
