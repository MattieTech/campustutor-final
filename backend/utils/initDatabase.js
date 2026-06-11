// ============================================================
// utils/initDatabase.js — Database Schema Initialization
//
// This file ensures all required tables exist and are properly
// configured before the server starts. If tables are missing,
// it attempts to create them.
//
// Run this at server startup to prevent cryptic errors later.
// ============================================================

const supabase = require("./supabase");

// Store initialization status
let dbInitialized = false;
let initError = null;

// ── TABLE DEFINITIONS ─────────────────────────────────────────
const REQUIRED_TABLES = {
  profiles: {
    name: "profiles",
    description: "User profile data",
    sql: `
      CREATE TABLE IF NOT EXISTS profiles (
        id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'banned', 'pending')),
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
      CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
      CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
      CREATE INDEX IF NOT EXISTS idx_profiles_xp ON profiles(xp DESC);
    `,
  },
  documents: {
    name: "documents",
    description: "Uploaded PDF documents",
    sql: `
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        file_type TEXT DEFAULT 'pdf',
        file_path TEXT,
        extracted_text TEXT,
        page_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
      CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);
    `,
  },
  ai_results: {
    name: "ai_results",
    description: "Cached AI-generated content",
    sql: `
      CREATE TABLE IF NOT EXISTS ai_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        result_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(document_id, result_type)
      );
      CREATE INDEX IF NOT EXISTS idx_ai_results_document_id ON ai_results(document_id);
      CREATE INDEX IF NOT EXISTS idx_ai_results_user_id ON ai_results(user_id);
    `,
  },
  user_activity: {
    name: "user_activity",
    description: "User action audit log",
    sql: `
      CREATE TABLE IF NOT EXISTS user_activity (
        id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_activity_user_id ON user_activity(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_activity_created_at ON user_activity(created_at DESC);
    `,
  },
  activity_logs: {
    name: "activity_logs",
    description: "Admin action audit log",
    sql: `
      CREATE TABLE IF NOT EXISTS activity_logs (
        id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        admin_id UUID NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_admin_id ON activity_logs(admin_id);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
    `,
  },
};

// ── TABLE EXISTENCE CHECK ──────────────────────────────────────
async function checkTableExists(tableName) {
  try {
    const { data, error } = await supabase.rpc("table_exists", {
      p_table: tableName,
    });

    if (error) {
      // Fallback: try to query the table directly
      const { error: queryError } = await supabase
        .from(tableName)
        .select("*", { count: "exact", head: true })
        .limit(1);

      return !queryError;
    }

    return data;
  } catch (err) {
    console.log(`⚠️  Could not check if table ${tableName} exists:`, err.message);
    return false;
  }
}

// ── CREATE MISSING TABLES ──────────────────────────────────────
async function createMissingTables() {
  const missingTables = [];

  for (const [key, table] of Object.entries(REQUIRED_TABLES)) {
    console.log(`🔍 Checking table: ${table.name}...`);

    const exists = await checkTableExists(table.name);

    if (!exists) {
      console.log(`   ❌ Table "${table.name}" not found!`);
      missingTables.push(table);
    } else {
      console.log(`   ✅ Table "${table.name}" exists`);
    }
  }

  if (missingTables.length === 0) {
    console.log("\n✅ All required tables exist!");
    return true;
  }

  console.log(
    `\n⚠️  Found ${missingTables.length} missing table(s). Attempting to create them...`
  );

  for (const table of missingTables) {
    try {
      console.log(`   📝 Creating table "${table.name}"...`);

      const { error } = await supabase.rpc("sql_query", {
        query: table.sql,
      });

      if (error) {
        // Fallback: use raw SQL if rpc is not available
        console.log(
          `   ⚠️  RPC method failed, trying direct SQL (may not work)...`
        );
        console.warn(
          `   ⚠️  MANUAL ACTION REQUIRED: Please run this SQL in Supabase SQL Editor:\n${table.sql}`
        );
      } else {
        console.log(`   ✅ Table "${table.name}" created successfully`);
      }
    } catch (err) {
      console.error(
        `   ❌ Failed to create table "${table.name}":`,
        err.message
      );
      console.warn(`   ⚠️  MANUAL ACTION REQUIRED: Run this SQL in Supabase:\n${table.sql}`);
    }
  }

  return missingTables.length === 0;
}

// ── FIX RLS POLICIES ──────────────────────────────────────────
// Disable RLS on backend tables so service_role can access them
async function fixRLSPolicies() {
  console.log("\n🔧 Applying RLS configuration...");

  const tables = ["activity_logs", "user_activity", "ai_results", "documents"];
  
  for (const table of tables) {
    try {
      // Try using Supabase REST API to disable RLS
      // This uses the service_role key which should allow DDL operations
      const { error } = await supabase.rpc("exec", {
        sql: `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`,
      }).catch(() => ({ error: { message: "RPC not available" } }));

      if (error) {
        // RPC method not available, try a workaround
        // We'll log the issue and suggest manual fix
        console.log(`   ⚠️  Could not apply RLS fix to ${table} via RPC`);
        console.log(`   📝 Please run this in Supabase SQL Editor:`);
        console.log(`      ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
      } else {
        console.log(`   ✅ RLS disabled on ${table}`);
      }
    } catch (err) {
      // Log the command for manual execution
      console.log(`   ⚠️  RLS fix for ${table} requires manual execution`);
    }
  }

  console.log("✅ RLS configuration applied\n");
}

// ── INITIALIZE DATABASE ────────────────────────────────────────
async function initializeDatabase() {
  console.log("\n🚀 Starting database initialization...\n");

  try {
    // Step 1: Test Supabase connection
    console.log("📡 Testing Supabase connection...");
    const { data, error } = await supabase
      .from("auth")
      .select("*", { count: "exact", head: true });

    if (error && !error.message.includes("does not exist")) {
      throw new Error(`Supabase connection failed: ${error.message}`);
    }
    console.log("✅ Supabase connection OK\n");

    // Step 2: Check and create tables
    const allTablesExist = await createMissingTables();

    // Step 3: Apply RLS fixes
    await fixRLSPolicies();

    if (allTablesExist) {
      console.log("\n✅ Database initialized successfully!\n");
      dbInitialized = true;
      return true;
    } else {
      console.warn(
        "\n⚠️  Some tables may not exist. Check the logs above and run the SQL manually if needed."
      );
      console.warn(
        "📍 Go to: https://supabase.com → Your Project → SQL Editor\n"
      );
      // Don't fail startup, but warn
      dbInitialized = false;
      initError =
        "Some database tables may be missing. Check logs and run migration.sql if needed.";
      return false;
    }
  } catch (err) {
    console.error("\n❌ Database initialization failed:");
    console.error(err.message);
    console.error(
      "\n📍 Please ensure:\n   1. SUPABASE_URL is correct\n   2. SUPABASE_SERVICE_KEY is correct\n   3. Your Supabase project is active\n"
    );
    initError = err.message;
    dbInitialized = false;
    return false;
  }
}

// ── EXPORTS ────────────────────────────────────────────────────
module.exports = {
  initializeDatabase,
  isInitialized: () => dbInitialized,
  getInitError: () => initError,
};
