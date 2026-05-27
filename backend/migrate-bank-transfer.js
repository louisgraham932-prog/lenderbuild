// Run this SQL in the Supabase SQL Editor to support direct bank transfer payments.
const SQL = `
-- Actual bank details on builder_profiles (previously only a boolean flag was stored)
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS bank_account_name text;
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS bank_sort_code text;
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS bank_account_number text;

-- Track payment-sent and receipt-confirmed timestamps on milestones
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS payment_sent_at timestamptz;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS receipt_confirmed_at timestamptz;
`;

console.log("Run the following SQL in your Supabase SQL editor:");
console.log(SQL);
