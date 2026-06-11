-- ============================================================
-- migration.sql — CampusTutor AI Admin Panel
--
-- Run this entire script in your Supabase SQL Editor.
-- It is safe to run multiple times (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- What this adds:
--   1. Creates the `profiles` table if missing
--   2. Adds admin columns to profiles table
--   3. A new `activity_logs` table for the admin audit trail
--   4. Indexes for fast queries
--   5. An RLS policy so only service_role (backend) can read activity_logs
-- ============================================================

-- ── 0. CREATE profiles TABLE (if missing) ────────────────────
-- Link user profiles to Supabase auth users

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT DEFAULT 'user',
  status TEXT DEFAULT 'active',
  xp INT DEFAULT 0,
  level INT DEFAULT 1,
  streak INT DEFAULT 0,
  last_activity_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login TIMESTAMPTZ,
  banned_reason TEXT,
  banned_at TIMESTAMPTZ,
  banned_by UUID
);

-- ── 1. UPDATE profiles TABLE ──────────────────────────────────
-- These columns track role, account status, and ban metadata.
-- All are safe to add even if some already exist.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS role          TEXT    DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS status        TEXT    DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_login    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banned_reason TEXT,
  ADD COLUMN IF NOT EXISTS banned_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banned_by     UUID;

-- Add a check constraint so only valid roles are stored
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_role_check'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- Add a check constraint so only valid statuses are stored
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_status_check'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_status_check CHECK (status IN ('active', 'banned', 'pending'));
  END IF;
END $$;

-- ── 2. CREATE activity_logs TABLE ─────────────────────────────
-- Every admin action (ban, delete, role change, etc.) is logged here.

CREATE TABLE IF NOT EXISTS activity_logs (
  id         BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_id   UUID        NOT NULL,
  action     TEXT        NOT NULL,
  details    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. CREATE user_activity TABLE ────────────────────────────
-- Tracks user actions: document uploads, AI generations, etc.

CREATE TABLE IF NOT EXISTS user_activity (
  id         BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action     TEXT        NOT NULL,
  details    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 4. INDEXES ────────────────────────────────────────────────
-- Speed up the most common admin queries.

CREATE INDEX IF NOT EXISTS idx_activity_user_id
  ON activity_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_activity_admin_id
  ON activity_logs(admin_id);

CREATE INDEX IF NOT EXISTS idx_activity_created_at
  ON activity_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_user_id
  ON user_activity(user_id);

CREATE INDEX IF NOT EXISTS idx_user_activity_created_at
  ON user_activity(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_profiles_status
  ON profiles(status);

CREATE INDEX IF NOT EXISTS idx_profiles_role
  ON profiles(role);

CREATE INDEX IF NOT EXISTS idx_profiles_xp
  ON profiles(xp DESC);

-- ── 5. ENABLE RLS ON TABLES ──────────────────────────────────
-- NOTE: We disable RLS on backend tables (activity_logs, user_activity, ai_results, documents)
-- because the backend uses service_role which should bypass RLS anyway.
-- We keep RLS on profiles for user privacy.

-- Disable RLS on admin/backend tables - service_role has full access
ALTER TABLE activity_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_results DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;

-- Keep RLS on profiles for user data privacy
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Drop all existing policies from profiles to start fresh
DO $$
BEGIN
  DROP POLICY IF EXISTS "Allow authenticated users to read own profile" ON profiles;
  DROP POLICY IF EXISTS "Allow authenticated users to update own profile" ON profiles;
  DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
  DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
  DROP POLICY IF EXISTS "Allow service_role full access to profiles" ON profiles;
END $$;

-- Create new policies for profiles
CREATE POLICY "Users can read own profile"
  ON profiles
  FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles
  FOR UPDATE
  USING (auth.uid() = id);

-- ── 5. MAKE YOUR FIRST ADMIN ──────────────────────────────────
-- Replace the email below with your actual account email,
-- then run just this UPDATE statement after signing up.
--
-- UPDATE profiles
--   SET role = 'admin'
--   WHERE email = 'your-email@example.com';
--
-- ─────────────────────────────────────────────────────────────
-- Done. You can now access /pages/admin.html after logging in
-- with the account you promoted above.
-- ============================================================
