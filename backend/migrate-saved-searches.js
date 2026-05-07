/**
 * Migration: saved_searches table for Saved Searches with Alerts feature
 * Run this script against your Supabase database.
 */
const sql = `
CREATE TABLE IF NOT EXISTS saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'My search',
  role_type text NOT NULL DEFAULT 'builder',
  filters jsonb NOT NULL DEFAULT '{}',
  frequency text NOT NULL DEFAULT 'instant',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE saved_searches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage their saved searches" ON saved_searches USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
`;

console.log("Run the following SQL in your Supabase SQL editor:");
console.log(sql);
