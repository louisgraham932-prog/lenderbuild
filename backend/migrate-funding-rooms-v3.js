/**
 * Run this SQL in the Supabase SQL Editor to add meeting scheduling to funding rooms.
 * Safe to run multiple times (uses ADD COLUMN IF NOT EXISTS).
 */

const SQL = `
-- ─── FUNDING ROOMS: add meeting scheduling ────────────────────────────────────
ALTER TABLE funding_rooms
  ADD COLUMN IF NOT EXISTS meeting_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS meeting_notes TEXT;
`;

console.log("Run the following SQL in the Supabase SQL Editor:\n");
console.log(SQL);
