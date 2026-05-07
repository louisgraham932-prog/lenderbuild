/**
 * Run this SQL in the Supabase SQL Editor to create community tables.
 */
const SQL = `
-- community_messages: stores chat messages for each channel
create table if not exists community_messages (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null,
  channel         text        not null default 'general',
  content         text        not null,
  user_name       text,
  user_avatar_url text,
  user_role       text,
  sequential_id   integer,
  created_at      timestamptz not null default now()
);

alter table community_messages enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'community_messages' and policyname = 'Read community messages'
  ) then
    create policy "Read community messages" on community_messages for select using (true);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'community_messages' and policyname = 'Insert own community messages'
  ) then
    create policy "Insert own community messages" on community_messages
      for insert with check (auth.uid() = user_id);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'community_messages' and policyname = 'Delete own community messages'
  ) then
    create policy "Delete own community messages" on community_messages
      for delete using (auth.uid() = user_id);
  end if;
end $$;

-- group_project_commitments: lenders commit portions of a group-funded project
create table if not exists group_project_commitments (
  id           uuid        primary key default gen_random_uuid(),
  listing_id   text        not null,
  lender_id    uuid        not null,
  lender_name  text,
  amount       numeric     not null check (amount > 0),
  committed_at timestamptz not null default now(),
  constraint group_project_commitments_lender_listing_key unique (listing_id, lender_id)
);

alter table group_project_commitments enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'group_project_commitments' and policyname = 'Read commitments'
  ) then
    create policy "Read commitments" on group_project_commitments for select using (true);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'group_project_commitments' and policyname = 'Insert own commitment'
  ) then
    create policy "Insert own commitment" on group_project_commitments
      for insert with check (auth.uid() = lender_id);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'group_project_commitments' and policyname = 'Update own commitment'
  ) then
    create policy "Update own commitment" on group_project_commitments
      for update using (auth.uid() = lender_id);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'group_project_commitments' and policyname = 'Delete own commitment'
  ) then
    create policy "Delete own commitment" on group_project_commitments
      for delete using (auth.uid() = lender_id);
  end if;
end $$;

-- Enable realtime for community_messages
alter publication supabase_realtime add table community_messages;
`;

console.log("Run the following SQL in Supabase SQL Editor:\n");
console.log(SQL);
