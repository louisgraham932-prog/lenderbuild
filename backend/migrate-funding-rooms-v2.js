/**
 * Run this SQL in the Supabase SQL Editor to add group-funding post support,
 * investment terms, and finder fee tracking to the funding room tables.
 *
 * Safe to run multiple times (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 */

const SQL = `
-- ─── FUNDING ROOMS: add terms + community post support ───────────────────────
ALTER TABLE funding_rooms
  ADD COLUMN IF NOT EXISTS return_type  TEXT,
  ADD COLUMN IF NOT EXISTS return_value TEXT,
  ADD COLUMN IF NOT EXISTS terms_set_at TIMESTAMPTZ;

-- ─── FUNDING ROOM MEMBERS: add status + terms + fee tracking ─────────────────
ALTER TABLE funding_room_members
  ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'committed'
                                            CHECK (status IN ('committed','terms_agreed','fee_paid')),
  ADD COLUMN IF NOT EXISTS terms_agreed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fee_paid_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fee_amount       NUMERIC,
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;

-- ─── POLICY: builder can UPDATE terms on their own room ──────────────────────
CREATE POLICY IF NOT EXISTS "fr_update_builder" ON funding_rooms
  FOR UPDATE USING (builder_id = auth.uid());

-- ─── POLICY: lender can UPDATE their own membership (agree terms / fee paid) ─
CREATE POLICY IF NOT EXISTS "frm_update_lender" ON funding_room_members
  FOR UPDATE USING (lender_id = auth.uid());

-- ─── POLICY: builder can SELECT members of their rooms ───────────────────────
-- (already covered by frm_select via builder_id check, no change needed)

-- ─── POLICY: lender can INSERT into any open room (for joining from posts) ───
CREATE POLICY IF NOT EXISTS "frm_insert_lender" ON funding_room_members
  FOR INSERT WITH CHECK (lender_id = auth.uid());

-- ─── INDEX ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS funding_room_members_status_idx ON funding_room_members(room_id, status);
`;

console.log("Run the following SQL in the Supabase SQL Editor:\n");
console.log(SQL);
