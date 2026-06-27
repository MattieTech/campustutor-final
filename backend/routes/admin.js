// ============================================================
// routes/admin.js — CampusTutor AI Admin API
// ============================================================

const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabase");

// Helper: fetch ALL auth users from Supabase Admin API
async function getAllAuthUsers() {
  const perPage = 100;
  let page = 1;
  const all = [];

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw error;
    }

    const users = data?.users || [];
    all.push(...users);

    if (users.length < perPage) break;
    page += 1;
  }

  return all;
}

// ── MIDDLEWARE: Verify JWT and require admin role ────────────
async function isAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "No token provided." });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      console.error("❌ Invalid token:", error?.message);
      return res.status(401).json({ error: "Invalid or expired token." });
    }

    const userRole = data.user.app_metadata?.role;
    
    console.log("🔐 Admin check for:", data.user.email);
    console.log("📦 app_metadata.role:", userRole);

    if (userRole !== "admin") {
      console.warn("❌ Access denied - not an admin. Role:", userRole);
      return res.status(403).json({ error: "Admin access required." });
    }

    console.log("✅ Admin access granted");

    req.adminId = data.user.id;
    next();
  } catch (err) {
    console.error("Admin middleware error:", err.message);
    res.status(500).json({ error: "Authentication check failed." });
  }
}

// ── HELPER: Write activity log ────────────────────────────────
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
    console.error("Activity log error:", err.message);
  }
}

// ── DASHBOARD STATS ──────────────────────────────────────────
router.get("/stats", isAdmin, async (req, res) => {
  try {
    console.log("📊 Fetching user stats...");
    let allUsers = [];
    try {
      allUsers = await getAllAuthUsers();
    } catch (authError) {
      console.error("❌ Auth list error:", authError.message);
      allUsers = [];
    }

    const totalUsers = allUsers.length;
    const bannedUsers = allUsers.filter(u => u.app_metadata?.status === "banned").length;
    const activeUsers = totalUsers - bannedUsers;

    let totalDocuments = 0;
    try {
      const { count, error: docError } = await supabase
        .from("documents")
        .select("*", { count: "exact", head: true });
      
      if (docError) throw docError;
      totalDocuments = count || 0;
    } catch (err) {
      console.log("⚠️ Documents table error:", err.message);
    }

    let totalAIGenerations = 0;
    try {
      const { count: aiCount, error: aiError } = await supabase
        .from("ai_results")
        .select("*", { count: "exact", head: true });
      
      if (!aiError) {
        totalAIGenerations = aiCount || 0;
      } else {
        throw aiError;
      }
    } catch (err) {
      console.log("⚠️ AI results table error:", err.message);
      try {
        const { count: actCount, error: actError } = await supabase
          .from("user_activity")
          .select("*", { count: "exact", head: true })
          .in("action", ["ai_summarize", "ai_explain", "ai_questions", "ai_flashcards"]);
        
        if (!actError) {
          totalAIGenerations = actCount || 0;
        }
      } catch (fallbackErr) {
        totalAIGenerations = 0;
      }
    }

    // Count premium subscribers (plan != 'free' and subscription_status = 'active')
    let premiumSubscribers = 0;
    let verifiedUsers = 0;
    try {
      const { count: premCount, error: premErr } = await supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .neq("plan", "free")
        .eq("subscription_status", "active");
      if (!premErr) premiumSubscribers = premCount || 0;
    } catch (_) {}

    try {
      const { count: verCount, error: verErr } = await supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .eq("is_verified", true);
      if (!verErr) verifiedUsers = verCount || 0;
    } catch (_) {}

    const stats = {
      totalUsers,
      activeUsers: Math.max(0, activeUsers),
      bannedUsers,
      totalDocuments,
      totalAIGenerations,
      premiumSubscribers,
      verifiedUsers,
    };

    res.json(stats);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      totalUsers: 0,
      activeUsers: 0,
      bannedUsers: 0,
      totalDocuments: 0,
      totalAIGenerations: 0,
      premiumSubscribers: 0,
      verifiedUsers: 0,
    });
  }
});

