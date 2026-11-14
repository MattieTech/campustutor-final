-- ============================================================
-- migration_v2_launch.sql — CampusTutor AI 2.0 Launch Upgrade
-- Safe, idempotent migration for Supabase PostgreSQL.
-- Run this in Supabase Dashboard → SQL Editor.
-- ============================================================

-- ── 1. EXTEND PROFILES TABLE ──────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS coins                   INT DEFAULT 5,
  ADD COLUMN IF NOT EXISTS last_daily_bonus        DATE,
  ADD COLUMN IF NOT EXISTS daily_streak_count      INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS subscription_source     VARCHAR(40) DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS subscription_granted_by UUID,
  ADD COLUMN IF NOT EXISTS subscription_note       TEXT,
  ADD COLUMN IF NOT EXISTS academic_level          VARCHAR(60) DEFAULT '200L Student',
  ADD COLUMN IF NOT EXISTS preferences             JSONB DEFAULT '{}'::jsonb;

-- Ensure existing free rows have sane defaults
UPDATE profiles SET coins = 5 WHERE coins IS NULL;
UPDATE profiles SET subscription_source = 'free' WHERE subscription_source IS NULL;

-- ── 2. COIN TRANSACTIONS LEDGER ───────────────────────────────
CREATE TABLE IF NOT EXISTS coin_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount           INT NOT NULL,
  action_type      VARCHAR(60) NOT NULL,
  transaction_type VARCHAR(40) NOT NULL DEFAULT 'system',
  description      TEXT,
  reason           TEXT,
  admin_id         UUID,
  balance_after    INT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE coin_transactions
  ADD COLUMN IF NOT EXISTS transaction_type VARCHAR(40) DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS reason           TEXT,
  ADD COLUMN IF NOT EXISTS admin_id         UUID;

CREATE INDEX IF NOT EXISTS idx_coin_tx_user_created ON coin_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coin_tx_admin_id ON coin_transactions(admin_id);

-- ── 3. CENTRAL AI TOOLS & USAGE LIMITS CONFIG ─────────────────
CREATE TABLE IF NOT EXISTS ai_tools_config (
  tool_key           VARCHAR(64) PRIMARY KEY,
  name               VARCHAR(120) NOT NULL,
  description        TEXT,
  category           VARCHAR(60) DEFAULT 'core',
  enabled            BOOLEAN DEFAULT TRUE,
  coin_cost          INT DEFAULT 0,
  allow_coins_bypass BOOLEAN DEFAULT FALSE,
  allowed_plans      TEXT[] DEFAULT ARRAY['free', 'plus', 'pro'],
  daily_limit_free   INT DEFAULT 0,
  daily_limit_plus   INT DEFAULT 20,
  daily_limit_pro    INT DEFAULT -1,
  monthly_limit_free INT DEFAULT 0,
  monthly_limit_plus INT DEFAULT 150,
  monthly_limit_pro  INT DEFAULT -1,
  extra_config       JSONB DEFAULT '{}'::jsonb,
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_by         UUID
);

-- ── 4. PER-USER TOOL USAGE TRACKING ───────────────────────────
CREATE TABLE IF NOT EXISTS tool_usage (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tool_key    VARCHAR(64) NOT NULL,
  period_type VARCHAR(20) NOT NULL CHECK (period_type IN ('daily', 'monthly')),
  period_key  VARCHAR(20) NOT NULL,
  usage_count INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, tool_key, period_type, period_key)
);

CREATE INDEX IF NOT EXISTS idx_tool_usage_lookup ON tool_usage(user_id, tool_key, period_type, period_key);

-- ── 5. PAYMENTS & SUBSCRIPTION LEDGER ─────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        VARCHAR(120) UNIQUE NOT NULL,
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  payment_type     VARCHAR(30) NOT NULL CHECK (payment_type IN ('subscription', 'coins')),
  plan_name        VARCHAR(40),
  duration_months  INT,
  package_id       VARCHAR(60),
  coins_awarded    INT DEFAULT 0,
  amount_kobo      BIGINT NOT NULL DEFAULT 0,
  currency         VARCHAR(10) DEFAULT 'NGN',
  status           VARCHAR(40) NOT NULL DEFAULT 'pending',
  gateway_response TEXT,
  metadata         JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  verified_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);

