/**
 * Migration: creates conversations and messages tables for the messaging system.
 * Run with: DB_PASSWORD=yourpassword node migrate-messages.js
 * Find your password in Supabase Dashboard → Settings → Database
 */

require("dotenv").config();
const { Client } = require("pg");

const dbPassword = process.env.DB_PASSWORD || process.argv[2];
if (!dbPassword) {
  console.error("Usage: DB_PASSWORD=<password> node migrate-messages.js");
  console.error("Find your password in Supabase Dashboard → Settings → Database");
  process.exit(1);
}

const PROJECT_REF = "qvywhdsaeiufdlaewwby";

const client = new Client({
  host: `db.${PROJECT_REF}.supabase.co`,
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: dbPassword,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  await client.connect();
  console.log("Connected to Supabase Postgres");

  // ── conversations ──────────────────────────────────────────────────────────
  await client.query(`
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
  `);
  console.log("✓ conversations table created");

  await client.query(`alter table public.conversations enable row level security;`);
  console.log("✓ RLS enabled on conversations");

  await client.query(`
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
  `);
  console.log("✓ conversations SELECT policy created");

  await client.query(`
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
  `);
  console.log("✓ conversations UPDATE policy created");

  // ── messages ───────────────────────────────────────────────────────────────
  await client.query(`
    create table if not exists public.messages (
      id              uuid primary key default gen_random_uuid(),
      conversation_id uuid references public.conversations(id) on delete cascade not null,
      sender_id       uuid not null,
      content         text not null,
      created_at      timestamptz default now()
    );
  `);
  console.log("✓ messages table created");

  await client.query(`alter table public.messages enable row level security;`);
  console.log("✓ RLS enabled on messages");

  await client.query(`
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
  `);
  console.log("✓ messages SELECT policy created");

  await client.query(`
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
  `);
  console.log("✓ messages INSERT policy created");

  // ── realtime ───────────────────────────────────────────────────────────────
  await client.query(`
    do $$ begin
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'messages'
      ) then
        alter publication supabase_realtime add table public.messages;
      end if;
    end $$;
  `);
  console.log("✓ messages table added to realtime publication");

  await client.query(`
    do $$ begin
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'conversations'
      ) then
        alter publication supabase_realtime add table public.conversations;
      end if;
    end $$;
  `);
  console.log("✓ conversations table added to realtime publication");

  await client.end();
  console.log("\nMigration complete. The messaging system is ready.");
}

migrate().catch(err => {
  console.error("Migration failed:", err.message);
  client.end();
  process.exit(1);
});