// ── PREMIUM SUBSCRIBERS LIST ─────────────────────────────────
// GET /api/admin/premium-subscribers
router.get("/premium-subscribers", isAdmin, async (req, res) => {
  try {
    const { data: subscribers, error } = await supabase
      .from("profiles")
      .select("id, email, full_name, plan, subscription_status, subscription_end, created_at")
      .neq("plan", "free")
      .order("subscription_end", { ascending: false })
      .range(0, 999);

    if (error) {
      return res.status(500).json({ error: "Failed to fetch premium subscribers." });
    }

    res.json({
      total: subscribers?.length || 0,
      subscribers: (subscribers || []).map(s => ({
        id: s.id,
        email: s.email,
        fullName: s.full_name || "Unknown",
        plan: s.plan,
        subscriptionStatus: s.subscription_status || "unknown",
        subscriptionEnd: s.subscription_end,
        createdAt: s.created_at,
      })),
    });
  } catch (err) {
    console.error("Premium subscribers error:", err);
    res.status(500).json({ error: "Failed to fetch premium subscribers." });
  }
});

// ── VERIFIED USERS LIST ──────────────────────────────────────
// GET /api/admin/verified-users
router.get("/verified-users", isAdmin, async (req, res) => {
  try {
    const { data: verified, error } = await supabase
      .from("profiles")
      .select("id, email, full_name, is_verified, plan, created_at, last_login")
      .eq("is_verified", true)
      .order("created_at", { ascending: false })
      .range(0, 999);

    if (error) {
      return res.status(500).json({ error: "Failed to fetch verified users." });
    }

    res.json({
      total: verified?.length || 0,
      users: (verified || []).map(u => ({
        id: u.id,
        email: u.email,
        fullName: u.full_name || "Unknown",
        plan: u.plan || "free",
        createdAt: u.created_at,
        lastLogin: u.last_login,
      })),
    });
  } catch (err) {
    console.error("Verified users error:", err);
    res.status(500).json({ error: "Failed to fetch verified users." });
  }
});

// ── RECENT ACTIVITIES ────────────────────────────────────────
router.get("/recent-activities", isAdmin, async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const { data: userActivities, error: userError } = await supabase
      .from("user_activity")
      .select("id, user_id, action, details, created_at")
      .order("created_at", { ascending: false })
      .limit(parseInt(limit));

    const { data: adminActivities, error: adminError } = await supabase
      .from("activity_logs")
      .select("id, user_id, action, details, created_at")
      .order("created_at", { ascending: false })
      .limit(parseInt(limit));

    const activities = [
      ...(userActivities || []),
      ...(adminActivities || [])
    ]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, parseInt(limit));

    res.json({
      activityCount: activities.length,
      activities: activities,
    });
  } catch (err) {
    res.status(500).json({ 
      error: "Failed to fetch recent activities.",
      activityCount: 0,
      activities: []
    });
  }
});

// ── LIST ALL USERS ───────────────────────────────────────────
router.get("/users", isAdmin, async (req, res) => {
  try {
    const { search } = req.query;
    let users = [];

    try {
      const { data: profileUsers, error } = await supabase
        .from("profiles")
        .select("id, email, full_name, role, status, created_at, last_login, banned_reason, banned_at")
        .order("created_at", { ascending: false })
        .range(0, 999);

      if (!error && profileUsers && profileUsers.length > 0) {
        users = profileUsers;
      } else {
        throw new Error("Profiles table fallback");
      }
    } catch (profileErr) {
      let authUsers = [];
      try {
        authUsers = await getAllAuthUsers();
      } catch (authError) {
        return res.status(500).json({ error: "Failed to fetch users." });
      }

      users = (authUsers || []).map(u => ({
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
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// ── USER ACTIVITY LOG ────────────────────────────────────────
router.get("/users/:userId/activity", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: adminActions } = await supabase
      .from("activity_logs")
      .select("id, action, details, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);

    const { data: userActions } = await supabase
      .from("user_activity")
      .select("id, action, details, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);

    const allActivities = [
      ...(adminActions || []).map(a => ({ type: "admin", ...a })),
      ...(userActions || []).map(a => ({ type: "user", ...a }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
     .slice(0, 100);

    res.json({
      userId,
      activityCount: allActivities.length,
      activities: allActivities,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity." });
  }
});

// ── BAN USER ─────────────────────────────────────────────────
router.post("/users/:userId/ban", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: "A ban reason is required." });
    }

    if (userId === req.adminId) {
      return res.status(400).json({ error: "You cannot ban your own account." });
    }

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
        banned = true;
      }
    } catch (profileErr) {}

    if (!banned) {
      const { data: user, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
      if (fetchErr || !user) {
        return res.status(404).json({ error: "User not found." });
      }

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
        return res.status(500).json({ error: "Failed to ban user: " + updateError.message });
      }
    }

    await logActivity(req.adminId, "ban_user", userId, reason.trim());
    res.json({ message: "User banned successfully.", userId });
  } catch (err) {
    res.status(500).json({ error: "Failed to ban user." });
  }
});

// ── UNBAN USER ────────────────────────────────────────────────
router.post("/users/:userId/unban", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

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
        unbanned = true;
      }
    } catch (profileErr) {}

    if (!unbanned) {
      const { data: user, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
      if (fetchErr || !user) {
        return res.status(404).json({ error: "User not found." });
      }

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
        return res.status(500).json({ error: "Failed to unban user." });
      }
    }

    await logActivity(req.adminId, "unban_user", userId, "Account reinstated.");
    res.json({ message: "User unbanned successfully.", userId });
  } catch (err) {
    res.status(500).json({ error: "Failed to unban user." });
  }
});

