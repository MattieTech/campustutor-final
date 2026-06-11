// ============================================================
// utils/supabase.js — Supabase database client
//
// Supabase is your database + authentication service.
// This file creates ONE shared connection to Supabase that all
// your routes can import and use.
//
// Think of it like a phone — you configure it once here,
// then every part of your app can "call" the database through it.
// ============================================================

const { createClient } = require("@supabase/supabase-js");

// These values come from your Supabase project dashboard
// NEVER hardcode them — always use environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // "service_role" key (backend only!)

// Validate that the keys exist
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in your .env file!"
  );
  process.exit(1); // Stop the server — we can't run without a database
}

// Create and export the Supabase client
// The service key gives us admin-level access (bypass RLS policies)
// Only use this on the BACKEND — never expose it to the frontend!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

module.exports = supabase;
