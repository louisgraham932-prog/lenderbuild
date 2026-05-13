/**
 * Run this SQL in the Supabase SQL Editor to create the solicitor referral
 * click-tracking table.
 *
 * paste into: https://supabase.com/dashboard → SQL Editor → New query
 */

const SQL = `
-- Solicitor referral click tracking
CREATE TABLE IF NOT EXISTS solicitor_referral_clicks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email     text,
  solicitor_id   text,
  solicitor_name text,
  deal_id        uuid REFERENCES deals(id) ON DELETE SET NULL,
  deal_title     text,
  clicked_at     timestamptz NOT NULL DEFAULT now()
);

-- Allow the service role (API) to insert rows; restrict reads to admin.
ALTER TABLE solicitor_referral_clicks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service insert" ON solicitor_referral_clicks
  FOR INSERT WITH CHECK (true);

CREATE POLICY "owner read" ON solicitor_referral_clicks
  FOR SELECT USING (auth.uid() = user_id);
`;

console.log("Run this SQL in the Supabase SQL Editor:\n");
console.log(SQL);
