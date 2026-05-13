/**
 * Migration: trust features (Companies House, Stripe Identity, deal agreements, KYC, matching)
 * Run this SQL in your Supabase SQL editor.
 *
 * Companies House API key: register free at https://developer.company-information.service.gov.uk/
 * Then add COMPANIES_HOUSE_API_KEY to your Vercel environment variables.
 *
 * Stripe Identity: already configured via STRIPE_SECRET_KEY.
 * Add STRIPE_IDENTITY_WEBHOOK_SECRET env var after creating the webhook endpoint.
 */
const sql = `
-- Identity verification columns on profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS identity_verified boolean DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS kyc_flagged boolean DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS kyc_checked_at timestamptz;

-- Company verification on lender_profiles
ALTER TABLE lender_profiles ADD COLUMN IF NOT EXISTS company_number text;
ALTER TABLE lender_profiles ADD COLUMN IF NOT EXISTS company_verified boolean DEFAULT false;

-- Company verification on builder_profiles (with extra metadata)
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS company_number text;
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS company_verified boolean DEFAULT false;
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS company_name text;
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS company_status text;
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS company_incorporated text;

-- Deal agreement signing
ALTER TABLE deals ADD COLUMN IF NOT EXISTS agreement_signed_lender boolean DEFAULT false;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS agreement_signed_builder boolean DEFAULT false;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS agreement_signed_lender_at timestamptz;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS agreement_signed_builder_at timestamptz;

-- KYC checks audit log
CREATE TABLE IF NOT EXISTS kyc_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  sanctions_hit boolean DEFAULT false,
  disposable_email boolean DEFAULT false,
  ip_country text,
  ip_outside_uk boolean DEFAULT false,
  result text NOT NULL DEFAULT 'pass',
  details jsonb
);
ALTER TABLE kyc_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admin full access kyc" ON kyc_checks;
CREATE POLICY "Admin full access kyc" ON kyc_checks FOR ALL USING (true);

-- Matches cache for smart matching notifications
CREATE TABLE IF NOT EXISTS matches_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  matched_user_id uuid NOT NULL,
  score integer NOT NULL DEFAULT 0,
  match_type text NOT NULL DEFAULT 'lender_builder',
  details jsonb,
  notified boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, matched_user_id)
);
ALTER TABLE matches_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "User reads own matches" ON matches_cache;
DROP POLICY IF EXISTS "Service manages matches" ON matches_cache;
CREATE POLICY "User reads own matches" ON matches_cache FOR SELECT USING (auth.uid() = user_id OR auth.uid() = matched_user_id);
CREATE POLICY "Service manages matches" ON matches_cache FOR ALL USING (true);
`;

console.log("Run the following SQL in your Supabase SQL editor:");
console.log(sql);
