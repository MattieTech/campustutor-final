-- ============================================================
-- migration_addon.sql — Addons for Subscriptions, Referrals, and Withdrawals
-- Run this in your Supabase SQL Editor.
-- ============================================================

-- ── 1. ADD SUBSCRIPTION & VERIFICATION COLUMNS TO profiles ────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS plan                       VARCHAR(50) DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS subscription_status        VARCHAR(50) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS subscription_end           TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS referred_by                UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS referral_code              VARCHAR(50) UNIQUE,
  ADD COLUMN IF NOT EXISTS is_verified                BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_otp           VARCHAR(10),
  ADD COLUMN IF NOT EXISTS verification_otp_expires   TIMESTAMP WITH TIME ZONE;

-- ── 2. CREATE referrals TABLE ─────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referee_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reward_amount NUMERIC DEFAULT 0,
  status        VARCHAR(50) DEFAULT 'pending', -- 'pending', 'completed'
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ── 3. CREATE withdrawals TABLE ────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount         NUMERIC NOT NULL,
  status         VARCHAR(50) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  bank_name      VARCHAR(100) NOT NULL,
  account_number VARCHAR(50) NOT NULL,
  account_name   VARCHAR(100) NOT NULL,
  remark         TEXT,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  updated_at     TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ── 4. CREATE feedback TABLE ───────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  rating     INTEGER NOT NULL,
  comments   TEXT,
  category   VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ── 5. RLS POLICIES FOR SECURE ACCESS ─────────────────────────
-- Enable RLS on newly created tables
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Users can read own referrals" ON referrals;
DROP POLICY IF EXISTS "service_role full access to referrals" ON referrals;

DROP POLICY IF EXISTS "Users can read own withdrawals" ON withdrawals;
DROP POLICY IF EXISTS "service_role full access to withdrawals" ON withdrawals;

DROP POLICY IF EXISTS "Users can read own feedback" ON feedback;
DROP POLICY IF EXISTS "service_role full access to feedback" ON feedback;

-- Referrals policies
CREATE POLICY "Users can read own referrals" ON referrals
  FOR SELECT USING (auth.uid() = referrer_id OR auth.uid() = referee_id);
CREATE POLICY "service_role full access to referrals" ON referrals
  FOR ALL USING (true);

-- Withdrawals policies
CREATE POLICY "Users can read own withdrawals" ON withdrawals
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "service_role full access to withdrawals" ON withdrawals
  FOR ALL USING (true);

-- Feedback policies
CREATE POLICY "Users can read own feedback" ON feedback
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "service_role full access to feedback" ON feedback
  FOR ALL USING (true);