// ── DELETE USER ───────────────────────────────────────────────
router.delete("/users/:userId", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body || {};

    if (userId === req.adminId) {
      return res.status(400).json({ error: "You cannot delete your own account." });
    }

    await logActivity(req.adminId, "delete_user", userId, reason || "Account deleted by admin.");

    try {
      await supabase.from("profiles").delete().eq("id", userId);
    } catch (profileErr) {}

    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) {
      return res.status(500).json({ error: "Failed to delete user." });
    }

    res.json({ message: "User deleted successfully.", userId });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user." });
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────
router.post("/users/:userId/reset-password", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (error) throw error;

    await logActivity(req.adminId, "reset_password", userId, "Password reset by admin.");
    res.json({ message: "Password reset successfully.", userId });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset password." });
  }
});

// ── SET ROLE ──────────────────────────────────────────────────
router.post("/users/:userId/set-role", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ error: "Role must be 'user' or 'admin'." });
    }

    if (userId === req.adminId && role !== "admin") {
      return res.status(400).json({ error: "You cannot remove your own admin privileges." });
    }

    let roleUpdated = false;
    try {
      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .update({ role })
        .eq("id", userId)
        .select();

      if (!profileError && profileData && profileData.length > 0) {
        roleUpdated = true;
      }
    } catch (profileErr) {}

    if (!roleUpdated) {
      const { data: user, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
      if (fetchErr || !user) {
        return res.status(404).json({ error: "User not found." });
      }

      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        app_metadata: {
          ...(user.app_metadata || {}),
          role: role,
        },
      });

      if (updateError) {
        return res.status(500).json({ error: "Failed to update role: " + updateError.message });
      }
    }

    await logActivity(req.adminId, "set_role", userId, `Role changed to ${role}.`);
    res.json({ message: "Role updated successfully.", userId, role });
  } catch (err) {
    res.status(500).json({ error: "Failed to update role." });
  }
});

// ── USER UPLOADED FILES ──────────────────────────────────────
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
    res.status(500).json({ error: "Failed to fetch user files." });
  }
});

// ── USER AI INTERACTIONS ────────────────────────────────────
router.get("/users/:userId/ai-interactions", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

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
    res.status(500).json({ error: "Failed to fetch AI interactions." });
  }
});

// ── PREMIUM PLAN GIFTING ──────────────────────────────────────
// POST /api/admin/gift-plan
router.post("/gift-plan", isAdmin, async (req, res) => {
  try {
    const { email, plan, durationDays } = req.body;

    if (!email || !plan || !durationDays) {
      return res.status(400).json({ error: "Email, plan, and durationDays are required." });
    }

    if (!["free", "plus", "pro"].includes(plan)) {
      return res.status(400).json({ error: "Plan must be 'free', 'plus', or 'pro'." });
    }

    const { data: profile, error: findError } = await supabase
      .from("profiles")
      .select("id, full_name")
      .eq("email", email.trim().toLowerCase())
      .single();

    if (findError || !profile) {
      return res.status(404).json({ error: "User with this email not found." });
    }

    const subscriptionEnd = new Date();
    subscriptionEnd.setDate(subscriptionEnd.getDate() + Number(durationDays));

    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        plan: plan,
        subscription_status: "active",
        subscription_end: subscriptionEnd.toISOString()
      })
      .eq("id", profile.id);

    if (updateError) {
      return res.status(500).json({ error: "Failed to gift plan to user." });
    }

    await logActivity(req.adminId, "gift_plan", profile.id, `Gifted ${plan.toUpperCase()} plan for ${durationDays} days.`);

    res.json({ message: `Successfully gifted ${plan.toUpperCase()} plan to ${profile.full_name} for ${durationDays} days.` });
  } catch (err) {
    console.error("Gift plan error:", err);
    res.status(500).json({ error: "Failed to gift plan." });
  }
});