-- ── 6. AWARDED XP DEDUPLICATION TABLE ─────────────────────────
CREATE TABLE IF NOT EXISTS awarded_xp (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, document_id, activity_type)
);

-- ── 7. ATOMIC COIN ADJUSTMENT FUNCTION (RACE-CONDITION SAFE) ──
CREATE OR REPLACE FUNCTION adjust_user_coins(
  p_user_id UUID,
  p_delta INT,
  p_action_type VARCHAR(60),
  p_transaction_type VARCHAR(40),
  p_description TEXT,
  p_reason TEXT DEFAULT NULL,
  p_admin_id UUID DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, new_balance INT, error_msg TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current INT;
  v_next INT;
BEGIN
  SELECT COALESCE(coins, 0) INTO v_current
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 0, 'Profile not found.'::TEXT;
    RETURN;
  END IF;

  v_next := v_current + p_delta;
  IF v_next < 0 THEN
    RETURN QUERY SELECT FALSE, v_current, format('Insufficient coins. Available: %s, Required: %s', v_current, ABS(p_delta));
    RETURN;
  END IF;

  UPDATE profiles SET coins = v_next WHERE id = p_user_id;

  INSERT INTO coin_transactions (
    user_id, amount, action_type, transaction_type, description, reason, admin_id, balance_after
  ) VALUES (
    p_user_id, p_delta, p_action_type, p_transaction_type, p_description, p_reason, p_admin_id, v_next
  );

  RETURN QUERY SELECT TRUE, v_next, NULL::TEXT;
END;
$$;

-- ── 8. ATOMIC TOOL USAGE INCREMENT FUNCTION ───────────────────
CREATE OR REPLACE FUNCTION increment_tool_usage(
  p_user_id UUID,
  p_tool_key VARCHAR(64),
  p_daily_key VARCHAR(20),
  p_monthly_key VARCHAR(20)
)
RETURNS TABLE(daily_count INT, monthly_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_daily INT;
  v_monthly INT;
BEGIN
  INSERT INTO tool_usage (user_id, tool_key, period_type, period_key, usage_count, updated_at)
  VALUES (p_user_id, p_tool_key, 'daily', p_daily_key, 1, NOW())
  ON CONFLICT (user_id, tool_key, period_type, period_key)
  DO UPDATE SET usage_count = tool_usage.usage_count + 1, updated_at = NOW()
  RETURNING usage_count INTO v_daily;

  INSERT INTO tool_usage (user_id, tool_key, period_type, period_key, usage_count, updated_at)
  VALUES (p_user_id, p_tool_key, 'monthly', p_monthly_key, 1, NOW())
  ON CONFLICT (user_id, tool_key, period_type, period_key)
  DO UPDATE SET usage_count = tool_usage.usage_count + 1, updated_at = NOW()
  RETURNING usage_count INTO v_monthly;

  RETURN QUERY SELECT v_daily, v_monthly;
END;
$$;

-- ── 9. RLS POLICIES ───────────────────────────────────────────
ALTER TABLE coin_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_tools_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own coin_transactions" ON coin_transactions;
CREATE POLICY "Users read own coin_transactions" ON coin_transactions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access coin_transactions" ON coin_transactions;
CREATE POLICY "Service role full access coin_transactions" ON coin_transactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own tool_usage" ON tool_usage;
CREATE POLICY "Users read own tool_usage" ON tool_usage
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access tool_usage" ON tool_usage;
CREATE POLICY "Service role full access tool_usage" ON tool_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own payments" ON payments;
CREATE POLICY "Users read own payments" ON payments
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access payments" ON payments;
CREATE POLICY "Service role full access payments" ON payments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public read ai_tools_config" ON ai_tools_config;
CREATE POLICY "Public read ai_tools_config" ON ai_tools_config
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Service role full access ai_tools_config" ON ai_tools_config;
CREATE POLICY "Service role full access ai_tools_config" ON ai_tools_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);
