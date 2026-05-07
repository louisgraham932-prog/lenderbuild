// Run this SQL in the Supabase SQL Editor to add the repayment system
const SQL = `
-- 1. Add repayment and legal charge fields to deals
ALTER TABLE deals ADD COLUMN IF NOT EXISTS return_type text CHECK (return_type IN ('fixed_interest','rental_split','equity_stake'));
ALTER TABLE deals ADD COLUMN IF NOT EXISTS interest_rate numeric;           -- annual % for fixed interest
ALTER TABLE deals ADD COLUMN IF NOT EXISTS loan_term_months integer;        -- number of monthly payments
ALTER TABLE deals ADD COLUMN IF NOT EXISTS rental_split_pct numeric;        -- % of rental income to lender
ALTER TABLE deals ADD COLUMN IF NOT EXISTS estimated_monthly_rental numeric; -- estimated monthly rental income
ALTER TABLE deals ADD COLUMN IF NOT EXISTS equity_pct numeric;              -- % equity stake
ALTER TABLE deals ADD COLUMN IF NOT EXISTS repayment_start_date date;       -- when first repayment is due
ALTER TABLE deals ADD COLUMN IF NOT EXISTS legal_confirmed_lender boolean DEFAULT false;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS legal_confirmed_builder boolean DEFAULT false;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS legal_solicitor_name text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS legal_solicitor_ref text;

-- 2. Repayments table
CREATE TABLE IF NOT EXISTS repayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  payment_index integer NOT NULL,
  amount numeric NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','processing','paid','missed')),
  paid_at timestamptz,
  stripe_session_id text,
  confirmation_number text,
  missed_alert_sent boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE repayments ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "repayments_select" ON repayments
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM deals WHERE id = deal_id AND (builder_id = auth.uid() OR lender_id = auth.uid()))
  );

CREATE POLICY IF NOT EXISTS "repayments_update_own" ON repayments
  FOR UPDATE USING (true);
`;

console.log(SQL);
