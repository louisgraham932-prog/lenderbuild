// Run this SQL in your Supabase SQL Editor (Dashboard → SQL Editor → New query)
// Adds: deal_amount_confirmations table + agreed_amount / deal_confirmed_at on deals

const SQL = `
-- ── 1. deal_amount_confirmations — tracks each party's independent amount submission
CREATE TABLE IF NOT EXISTS deal_amount_confirmations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id       UUID NOT NULL,
  lender_id        UUID NOT NULL,
  confirmed_by     TEXT NOT NULL CHECK (confirmed_by IN ('builder', 'lender')),
  confirmed_amount NUMERIC(14,2) NOT NULL CHECK (confirmed_amount > 0),
  confirmed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deal_id          UUID REFERENCES deals(id) ON DELETE SET NULL,
  UNIQUE(builder_id, lender_id, confirmed_by)
);

ALTER TABLE deal_amount_confirmations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='deal_amount_confirmations' AND policyname='dac_select') THEN
    CREATE POLICY "dac_select" ON deal_amount_confirmations FOR SELECT USING (auth.uid() IN (builder_id, lender_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='deal_amount_confirmations' AND policyname='dac_insert') THEN
    CREATE POLICY "dac_insert" ON deal_amount_confirmations FOR INSERT WITH CHECK (auth.uid() IN (builder_id, lender_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='deal_amount_confirmations' AND policyname='dac_update') THEN
    CREATE POLICY "dac_update" ON deal_amount_confirmations FOR UPDATE USING (auth.uid() IN (builder_id, lender_id));
  END IF;
END $$;

-- ── 2. Add agreed_amount and deal_confirmed_at to deals
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS agreed_amount      NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS deal_confirmed_at  TIMESTAMPTZ;
`;

console.log("Copy and run the following SQL in your Supabase SQL Editor:\n");
console.log(SQL);
