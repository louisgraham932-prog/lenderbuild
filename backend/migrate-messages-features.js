/**
 * Migration: Message Features
 * Run the SQL below in the Supabase SQL editor.
 *
 * Adds: scheduled messages (scheduled_at, status), message editing (edited_at)
 * Also enables RLS policies for UPDATE and DELETE on messages.
 */

const sql = `
-- Scheduled messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent';

-- Message editing
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- Backfill existing rows
UPDATE messages SET status = 'sent' WHERE status IS NULL;

-- Allow senders to update their own messages (for editing + scheduling)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'Users can update their own messages'
  ) THEN
    CREATE POLICY "Users can update their own messages"
      ON messages FOR UPDATE
      USING (auth.uid() = sender_id)
      WITH CHECK (auth.uid() = sender_id);
  END IF;
END $$;

-- Allow senders to delete their own messages (cancel scheduled)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'Users can delete their own messages'
  ) THEN
    CREATE POLICY "Users can delete their own messages"
      ON messages FOR DELETE
      USING (auth.uid() = sender_id);
  END IF;
END $$;
`;

console.log("Run this SQL in Supabase SQL editor:");
console.log(sql);
