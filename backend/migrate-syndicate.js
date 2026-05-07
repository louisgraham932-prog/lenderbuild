/**
 * Migration: syndicate_commitments table for Syndicated Lending feature
 * Run this script against your Supabase database.
 */
const sql = `
CREATE TABLE IF NOT EXISTS syndicate_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id text NOT NULL,
  builder_user_id uuid NOT NULL,
  lender_user_id uuid NOT NULL,
  lender_name text NOT NULL DEFAULT '',
  amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  committed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE syndicate_commitments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can insert" ON syndicate_commitments FOR INSERT WITH CHECK (auth.uid() = lender_user_id);
CREATE POLICY "Authenticated can view" ON syndicate_commitments FOR SELECT USING (auth.uid() = lender_user_id OR auth.uid() = builder_user_id);
`;

console.log("Run the following SQL in your Supabase SQL editor:");
console.log(sql);