// ── GET WITHDRAWALS QUEUE ─────────────────────────────────────
// GET /api/admin/withdrawals
router.get("/withdrawals", isAdmin, async (req, res) => {
  try {
    const { data: withdrawals, error } = await supabase
      .from("withdrawals")
      .select("*, profiles(full_name, email)")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: "Failed to fetch withdrawals." });
    }

    res.json({ withdrawals: withdrawals || [] });
  } catch (err) {
    console.error("Get withdrawals error:", err);
    res.status(500).json({ error: "Failed to fetch withdrawals." });
  }
});

// ── RESOLVE WITHDRAWALS ───────────────────────────────────────
// POST /api/admin/withdrawals/:id/resolve
router.post("/withdrawals/:id/resolve", isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, remark } = req.body;

    if (!status || !["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Status must be 'approved' or 'rejected'." });
    }

    const { data: withdrawal, error: findError } = await supabase
      .from("withdrawals")
      .select("*")
      .eq("id", id)
      .single();

    if (findError || !withdrawal) {
      return res.status(404).json({ error: "Withdrawal request not found." });
    }

    const { error: updateError } = await supabase
      .from("withdrawals")
      .update({
        status,
        remark,
        updated_at: new Date().toISOString()
      })
      .eq("id", id);

    if (updateError) {
      return res.status(500).json({ error: "Failed to resolve withdrawal." });
    }

    await logActivity(req.adminId, `resolve_withdrawal_${status}`, withdrawal.user_id, `Withdrawal request resolved as ${status}. Remark: ${remark || 'None'}`);

    res.json({ message: `Withdrawal request has been ${status}.` });
  } catch (err) {
    console.error("Resolve withdrawal error:", err);
    res.status(500).json({ error: "Failed to resolve withdrawal." });
  }
});

// ── FIX RLS POLICIES ──────────────────────────────────────────
router.post("/fix-rls", isAdmin, async (req, res) => {
  try {
    console.log("🔧 Attempting to fix RLS...");
    const tables = ["activity_logs", "user_activity", "ai_results", "documents"];

    for (const table of tables) {
      await supabase.rpc("exec_sql", {
        sql: `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`,
      }).catch(() => {});
    }

    res.json({
      message: "RLS policies updated",
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fix RLS." });
  }
});

// ── GET USER FEEDBACK ─────────────────────────────────────────
// GET /api/admin/feedback
router.get("/feedback", isAdmin, async (req, res) => {
  try {
    const { data: feedback, error } = await supabase
      .from("feedback")
      .select("*, profiles(full_name, email)")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: "Failed to fetch feedback." });
    }

    res.json({ feedback: feedback || [] });
  } catch (err) {
    console.error("Get feedback error:", err);
    res.status(500).json({ error: "Failed to fetch feedback." });
  }
});

// ── GET SUPPORT TICKETS ───────────────────────────────────────
// GET /api/admin/tickets
router.get("/tickets", isAdmin, async (req, res) => {
  try {
    const { data: tickets, error } = await supabase
      .from("support_tickets")
      .select("*, profiles(full_name, email)")
      .order("created_at", { ascending: false });

    if (error) {
      if (error.code === "PGRST205" || error.message.includes("find the table")) {
        return res.json({ tickets: [], warning: "support_tickets table is missing." });
      }
      return res.status(500).json({ error: "Failed to fetch support tickets." });
    }

    res.json({ tickets: tickets || [] });
  } catch (err) {
    console.error("Get support tickets error:", err);
    res.status(500).json({ error: "Failed to fetch support tickets." });
  }
});

// ── REPLY TO SUPPORT TICKET ───────────────────────────────────
// POST /api/admin/tickets/:id/reply
router.post("/tickets/:id/reply", isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reply } = req.body;

    if (!reply || !reply.trim()) {
      return res.status(400).json({ error: "Reply message cannot be empty." });
    }

    const { data: ticket, error: findError } = await supabase
      .from("support_tickets")
      .select("*")
      .eq("id", id)
      .single();

    if (findError || !ticket) {
      return res.status(404).json({ error: "Support ticket not found." });
    }

    const { error: updateError } = await supabase
      .from("support_tickets")
      .update({
        reply: reply.trim(),
        status: "resolved",
        updated_at: new Date().toISOString()
      })
      .eq("id", id);

    if (updateError) {
      return res.status(500).json({ error: "Failed to reply to ticket." });
    }

    await logActivity(req.adminId, "reply_support_ticket", ticket.user_id, `Replied to support ticket: "${ticket.subject}"`);

    res.json({ message: "Reply sent and ticket marked as resolved." });
  } catch (err) {
    console.error("Reply support ticket error:", err);
    res.status(500).json({ error: "Failed to send reply." });
  }
});

module.exports = router;
