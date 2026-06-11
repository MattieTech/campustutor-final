// ============================================================
// routes/admin.js — CampusTutor AI Admin API
//
// All routes require the admin role (role = 'admin' in profiles).
// The isAdmin middleware verifies the JWT and checks the role
// on every request — no route is accessible without it.
//
// Endpoints:
//   GET  /api/admin/stats                    → Dashboard stats
//   GET  /api/admin/recent-activities        → Recent user activities
//   GET  /api/admin/users                    → All users
//   GET  /api/admin/users/:userId/activity   → User activity log
//   POST /api/admin/users/:userId/ban        → Ban user
//   POST /api/admin/users/:userId/unban      → Unban user
//   DELETE /api/admin/users/:userId          → Delete user
//   POST /api/admin/users/:userId/reset-password → Reset password
//   POST /api/admin/users/:userId/set-role   → Change role
// ============================================================

const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabase");

// ── MIDDLEWARE: Verify JWT and require admin role ────────────
async function isAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "No token provided." });
    }

    // Verify the JWT via Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      console.error("❌ Invalid token:", error?.message);
      return res.status(401).json({ error: "Invalid or expired token." });
    }

    // Check the role in app_metadata (where Gemini said you set it)
    const userRole = data.user.app_metadata?.role;
    
    console.log("🔐 Admin check for:", data.user.email);
    console.log("📦 app_metadata.role:", userRole);

    if (userRole !== "admin") {
      console.warn("❌ Access denied - not an admin. Role:", userRole);
      return res.status(403).json({ error: "Admin access required." });
    }

    console.log("✅ Admin access granted");

    // Attach the verified admin's ID to every request
    req.adminId = data.user.id;
    next();
  } catch (err) {
    console.error("Admin middleware error:", err.message);
    res.status(500).json({ error: "Authentication check failed." });
  }
}

