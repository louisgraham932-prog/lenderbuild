// Run this SQL in the Supabase SQL Editor to add enhanced legal protection checklist,
// repayment reminders, and builder bank details tracking.
const SQL = `
-- Enhanced legal checklist fields on deals (lender fills these in)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS legal_solicitor_instructed boolean DEFAULT false;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS legal_solicitor_firm text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS legal_charge_registered boolean DEFAULT false;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS legal_charge_ref text;

-- Builder bank details flag on builder_profiles
ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS bank_details_provided boolean DEFAULT false;

-- Repayment reminder tracking columns
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS reminder_3day_sent boolean DEFAULT false;
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS reminder_due_sent boolean DEFAULT false;
ALTER TABLE repayments ADD COLUMN IF NOT EXISTS reminder_7day_overdue_sent boolean DEFAULT false;
`;

console.log("Run the following SQL in your Supabase SQL editor:");
console.log(SQL);
