/**
 * One-time migration: creates the connection_requests table in Supabase.
 * Run with: node migrate.js
 * Requires DB_PASSWORD env var or pass as first argument:
 *   DB_PASSWORD=yourpassword node migrate.js
 */

require("dotenv").config();
const { Client } = require("pg");

const dbPassword = process.env.DB_PASSWORD || process.argv[2];
if (!dbPassword) {
  console.error("Usage: DB_PASSWORD=<password> node migrate.js");
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

  await client.query(`
    create table if not exists public.connection_requests (
      id               uuid default gen_random_uuid() primary key,
      builder_user_id  uuid references auth.users(id) on delete cascade,
      builder_name     text,
      lender_name      text not null,
      lender_type      text,
      status           text default 'pending',
      created_at       timestamp with time zone default now()
    );
  `);
  console.log("✓ Table created");

  await client.query(`alter table public.connection_requests enable row level security;`);
  console.log("✓ RLS enabled");

  await client.query(`
    do $$ begin
      if not exists (
        select 1 from pg_policies
        where tablename = 'connection_requests'
        and policyname = 'builders can insert own requests'
      ) then
        create policy "builders can insert own requests"
          on public.connection_requests for insert
          to authenticated
          with check (auth.uid() = builder_user_id);
      end if;
    end $$;
  `);
  console.log("✓ Insert policy created");

  await client.query(`
    do $$ begin
      if not exists (
        select 1 from pg_policies
        where tablename = 'connection_requests'
        and policyname = 'builders can view own requests'
      ) then
        create policy "builders can view own requests"
          on public.connection_requests for select
          to authenticated
          using (auth.uid() = builder_user_id);
      end if;
    end $$;
  `);
  console.log("✓ Select policy created");

  await client.end();
  console.log("\nMigration complete. The Connect button will now work.");
}

migrate().catch(err => {
  console.error("Migration failed:", err.message);
  client.end();
  process.exit(1);
});