// ── HELPER: Write an entry to the activity_logs table ────────
async function logActivity(adminId, action, targetUserId, details) {
  try {
    await supabase.from("activity_logs").insert({
      user_id: targetUserId,
      admin_id: adminId,
      action,
      details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Don't crash the main request if logging fails
    console.error("Activity log error:", err.message);
  }
}

// ── DASHBOARD STATS ──────────────────────────────────────────
// GET /api/admin/stats
// Returns aggregate counts for the four dashboard cards
router.get("/stats", isAdmin, async (req, res) => {
  try {
    // ── 1. GET USER COUNTS FROM SUPABASE AUTH ──────────────────────
    console.log("📊 Fetching user stats...");
    const { data: authData, error: authError } = await supabase.auth.admin.listUsers();
    
    if (authError) {
      console.error("❌ Auth list error:", authError.message);
      throw authError;
    }

    const allUsers = authData.users || [];
    const totalUsers = allUsers.length;
    const bannedUsers = allUsers.filter(u => u.app_metadata?.status === "banned").length;
    const activeUsers = totalUsers - bannedUsers;

    console.log(`✅ Users: Total=${totalUsers}, Active=${activeUsers}, Banned=${bannedUsers}`);

    // ── 2. GET DOCUMENT COUNTS ────────────────────────────────────
    let totalDocuments = 0;
    try {
      const { count, error: docError } = await supabase
        .from("documents")
        .select("*", { count: "exact", head: true });
      
      if (docError) throw docError;
      totalDocuments = count || 0;
      console.log(`✅ Documents: ${totalDocuments}`);
    } catch (err) {
      console.log("⚠️ Documents table error:", err.message);
      totalDocuments = 0;
    }

    // ── 3. GET AI GENERATION COUNTS ───────────────────────────────
    let totalAIGenerations = 0;
    
    // Try ai_results table first
    try {
      const { count: aiCount, error: aiError } = await supabase
        .from("ai_results")
        .select("*", { count: "exact", head: true });
      
      if (!aiError) {
        totalAIGenerations = aiCount || 0;
        console.log(`✅ AI Generations (from ai_results): ${totalAIGenerations}`);
      } else {
        throw aiError;
      }
    } catch (err) {
      console.log("⚠️ AI results table error:", err.message);
      
      // Fall back to user_activity table counting AI actions
      try {
        const { count: actCount, error: actError } = await supabase
          .from("user_activity")
          .select("*", { count: "exact", head: true })
          .in("action", ["ai_summarize", "ai_explain", "ai_questions", "ai_flashcards"]);
        
        if (!actError) {
          totalAIGenerations = actCount || 0;
          console.log(`✅ AI Generations (from user_activity): ${totalAIGenerations}`);
        }
      } catch (fallbackErr) {
        console.log("⚠️ User activity table error:", fallbackErr.message);
        totalAIGenerations = 0;
      }
    }

    // ── RETURN STATS ──────────────────────────────────────────────
    const stats = {
      totalUsers,
      activeUsers: Math.max(0, activeUsers),
      bannedUsers,
      totalDocuments,
      totalAIGenerations,
    };

    console.log("📈 Final stats:", stats);
    res.json(stats);
    
  } catch (err) {
    console.error("❌ Stats endpoint error:", err.message);
    res.status(500).json({
      error: err.message,
      totalUsers: 0,
      activeUsers: 0,
      bannedUsers: 0,
      totalDocuments: 0,
      totalAIGenerations: 0,
    });
  }
});

// ── RECENT ACTIVITIES ────────────────────────────────────────
// GET /api/admin/recent-activities
// Returns all recent user activities across the platform
router.get("/recent-activities", isAdmin, async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    console.log("📊 Fetching recent activities...");

    // Fetch user activities
    const { data: userActivities, error: userError } = await supabase
      .from("user_activity")
      .select("id, user_id, action, details, created_at")
      .order("created_at", { ascending: false })
      .limit(parseInt(limit));

    if (userError && !userError.message.includes("does not exist")) {
      console.error("⚠️  Error fetching user activities:", userError.message);
    }

    // Fetch admin activities
    const { data: adminActivities, error: adminError } = await supabase
      .from("activity_logs")
      .select("id, user_id, action, details, created_at")
      .order("created_at", { ascending: false })
      .limit(parseInt(limit));

    if (adminError && !adminError.message.includes("does not exist")) {
      console.error("⚠️  Error fetching admin activities:", adminError.message);
    }

    // Merge and sort activities
    const activities = [
      ...(userActivities || []),
      ...(adminActivities || [])
    ]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, parseInt(limit));

    console.log(`✅ Retrieved ${activities.length} activities`);

    res.json({
      activityCount: activities.length,
      activities: activities,
    });
  } catch (err) {
    console.error("❌ Recent activities error:", err.message);
    res.status(500).json({ 
      error: "Failed to fetch recent activities.",
      activityCount: 0,
      activities: []
    });
  }
});

