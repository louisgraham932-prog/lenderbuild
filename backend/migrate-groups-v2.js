// Run this SQL in your Supabase SQL Editor (Dashboard → SQL Editor → New query)
// Adds: group channels, member moderation, message deletion, pinned messages, group rules

const SQL = `
-- ── 1. Group channels table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE group_channels ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='group_channels' AND policyname='group_channels_select') THEN
    CREATE POLICY "group_channels_select" ON group_channels FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='group_channels' AND policyname='group_channels_insert') THEN
    CREATE POLICY "group_channels_insert" ON group_channels FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='group_channels' AND policyname='group_channels_update') THEN
    CREATE POLICY "group_channels_update" ON group_channels FOR UPDATE USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='group_channels' AND policyname='group_channels_delete') THEN
    CREATE POLICY "group_channels_delete" ON group_channels FOR DELETE USING (auth.uid() IS NOT NULL);
  END IF;
END $$;

-- ── 2. Add channel_id to group_messages ────────────────────────────────────
ALTER TABLE group_messages
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES group_channels(id) ON DELETE SET NULL;

-- ── 3. Add moderation columns to group_messages ────────────────────────────
ALTER TABLE group_messages
  ADD COLUMN IF NOT EXISTS deleted        BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_by     TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pinned         BOOLEAN     NOT NULL DEFAULT FALSE;

-- ── 4. Add moderation columns to community_group_members ──────────────────
ALTER TABLE community_group_members
  ADD COLUMN IF NOT EXISTS is_moderator  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS muted         BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS muted_until   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removed       BOOLEAN     NOT NULL DEFAULT FALSE;

-- ── 5. Add management columns to community_groups ─────────────────────────
ALTER TABLE community_groups
  ADD COLUMN IF NOT EXISTS pinned_message_id      UUID REFERENCES group_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pinned_message_content TEXT,
  ADD COLUMN IF NOT EXISTS pinned_message_author  TEXT,
  ADD COLUMN IF NOT EXISTS rules                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS owner_id               UUID; -- denormalised for quick owner checks

-- Back-fill owner_id from created_by
UPDATE community_groups SET owner_id = created_by WHERE owner_id IS NULL;

-- ── 6. Create default "general" channel for every existing group ───────────
INSERT INTO group_channels (group_id, name, description, position, is_default)
SELECT id, 'General', 'General discussion', 0, TRUE
FROM community_groups g
WHERE NOT EXISTS (
  SELECT 1 FROM group_channels gc WHERE gc.group_id = g.id AND gc.is_default = TRUE
);
`;

console.log("Copy and run the following SQL in your Supabase SQL Editor:\n");
console.log(SQL);
