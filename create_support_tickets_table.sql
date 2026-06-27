-- ── CREATE SUPPORT TICKETS TABLE FOR CAMPUSTUTOR AI ──
-- Run this in your Supabase SQL Editor to enable the Customer Help Desk ticket system.

CREATE TABLE IF NOT EXISTS support_tickets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  subject    VARCHAR(255) NOT NULL,
  message    TEXT NOT NULL,
  status     VARCHAR(50) DEFAULT 'open', -- 'open' or 'resolved'
  reply      TEXT,                       -- Reply message from admin
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS (Row Level Security) if your project enforces it
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Users can read own support tickets" ON support_tickets;
DROP POLICY IF EXISTS "Users can insert own support tickets" ON support_tickets;
DROP POLICY IF EXISTS "service_role full access to support tickets" ON support_tickets;

-- Create access policies
CREATE POLICY "Users can read own support tickets" ON support_tickets
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own support tickets" ON support_tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "service_role full access to support tickets" ON support_tickets
  FOR ALL USING (true);

-- Disable RLS for standard backend server access matching existing tables pattern
ALTER TABLE support_tickets DISABLE ROW LEVEL SECURITY;
