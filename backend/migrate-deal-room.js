/**
 * Migration: deal_notes table for Deal Room feature
 * Run this script against your Supabase database.
 */
const sql = `
CREATE TABLE IF NOT EXISTS deal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid REFERENCES deals(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  author_name text NOT NULL DEFAULT '',
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE deal_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deal parties can view notes" ON deal_notes FOR SELECT USING (
  EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_id AND (d.lender_id = auth.uid() OR d.builder_id = auth.uid()))
);
CREATE POLICY "Deal parties can insert notes" ON deal_notes FOR INSERT WITH CHECK (
  user_id = auth.uid() AND
  EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_id AND (d.lender_id = auth.uid() OR d.builder_id = auth.uid()))
);
`;

console.log("Run the following SQL in your Supabase SQL editor:");
console.log(sql);
