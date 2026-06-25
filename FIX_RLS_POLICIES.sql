-- ============================================================
-- Fix RLS Policies - Disable RLS on admin/backend tables
-- Run this in Supabase SQL Editor immediately!
-- ============================================================

-- Disable RLS on admin-only tables (backend uses service_role)
ALTER TABLE activity_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_results DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;

-- Disable RLS on profiles to avoid Row Level Security signup violations
ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE referrals DISABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals DISABLE ROW LEVEL SECURITY;
ALTER TABLE feedback DISABLE ROW LEVEL SECURITY;

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
