/**
 * Migration: builder_reviews table for Builder Reputation Passport feature
 * Run this script against your Supabase database.
 */
const sql = `
CREATE TABLE IF NOT EXISTS builder_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_user_id uuid NOT NULL,
  lender_user_id uuid NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(builder_user_id, lender_user_id)
);
ALTER TABLE builder_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read reviews" ON builder_reviews FOR SELECT USING (true);
CREATE POLICY "Lenders can write reviews" ON builder_reviews FOR INSERT WITH CHECK (auth.uid() = lender_user_id);
CREATE POLICY "Lenders can update their review" ON builder_reviews FOR UPDATE USING (auth.uid() = lender_user_id);
`;

console.log("Run the following SQL in your Supabase SQL editor:");
console.log(sql);