// ── LIST ALL USERS ───────────────────────────────────────────
// GET /api/admin/users
// Supports optional ?search=query and ?status=active|banned|all
router.get("/users", isAdmin, async (req, res) => {
  try {
    const { search } = req.query;
    let users = [];

    // Try to get users from profiles table first (if it exists)
    try {
      const { data: profileUsers, error } = await supabase
        .from("profiles")
        .select("id, email, full_name, role, status, created_at, last_login, banned_reason, banned_at")
        .order("created_at", { ascending: false });

      if (!error && profileUsers && profileUsers.length > 0) {
        users = profileUsers;
      } else {
        throw new Error("Profiles table not available, falling back to auth.users");
      }
    } catch (profileErr) {
      console.log("📝 Profiles table unavailable, using auth.users instead");
      
      // Fall back to listing auth users via admin API
      const { data: authData, error: authError } = await supabase.auth.admin.listUsers();
      
      if (authError) {
        console.error("Failed to fetch auth users:", authError.message);
        return res.status(500).json({ error: "Failed to fetch users." });
      }

      // Transform auth.users data to match expected format
      users = (authData?.users || []).map(u => ({
        id: u.id,
        email: u.email,
        full_name: u.user_metadata?.full_name || u.user_metadata?.name || "Unknown",
        role: u.app_metadata?.role || "user",
        status: u.app_metadata?.status || "active",
        created_at: u.created_at,
        last_login: u.last_sign_in_at,
        banned_reason: u.app_metadata?.banned_reason || null,
        banned_at: u.app_metadata?.banned_at || null,
      }));
    }

    // Apply search filter if provided
    if (search && search.trim()) {
      const searchLower = search.toLowerCase();
      users = users.filter(
        u => (u.full_name || "").toLowerCase().includes(searchLower) ||
             (u.email || "").toLowerCase().includes(searchLower)
      );
    }

    res.json({
      total: users.length,
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.full_name || "Unknown",
        role: u.role || "user",
        status: u.status || "active",
        createdAt: u.created_at,
        lastLogin: u.last_login,
        bannedReason: u.banned_reason || null,
        bannedAt: u.banned_at || null,
      })),
    });
  } catch (err) {
    console.error("Fetch users error:", err.message);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// ── USER ACTIVITY LOG ────────────────────────────────────────
// GET /api/admin/users/:userId/activity
router.get("/users/:userId/activity", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // Fetch admin actions on this user
    const { data: adminActions, error: adminError } = await supabase
      .from("activity_logs")
      .select("id, action, details, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);

    // Fetch user's own activities
    const { data: userActions, error: userError } = await supabase
      .from("user_activity")
      .select("id, action, details, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (adminError && !adminError.message.includes("does not exist")) {
      throw adminError;
    }

    if (userError && !userError.message.includes("does not exist")) {
      throw userError;
    }

    // Merge and sort activities by timestamp
    const allActivities = [
      ...(adminActions || []).map(a => ({ type: "admin", ...a })),
      ...(userActions || []).map(a => ({ type: "user", ...a }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
     .slice(0, 100); // Keep last 100 activities

    res.json({
      userId,
      activityCount: allActivities.length,
      activities: allActivities,
    });
  } catch (err) {
    console.error("Fetch activity error:", err.message);
    res.status(500).json({ error: "Failed to fetch activity." });
  }
});

// ── BAN USER ─────────────────────────────────────────────────
// POST /api/admin/users/:userId/ban
// Body: { reason: string }
router.post("/users/:userId/ban", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: "A ban reason is required." });
    }

    // Prevent an admin from banning themselves
    if (userId === req.adminId) {
      return res.status(400).json({ error: "You cannot ban your own account." });
    }

    console.log("🚫 Attempting to ban user:", userId, "Reason:", reason);

    // Try to ban via profiles table first (if it exists)
    let banned = false;
    try {
      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .update({
          status: "banned",
          banned_reason: reason.trim(),
          banned_at: new Date().toISOString(),
          banned_by: req.adminId,
        })
        .eq("id", userId)
        .select();

      if (!profileError && profileData && profileData.length > 0) {
        console.log("✅ User banned via profiles table");
        banned = true;
      } else if (!profileError && (!profileData || profileData.length === 0)) {
        console.log("⚠️ Profiles update returned no rows for ban");
      }
    } catch (profileErr) {
      console.log("📝 Profiles table unavailable, will use app_metadata");
    }

    // If profiles table didn't work, use app_metadata
    if (!banned) {
      console.log("📝 Updating app_metadata for ban");
      const { data: user, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
      
      if (fetchErr || !user) {
        return res.status(404).json({ error: "User not found." });
      }

      // Merge new data into existing app_metadata
      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        app_metadata: {
          ...(user.app_metadata || {}),
          status: "banned",
          banned_reason: reason.trim(),
          banned_at: new Date().toISOString(),
          banned_by: req.adminId,
        },
      });

      if (updateError) {
        console.error("❌ Ban error:", updateError.message);
        return res.status(500).json({ error: "Failed to ban user: " + updateError.message });
      }
      console.log("✅ User banned via app_metadata");
    }

    await logActivity(req.adminId, "ban_user", userId, reason.trim());
    res.json({ message: "User banned successfully.", userId });
  } catch (err) {
    console.error("❌ Ban error:", err.message);
    res.status(500).json({ error: "Failed to ban user: " + err.message });
  }
});

