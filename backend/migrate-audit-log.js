/**
 * Run this SQL in the Supabase SQL Editor to create the deal_audit_log table.
 * Safe to run multiple times (uses IF NOT EXISTS).
 */

const SQL = `
-- ─── DEAL AUDIT LOG ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deal_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     UUID        REFERENCES deals(id) ON DELETE SET NULL,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_name   TEXT,
  user_role   TEXT        CHECK (user_role IN ('lender','builder','admin')),
  action      TEXT        NOT NULL,
  details     JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_audit_log_deal_idx    ON deal_audit_log(deal_id);
CREATE INDEX IF NOT EXISTS deal_audit_log_user_idx    ON deal_audit_log(user_id);
CREATE INDEX IF NOT EXISTS deal_audit_log_action_idx  ON deal_audit_log(action);
CREATE INDEX IF NOT EXISTS deal_audit_log_created_idx ON deal_audit_log(created_at DESC);

-- Only admins (service role) can read; users cannot read their own audit log
ALTER TABLE deal_audit_log ENABLE ROW LEVEL SECURITY;
-- No SELECT policy → only service key (used by API) can read
`;

console.log("Run the following SQL in the Supabase SQL Editor:\n");
console.log(SQL);
