-- ============================================================
-- Fix RLS Policies - Disable RLS on admin/backend tables
-- Run this in Supabase SQL Editor immediately!
-- ============================================================

-- Disable RLS on admin-only tables (backend uses service_role)
ALTER TABLE activity_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_results DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;

-- Keep profiles RLS for security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Drop all existing policies from profiles
DROP POLICY IF EXISTS "Allow authenticated users to read own profile" ON profiles;
DROP POLICY IF EXISTS "Allow authenticated users to update own profile" ON profiles;

-- Add back only necessary profile policies
CREATE POLICY "Users can read own profile"
  ON profiles
  FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles
  FOR UPDATE
  USING (auth.uid() = id);

-- ============================================================
-- Alternative: If you want to KEEP RLS, run this instead:
-- ============================================================
/*
-- Enable RLS with proper service_role bypass

-- For tables that need RLS, create permissive policies
-- These allow authenticated users their own data + service_role everything

ALTER TABLE user_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_activity" ON user_activity
  FOR ALL USING (auth.uid() = user_id OR auth.role() = 'service_role');

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_documents" ON documents
  FOR ALL USING (auth.uid() = user_id OR auth.role() = 'service_role');

ALTER TABLE ai_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_results" ON ai_results
  FOR ALL USING (auth.uid() = user_id OR auth.role() = 'service_role');

ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON activity_logs
  FOR ALL USING (auth.role() = 'service_role');

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_profile" ON profiles
  FOR ALL USING (auth.uid() = id OR auth.role() = 'service_role');
*/