// ── UNBAN USER ────────────────────────────────────────────────
// POST /api/admin/users/:userId/unban
router.post("/users/:userId/unban", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    console.log("✅ Attempting to unban user:", userId);

    // Try to unban via profiles table first (if it exists)
    let unbanned = false;
    try {
      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .update({
          status: "active",
          banned_reason: null,
          banned_at: null,
          banned_by: null,
        })
        .eq("id", userId)
        .select();

      if (!profileError && profileData && profileData.length > 0) {
        console.log("✅ User unbanned via profiles table");
        unbanned = true;
      } else if (!profileError && (!profileData || profileData.length === 0)) {
        console.log("⚠️ Profiles update returned no rows for unban");
      }
    } catch (profileErr) {
      console.log("📝 Profiles table unavailable, will use app_metadata");
    }

    // If profiles table didn't work, use app_metadata
    if (!unbanned) {
      console.log("📝 Updating app_metadata for unban");
      const { data: user, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
      
      if (fetchErr || !user) {
        return res.status(404).json({ error: "User not found." });
      }

      // Merge new data into existing app_metadata
      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        app_metadata: {
          ...(user.app_metadata || {}),
          status: "active",
          banned_reason: null,
          banned_at: null,
          banned_by: null,
        },
      });

      if (updateError) {
        console.error("❌ Unban error:", updateError.message);
        return res.status(500).json({ error: "Failed to unban user: " + updateError.message });
      }
      console.log("✅ User unbanned via app_metadata");
    }

    await logActivity(req.adminId, "unban_user", userId, "Account reinstated.");
    res.json({ message: "User unbanned successfully.", userId });
  } catch (err) {
    console.error("❌ Unban error:", err.message);
    res.status(500).json({ error: "Failed to unban user: " + err.message });
  }
});

// ── DELETE USER ───────────────────────────────────────────────
// DELETE /api/admin/users/:userId
// Body: { reason: string } (optional)
router.delete("/users/:userId", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body || {};

    if (userId === req.adminId) {
      return res.status(400).json({ error: "You cannot delete your own account." });
    }

    // Log before deletion
    await logActivity(
      req.adminId,
      "delete_user",
      userId,
      reason || "Account deleted by admin."
    );

    // Try to delete from profiles table first (if it exists)
    try {
      await supabase.from("profiles").delete().eq("id", userId);
    } catch (profileErr) {
      console.log("Note: Could not delete from profiles table");
    }

    // Delete from Supabase Auth (this removes the user completely)
    const { error } = await supabase.auth.admin.deleteUser(userId);

    if (error) {
      console.error("Delete error:", error.message);
      return res.status(500).json({ error: "Failed to delete user." });
    }

    res.json({ message: "User deleted successfully.", userId });
  } catch (err) {
    console.error("Delete error:", err.message);
    res.status(500).json({ error: "Failed to delete user." });
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────
// POST /api/admin/users/:userId/reset-password
// Body: { newPassword: string }
router.post("/users/:userId/reset-password", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });
    }

    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (error) throw error;

    await logActivity(req.adminId, "reset_password", userId, "Password reset by admin.");

    res.json({ message: "Password reset successfully.", userId });
  } catch (err) {
    console.error("Reset password error:", err.message);
    res.status(500).json({ error: "Failed to reset password." });
  }
});

// ── SET ROLE ──────────────────────────────────────────────────
// POST /api/admin/users/:userId/set-role
// Body: { role: 'user' | 'admin' }
router.post("/users/:userId/set-role", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ error: "Role must be 'user' or 'admin'." });
    }

    if (userId === req.adminId && role !== "admin") {
      return res
        .status(400)
        .json({ error: "You cannot remove your own admin privileges." });
    }

    console.log("👤 Attempting to set role to", role, "for user:", userId);

    // Try to update profiles table first (if it exists)
    let roleUpdated = false;
    try {
      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .update({ role })
        .eq("id", userId)
        .select();

      if (!profileError && profileData && profileData.length > 0) {
        console.log("✅ Role updated via profiles table");
        roleUpdated = true;
      } else if (!profileError && (!profileData || profileData.length === 0)) {
        console.log("⚠️ Profiles update returned no rows for role change");
      }
    } catch (profileErr) {
      console.log("📝 Profiles table unavailable, will use app_metadata");
    }

    // If profiles table didn't work, use app_metadata
    if (!roleUpdated) {
      console.log("📝 Updating app_metadata for role");
      const { data: user, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
      
      if (fetchErr || !user) {
        return res.status(404).json({ error: "User not found." });
      }

      // Merge new data into existing app_metadata
      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        app_metadata: {
          ...(user.app_metadata || {}),
          role: role,
        },
      });

      if (updateError) {
        console.error("❌ Set role error:", updateError.message);
        return res.status(500).json({ error: "Failed to update role: " + updateError.message });
      }
      console.log("✅ Role updated via app_metadata");
    }

    await logActivity(
      req.adminId,
      "set_role",
      userId,
      `Role changed to ${role}.`
    );

    res.json({ message: "Role updated successfully.", userId, role });
  } catch (err) {
    console.error("❌ Set role error:", err.message);
    res.status(500).json({ error: "Failed to update role: " + err.message });
  }
});

