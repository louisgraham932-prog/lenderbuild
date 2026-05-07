/**
 * Run this SQL in the Supabase SQL Editor to add private invite-only group support.
 */
const SQL = `
-- ── Add privacy columns to community_groups ──────────────────────────────────
alter table community_groups add column if not exists is_private  boolean not null default false;
alter table community_groups add column if not exists invite_code text unique;

-- ── Update RLS: private groups only visible to members or creator ─────────────
drop policy if exists "Read all groups" on community_groups;
create policy "Read groups" on community_groups for select using (
  not is_private
  or created_by = auth.uid()
  or exists (
    select 1 from community_group_members
    where group_id = community_groups.id and user_id = auth.uid()
  )
);

-- ── Update group_messages RLS: private chat only readable by members ──────────
drop policy if exists "Read group messages" on group_messages;
create policy "Read group messages" on group_messages for select using (
  exists (
    select 1 from community_groups g
    where g.id = group_messages.group_id
    and (
      not g.is_private
      or g.created_by = auth.uid()
      or exists (
        select 1 from community_group_members m
        where m.group_id = g.id and m.user_id = auth.uid()
      )
    )
  )
);

-- ── RPC: join a private group via invite code ─────────────────────────────────
create or replace function join_group_by_invite(p_invite_code text, p_user_id uuid)
returns json language plpgsql security definer as $$
declare
  v_group_id uuid;
  v_name     text;
begin
  select id, name into v_group_id, v_name
  from community_groups
  where invite_code = upper(trim(p_invite_code));

  if v_group_id is null then
    return json_build_object('ok', false, 'error', 'Invalid invite code. Check the code and try again.');
  end if;

  insert into community_group_members (group_id, user_id)
  values (v_group_id, p_user_id)
  on conflict do nothing;

  return json_build_object('ok', true, 'group_id', v_group_id, 'group_name', v_name);
exception when others then
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;
`;

console.log("Run the following SQL in Supabase SQL Editor:\n");
console.log(SQL);
