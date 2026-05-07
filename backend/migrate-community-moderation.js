/**
 * Run this SQL in the Supabase SQL Editor to add community moderation tables.
 */
const SQL = `
-- ── Add moderation columns to community_messages ─────────────────────────────
alter table community_messages add column if not exists flagged      boolean  not null default false;
alter table community_messages add column if not exists hidden       boolean  not null default false;
alter table community_messages add column if not exists report_count integer  not null default 0;
alter table community_messages add column if not exists flag_reason  text;

-- Allow realtime to pick up UPDATE events (for live hide/flag propagation)
-- community_messages is already in supabase_realtime publication from previous migration.
-- If not, uncomment: alter publication supabase_realtime add table community_messages;

-- ── community_reports: one report per user per message ───────────────────────
create table if not exists community_reports (
  id               uuid        primary key default gen_random_uuid(),
  message_id       uuid        not null,
  reporter_id      uuid        not null,
  reporter_name    text,
  reason           text        not null,
  message_content  text,
  message_user_id  uuid,
  message_user_name text,
  created_at       timestamptz not null default now(),
  constraint community_reports_unique unique (message_id, reporter_id)
);
alter table community_reports enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='community_reports' and policyname='Insert own reports') then
    create policy "Insert own reports" on community_reports
      for insert with check (auth.uid() = reporter_id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='community_reports' and policyname='Read all reports') then
    create policy "Read all reports" on community_reports for select using (true);
  end if;
end $$;

-- ── community_bans: ban users from community chat ────────────────────────────
create table if not exists community_bans (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null unique,
  user_name    text,
  reason       text,
  ban_type     text        not null default 'temporary',
  banned_until timestamptz,
  banned_at    timestamptz not null default now()
);
alter table community_bans enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='community_bans' and policyname='Read own ban') then
    create policy "Read own ban" on community_bans for select using (auth.uid() = user_id);
  end if;
end $$;

-- ── Atomic RPC: report a message and auto-hide at 3 reports ─────────────────
create or replace function report_community_message(
  p_message_id       uuid,
  p_reporter_id      uuid,
  p_reporter_name    text,
  p_reason           text,
  p_message_content  text,
  p_message_user_id  uuid,
  p_message_user_name text
) returns json language plpgsql security definer as $$
declare
  new_count integer;
begin
  insert into community_reports
    (message_id, reporter_id, reporter_name, reason, message_content, message_user_id, message_user_name)
  values
    (p_message_id, p_reporter_id, p_reporter_name, p_reason, p_message_content, p_message_user_id, p_message_user_name)
  on conflict (message_id, reporter_id) do nothing;

  update community_messages
  set report_count = report_count + 1,
      hidden = case when report_count + 1 >= 3 then true else hidden end
  where id = p_message_id
  returning report_count into new_count;

  return json_build_object('ok', true, 'report_count', new_count, 'auto_hidden', new_count >= 3);
exception when others then
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;
`;

console.log("Run the following SQL in Supabase SQL Editor:\n");
console.log(SQL);
