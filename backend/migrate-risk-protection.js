// Run this SQL in the Supabase SQL Editor to add risk protection features
const SQL = `
-- 1. Add property_value and flagged_default to deals
ALTER TABLE deals ADD COLUMN IF NOT EXISTS property_value numeric;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS flagged_default boolean DEFAULT false;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS frozen boolean DEFAULT false;

-- 2. Add due_date and default alert tracking to milestones
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS last_default_alert integer DEFAULT 0;

-- 3. Deal documents table (project-specific required docs)
CREATE TABLE IF NOT EXISTS deal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  doc_type text NOT NULL CHECK (doc_type IN ('site_insurance', 'public_liability', 'personal_guarantee', 'solicitor_confirmation')),
  file_path text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE(deal_id, doc_type)
);

ALTER TABLE deal_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "deal_docs_insert" ON deal_documents
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM deals WHERE id = deal_id AND builder_id = auth.uid())
  );

CREATE POLICY IF NOT EXISTS "deal_docs_select" ON deal_documents
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM deals WHERE id = deal_id AND (builder_id = auth.uid() OR lender_id = auth.uid()))
  );

-- 4. Disputes table
CREATE TABLE IF NOT EXISTS disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  raised_by uuid NOT NULL,
  raised_by_role text NOT NULL,
  raised_by_name text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'escalated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_notes text
);

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "disputes_insert" ON disputes
  FOR INSERT WITH CHECK (auth.uid() = raised_by);

CREATE POLICY IF NOT EXISTS "disputes_select" ON disputes
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM deals WHERE id = deal_id AND (builder_id = auth.uid() OR lender_id = auth.uid()))
  );

CREATE POLICY IF NOT EXISTS "disputes_update" ON disputes
  FOR UPDATE USING (true);
`;

console.log(SQL);
