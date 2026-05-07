/**
 * Migration: notifications table for in-app notification bell.
 * Run this SQL in the Supabase SQL Editor.
 */
const sql = `
CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type       text NOT NULL DEFAULT 'info',
  message    text NOT NULL DEFAULT '',
  read       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Users manage own notifications') THEN
    CREATE POLICY "Users manage own notifications" ON notifications
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- Let service role insert notifications for other users (triggered by events)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Service role can insert') THEN
    CREATE POLICY "Service role can insert" ON notifications
      FOR INSERT WITH CHECK (true);
  END IF;
END $$;

-- Realtime
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'notifications') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
END $$;
`;

console.log("Run the following SQL in your Supabase SQL Editor:\n");
console.log(sql);