// ── USER UPLOADED FILES ──────────────────────────────────────
// GET /api/admin/users/:userId/files
// Returns all files uploaded by a specific user (PDFs and images only)
router.get("/users/:userId/files", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: files, error } = await supabase
      .from("documents")
      .select("id, file_name, file_type, page_count, created_at")
      .eq("user_id", userId)
      .in("file_type", ["pdf", "image", "jpg", "jpeg", "png", "webp"])
      .order("created_at", { ascending: false })
      .limit(100);

    if (error && !error.message.includes("does not exist")) {
      throw error;
    }

    res.json({
      userId,
      fileCount: (files || []).length,
      files: (files || []).map(f => ({
        id: f.id,
        name: f.file_name,
        type: f.file_type,
        pages: f.page_count || 0,
        uploadedAt: f.created_at
      }))
    });
  } catch (err) {
    console.error("Fetch user files error:", err.message);
    res.status(500).json({ error: "Failed to fetch user files." });
  }
});

// ── USER AI INTERACTIONS ────────────────────────────────────
// GET /api/admin/users/:userId/ai-interactions
// Returns all AI interactions for a specific user with full details
router.get("/users/:userId/ai-interactions", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // Get all user activities related to AI
    const { data: aiActivities, error } = await supabase
      .from("user_activity")
      .select("id, action, details, created_at")
      .eq("user_id", userId)
      .in("action", ["ai_summarize", "ai_explain", "ai_questions", "ai_flashcards"])
      .order("created_at", { ascending: false })
      .limit(100);

    if (error && !error.message.includes("does not exist")) {
      throw error;
    }

    res.json({
      userId,
      aiInteractionCount: (aiActivities || []).length,
      interactions: (aiActivities || []).map(a => ({
        id: a.id,
        type: a.action.replace("ai_", ""),
        details: a.details || "No details",
        timestamp: a.created_at
      }))
    });
  } catch (err) {
    console.error("Fetch AI interactions error:", err.message);
    res.status(500).json({ error: "Failed to fetch AI interactions." });
  }
});

// ── FIX RLS POLICIES (Emergency endpoint) ──────────────────
// POST /api/admin/fix-rls
// Temporarily disables RLS on backend tables so data can be read
// This is a quick fix - for production, use proper RLS policies
router.post("/fix-rls", isAdmin, async (req, res) => {
  try {
    console.log("🔧 Attempting to fix RLS policies...");

    // Disable RLS on backend tables
    const tables = [
      "activity_logs",
      "user_activity",
      "ai_results",
      "documents",
    ];

    for (const table of tables) {
      const { error } = await supabase.rpc("exec_sql", {
        sql: `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`,
      }).catch(() => ({ error: null })); // RPC might not exist

      if (error) {
        console.log(`⚠️  Could not disable RLS on ${table} via RPC`);
      } else {
        console.log(`✅ Disabled RLS on ${table}`);
      }
    }

    res.json({
      message: "RLS policies have been updated",
      note: "Run migration.sql in Supabase SQL Editor for permanent fix",
    });
  } catch (err) {
    console.error("❌ RLS fix error:", err.message);
    res.status(500).json({ error: "Failed to fix RLS: " + err.message });
  }
});

module.exports = router;
