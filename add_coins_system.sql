-- ============================================================
-- add_coins_system.sql — CampusCoins, Daily Rewards & Wallet System
-- Run this in your Supabase SQL Editor.
-- ============================================================

-- 1. Add coin & daily bonus tracking columns to profiles (scarce coin economy: starting 5 coins)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS coins               INT DEFAULT 5,
  ADD COLUMN IF NOT EXISTS last_daily_bonus    DATE,
  ADD COLUMN IF NOT EXISTS daily_streak_count  INT DEFAULT 1;

-- 2. Create coin transactions ledger table
CREATE TABLE IF NOT EXISTS coin_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount        INT NOT NULL, -- positive for earnings/purchases, negative for spends
  action_type   VARCHAR(60) NOT NULL, -- 'signup_bonus', 'daily_login', 'buy_coins', 'assignment_solver', 'mock_exam', etc.
  description   TEXT,
  balance_after INT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Enable RLS
ALTER TABLE coin_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own coin transactions" ON coin_transactions;
CREATE POLICY "Users can read own coin transactions"
  ON coin_transactions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "service_role full access to coin_transactions" ON coin_transactions;
CREATE POLICY "service_role full access to coin_transactions"
  ON coin_transactions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
