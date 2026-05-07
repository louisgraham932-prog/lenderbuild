// Run this SQL in the Supabase SQL Editor to set up document review
const SQL = `
CREATE TABLE IF NOT EXISTS document_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  document_type text NOT NULL,
  file_path text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE(user_id, document_type)
);

ALTER TABLE document_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "builders_insert_own" ON document_submissions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "builders_update_own" ON document_submissions
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND status = 'pending');

CREATE POLICY "builders_read_own" ON document_submissions
  FOR SELECT USING (auth.uid() = user_id);
`;
console.log(SQL);
