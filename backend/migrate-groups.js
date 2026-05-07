/**
 * Run this SQL in the Supabase SQL Editor to add community groups tables.
 */
const SQL = `
-- ── community_groups ─────────────────────────────────────────────────────────
create table if not exists community_groups (
  id               uuid        primary key default gen_random_uuid(),
  name             text        not null,
  description      text,
  region           text        not null,
  created_by       uuid        not null,
  created_by_name  text,
  member_count     integer     not null default 0,
  last_activity    timestamptz,
  created_at       timestamptz not null default now()
);

alter table community_groups enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='community_groups' and policyname='Read all groups') then
    create policy "Read all groups" on community_groups for select using (true);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='community_groups' and policyname='Insert own group') then
    create policy "Insert own group" on community_groups
      for insert with check (auth.uid() = created_by);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='community_groups' and policyname='Update own group') then
    create policy "Update own group" on community_groups
      for update using (true);
  end if;
end $$;

-- ── community_group_members ───────────────────────────────────────────────────
create table if not exists community_group_members (
  id         uuid        primary key default gen_random_uuid(),
  group_id   uuid        not null references community_groups(id) on delete cascade,
  user_id    uuid        not null,
  joined_at  timestamptz not null default now(),
  constraint community_group_members_unique unique (group_id, user_id)
);

alter table community_group_members enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='community_group_members' and policyname='Read memberships') then
    create policy "Read memberships" on community_group_members for select using (true);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='community_group_members' and policyname='Insert own membership') then
    create policy "Insert own membership" on community_group_members
      for insert with check (auth.uid() = user_id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='community_group_members' and policyname='Delete own membership') then
    create policy "Delete own membership" on community_group_members
      for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ── Trigger: auto-maintain member_count ──────────────────────────────────────
create or replace function update_group_member_count()
returns trigger language plpgsql security definer as $$
begin
  if TG_OP = 'INSERT' then
    update community_groups set member_count = member_count + 1 where id = NEW.group_id;
  elsif TG_OP = 'DELETE' then
    update community_groups set member_count = greatest(0, member_count - 1) where id = OLD.group_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_group_member_count on community_group_members;
create trigger trg_group_member_count
  after insert or delete on community_group_members
  for each row execute function update_group_member_count();

-- ── group_messages ────────────────────────────────────────────────────────────
create table if not exists group_messages (
  id               uuid        primary key default gen_random_uuid(),
  group_id         uuid        not null references community_groups(id) on delete cascade,
  user_id          uuid        not null,
  content          text        not null,
  user_name        text,
  user_avatar_url  text,
  user_role        text,
  sequential_id    integer,
  flagged          boolean     not null default false,
  hidden           boolean     not null default false,
  report_count     integer     not null default 0,
  flag_reason      text,
  created_at       timestamptz not null default now()
);

alter table group_messages enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='group_messages' and policyname='Read group messages') then
    create policy "Read group messages" on group_messages for select using (true);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='group_messages' and policyname='Insert own group messages') then
    create policy "Insert own group messages" on group_messages
      for insert with check (auth.uid() = user_id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='group_messages' and policyname='Update group messages') then
    create policy "Update group messages" on group_messages
      for update using (true);
  end if;
end $$;

-- ── group_reports ─────────────────────────────────────────────────────────────
create table if not exists group_reports (
  id                uuid        primary key default gen_random_uuid(),
  message_id        uuid        not null,
  reporter_id       uuid        not null,
  reporter_name     text,
  reason            text        not null,
  message_content   text,
  message_user_id   uuid,
  message_user_name text,
  created_at        timestamptz not null default now(),
  constraint group_reports_unique unique (message_id, reporter_id)
);

alter table group_reports enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='group_reports' and policyname='Insert own group reports') then
    create policy "Insert own group reports" on group_reports
      for insert with check (auth.uid() = reporter_id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='group_reports' and policyname='Read group reports') then
    create policy "Read group reports" on group_reports for select using (true);
  end if;
end $$;

-- ── RPC: report a group message and auto-hide at 3 reports ───────────────────
create or replace function report_group_message(
  p_message_id        uuid,
  p_reporter_id       uuid,
  p_reporter_name     text,
  p_reason            text,
  p_message_content   text,
  p_message_user_id   uuid,
  p_message_user_name text
) returns json language plpgsql security definer as $$
declare
  new_count integer;
begin
  insert into group_reports
    (message_id, reporter_id, reporter_name, reason, message_content, message_user_id, message_user_name)
  values
    (p_message_id, p_reporter_id, p_reporter_name, p_reason, p_message_content, p_message_user_id, p_message_user_name)
  on conflict (message_id, reporter_id) do nothing;

  update group_messages
  set report_count = report_count + 1,
      hidden = case when report_count + 1 >= 3 then true else hidden end
  where id = p_message_id
  returning report_count into new_count;

  return json_build_object('ok', true, 'report_count', new_count, 'auto_hidden', new_count >= 3);
exception when others then
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

-- ── Enable realtime for group_messages ───────────────────────────────────────
alter publication supabase_realtime add table group_messages;
`;

console.log("Run the following SQL in Supabase SQL Editor:\n");
console.log(SQL);
