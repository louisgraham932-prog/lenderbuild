/**
 * Run this SQL in the Supabase SQL Editor to create the Group Funding Room tables.
 *
 * Tables created:
 *   funding_rooms         — one per group-funding listing
 *   funding_room_members  — lenders who have committed funds
 *   funding_room_messages — real-time chat within the room
 */

const SQL = `
-- ─── FUNDING ROOMS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS funding_rooms (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id       TEXT        NOT NULL UNIQUE,
  builder_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_amount    NUMERIC     NOT NULL DEFAULT 0,
  committed_amount NUMERIC     NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','fully_funded','closed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── FUNDING ROOM MEMBERS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS funding_room_members (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID        NOT NULL REFERENCES funding_rooms(id) ON DELETE CASCADE,
  lender_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lender_name TEXT        NOT NULL DEFAULT '',
  amount      NUMERIC     NOT NULL DEFAULT 0,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, lender_id)
);

-- ─── FUNDING ROOM MESSAGES ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS funding_room_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID        NOT NULL REFERENCES funding_rooms(id) ON DELETE CASCADE,
  sender_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_name TEXT        NOT NULL DEFAULT '',
  message     TEXT        NOT NULL,
  is_system   BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── INDEXES ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS funding_rooms_builder_idx        ON funding_rooms(builder_id);
CREATE INDEX IF NOT EXISTS funding_room_members_room_idx    ON funding_room_members(room_id);
CREATE INDEX IF NOT EXISTS funding_room_members_lender_idx  ON funding_room_members(lender_id);
CREATE INDEX IF NOT EXISTS funding_room_messages_room_idx   ON funding_room_messages(room_id);
CREATE INDEX IF NOT EXISTS funding_room_messages_created_idx ON funding_room_messages(room_id, created_at);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
ALTER TABLE funding_rooms         ENABLE ROW LEVEL SECURITY;
ALTER TABLE funding_room_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE funding_room_messages ENABLE ROW LEVEL SECURITY;

-- funding_rooms: builder or member can SELECT
CREATE POLICY "fr_select_builder" ON funding_rooms
  FOR SELECT USING (builder_id = auth.uid());

CREATE POLICY "fr_select_member" ON funding_rooms
  FOR SELECT USING (
    id IN (SELECT room_id FROM funding_room_members WHERE lender_id = auth.uid())
  );

-- funding_room_members: builder of the room or any member can SELECT
CREATE POLICY "frm_select" ON funding_room_members
  FOR SELECT USING (
    room_id IN (
      SELECT id  FROM funding_rooms        WHERE builder_id = auth.uid()
      UNION ALL
      SELECT room_id FROM funding_room_members WHERE lender_id = auth.uid()
    )
  );

-- funding_room_messages: builder or member can SELECT
CREATE POLICY "frmsg_select" ON funding_room_messages
  FOR SELECT USING (
    room_id IN (
      SELECT id  FROM funding_rooms        WHERE builder_id = auth.uid()
      UNION ALL
      SELECT room_id FROM funding_room_members WHERE lender_id = auth.uid()
    )
  );

-- funding_room_messages: builder or member can INSERT their own messages
CREATE POLICY "frmsg_insert" ON funding_room_messages
  FOR INSERT WITH CHECK (
    sender_id = auth.uid() AND
    room_id IN (
      SELECT id  FROM funding_rooms        WHERE builder_id = auth.uid()
      UNION ALL
      SELECT room_id FROM funding_room_members WHERE lender_id = auth.uid()
    )
  );

-- ─── REALTIME ─────────────────────────────────────────────────────────────────
-- Enable realtime on these tables in the Supabase dashboard under
-- Database → Replication, or run:
ALTER PUBLICATION supabase_realtime ADD TABLE funding_rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE funding_room_members;
ALTER PUBLICATION supabase_realtime ADD TABLE funding_room_messages;
`;

console.log("Run the following SQL in the Supabase SQL Editor:\n");
console.log(SQL);
