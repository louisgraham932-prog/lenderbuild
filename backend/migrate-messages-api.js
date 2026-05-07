/**
 * Migration via Supabase Management API — no direct DB connection needed.
 * Run with: DB_PASSWORD=<ignored> node migrate-messages-api.js
 *   or just: node migrate-messages-api.js
 *
 * Uses SUPABASE_SERVICE_KEY from .env to authenticate against the
 * Supabase Management REST API and execute DDL over HTTPS.
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
-- conversations table
create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  lender_id       uuid not null,
  builder_id      uuid not null,
  lender_name     text,
  builder_name    text,
  last_message    text,
  last_message_at timestamptz,
  created_at      timestamptz default now(),
  unique (lender_id, builder_id)
);

alter table public.conversations enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'conversations' and policyname = 'users can view their conversations'
  ) then
    create policy "users can view their conversations"
      on public.conversations for select
      to authenticated
      using (lender_id = auth.uid() or builder_id = auth.uid());
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'conversations' and policyname = 'users can update their conversations'
  ) then
    create policy "users can update their conversations"
      on public.conversations for update
      to authenticated
      using (lender_id = auth.uid() or builder_id = auth.uid())
      with check (lender_id = auth.uid() or builder_id = auth.uid());
  end if;
end $$;

-- messages table
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade not null,
  sender_id       uuid not null,
  content         text not null,
  created_at      timestamptz default now()
);

alter table public.messages enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'messages' and policyname = 'users can view messages in their conversations'
  ) then
    create policy "users can view messages in their conversations"
      on public.messages for select
      to authenticated
      using (
        exists (
          select 1 from public.conversations c
          where c.id = conversation_id
          and (c.lender_id = auth.uid() or c.builder_id = auth.uid())
        )
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'messages' and policyname = 'users can send messages in their conversations'
  ) then
    create policy "users can send messages in their conversations"
      on public.messages for insert
      to authenticated
      with check (
        sender_id = auth.uid()
        and exists (
          select 1 from public.conversations c
          where c.id = conversation_id
          and (c.lender_id = auth.uid() or c.builder_id = auth.uid())
        )
      );
  end if;
end $$;

-- realtime
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
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
  console.log("Attempting migration via Supabase Management API…");

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
    console.log("Migration complete. The messaging system is ready.");
    return;
  }

  console.error(`Management API returned HTTP ${status}:`, JSON.stringify(body, null, 2));

  if (status === 401 || status === 403) {
    console.error(
      "\nThe service role key is not accepted by the Management API.\n" +
      "To run this migration you have two options:\n\n" +
      "Option A — Personal Access Token:\n" +
      "  1. Go to https://supabase.com/dashboard/account/tokens\n" +
      "  2. Generate a new token and copy it\n" +
      "  3. Re-run: SUPABASE_PAT=<token> node migrate-messages-api.js\n\n" +
      "Option B — Supabase SQL Editor (no token needed):\n" +
      `  1. Open https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new\n` +
      "  2. Paste and run the SQL printed below.\n"
    );
    console.log("──── SQL to paste ────────────────────────────────────────");
    console.log(SQL);
    console.log("──────────────────────────────────────────────────────────");
  }

  process.exit(1);
}

// Allow overriding with a PAT if the service key doesn't work
if (process.env.SUPABASE_PAT) {
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_PAT;
}

migrate().catch((err) => {
  console.error("Unexpected error:", err.message);
  process.exit(1);
});
