// ============================================================
// routes/admin.js — CampusTutor AI 2.0 Admin Management Center
// ============================================================

const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabase");
const {
  getUserCoinBalance,
  adminAdjustCoins,
  getCoinHistory,
  getAllCoinTransactions,
} = require("../utils/coins");
const {
  getAllToolsConfig,
  updateToolConfig,
} = require("../utils/toolConfig");
const {
  resolveEffectiveSubscription,
  getUserUsageSummary,
} = require("../utils/usageService");
const { getAllVerifiedPayments } = require("../utils/paymentLedger");
const { verifyTokenWithRetry } = require("../middleware/authMiddleware");

// Helper: fetch ALL auth users from Supabase Admin API
async function getAllAuthUsers() {
  const perPage = 100;
  let page = 1;
  const all = [];

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    all.push(...users);
    if (users.length < perPage) break;
    page += 1;
  }

  return all;
}

// ── MIDDLEWARE: Verify JWT and require admin role ─────────────
async function isAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "No token provided." });
    }

    const { user, error } = await verifyTokenWithRetry(token);
    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired token." });
    }

    if (user.app_metadata?.status === "banned") {
      return res.status(403).json({ error: "Account is banned.", banned: true });
    }

    const userRole = user.app_metadata?.role;
    if (userRole !== "admin") {
      return res.status(403).json({ error: "Admin access required." });
    }

    req.adminId = user.id;
    req.adminEmail = user.email;
    next();
  } catch (err) {
    console.error("Admin middleware error:", err.message);
    res.status(500).json({ error: "Authentication check failed." });
  }
}

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

// Compute effective subscription snapshot without unnecessary DB writes on bulk list
function getEffectiveSubSnapshot(p) {
  let plan = String(p.plan || "free").toLowerCase();
  if (!["free", "plus", "pro"].includes(plan)) plan = "free";
  let status = String(p.subscription_status || (plan === "free" ? "inactive" : "active")).toLowerCase();
  const subEnd = p.subscription_end ? new Date(p.subscription_end) : null;
  const expired = Boolean(subEnd && !Number.isNaN(subEnd.getTime()) && subEnd.getTime() <= Date.now());

  if (plan !== "free" && (expired || status === "expired" || status === "revoked")) {
    return {
      effectivePlan: "free",
      rawPlan: plan,
      status: status === "revoked" ? "revoked" : "expired",
      subscriptionEnd: p.subscription_end || null,
      subscriptionSource: p.subscription_source || "paystack",
    };
  }
  if (plan !== "free" && status !== "active") {
    return {
      effectivePlan: "free",
      rawPlan: plan,
      status,
      subscriptionEnd: p.subscription_end || null,
      subscriptionSource: p.subscription_source || "free",
    };
  }
  return {
    effectivePlan: plan,
    rawPlan: plan,
    status: plan === "free" ? status : "active",
    subscriptionEnd: p.subscription_end || null,
    subscriptionSource: p.subscription_source || (plan === "free" ? "free" : "paystack"),
  };
}

// ── DASHBOARD STATS ───────────────────────────────────────────
router.get("/stats", isAdmin, async (req, res) => {
  try {
    const [allAuthUsers, profilesRes, docsRes, aiRes, actRes] = await Promise.all([
      getAllAuthUsers().catch(() => []),
      supabase.from("profiles").select("id, plan, subscription_status, subscription_end, is_verified, status"),
      supabase.from("documents").select("*", { count: "exact", head: true }),
      supabase.from("ai_results").select("*", { count: "exact", head: true }),
      supabase
        .from("user_activity")
        .select("*", { count: "exact", head: true })
        .in("action", [
          "ai_summarize",
          "ai_explain",
          "ai_questions",
          "ai_flashcards",
          "solve_problem",
          "polish_essay",
          "project_proposals",
          "viva_defense",
          "exam_predict",
          "humanize_rewrite",
        ]),
    ]);

    const profiles = profilesRes.data || [];
    const totalUsers = Math.max(allAuthUsers.length, profiles.length);
    const bannedUsers = allAuthUsers.filter((u) => u.app_metadata?.status === "banned").length;
    const activeUsers = Math.max(0, totalUsers - bannedUsers);

    let plusCount = 0;
    let proCount = 0;
    let expiredCount = 0;
    let verifiedUsers = 0;

    profiles.forEach((p) => {
      if (p.is_verified) verifiedUsers += 1;
      const snap = getEffectiveSubSnapshot(p);
      if (snap.effectivePlan === "plus") plusCount += 1;
      else if (snap.effectivePlan === "pro") proCount += 1;
      if (snap.status === "expired") expiredCount += 1;
    });

    const totalDocuments = docsRes.count || 0;
    const totalAIGenerations = (aiRes.count || 0) + (actRes.count || 0);

    res.json({
      totalUsers,
      activeUsers,
      bannedUsers,
      totalDocuments,
      totalAIGenerations,
      premiumSubscribers: plusCount + proCount,
      plusSubscribers: plusCount,
      proSubscribers: proCount,
      expiredSubscriptions: expiredCount,
      verifiedUsers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SUBSCRIPTION OVERVIEW ─────────────────────────────────────
router.get("/subscriptions/overview", isAdmin, async (req, res) => {
  try {
    const [{ data: profiles }, { data: recentLogs }, verifiedPayments] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, email, full_name, plan, subscription_status, subscription_end, created_at, last_login, xp, level")
        .order("created_at", { ascending: false })
        .range(0, 1999),
      supabase
        .from("activity_logs")
        .select("user_id, admin_id, action, details, created_at")
        .in("action", ["gift_plan", "grant_subscription", "extend_subscription", "revoke_subscription", "change_subscription"])
        .order("created_at", { ascending: false })
        .limit(50),
      getAllVerifiedPayments(200),
    ]);

    const allProfiles = profiles || [];
    let freeUsers = 0;
    let plusSubscribers = 0;
    let proSubscribers = 0;
    let activeSubscriptions = 0;
    let expiredSubscriptions = 0;
    let revokedSubscriptions = 0;

    const grantMap = new Map();
    (recentLogs || []).forEach((l) => {
      if (!grantMap.has(l.user_id)) {
        grantMap.set(l.user_id, l);
      }
    });

    const paymentByUser = new Map();
    let subscriptionRevenueKobo = 0;
    let coinRevenueKobo = 0;
    const subPayments = [];

    (verifiedPayments || []).forEach((pay) => {
      const amt = Number(pay.amount_kobo || 0);
      if (pay.payment_type === "coins") {
        coinRevenueKobo += amt;
      } else {
        subscriptionRevenueKobo += amt;
        subPayments.push(pay);
        if (!paymentByUser.has(pay.user_id)) {
          paymentByUser.set(pay.user_id, pay);
        }
      }
    });

    const activePremiumList = [];

    allProfiles.forEach((p) => {
      const snap = getEffectiveSubSnapshot(p);
      if (snap.effectivePlan === "plus") {
        plusSubscribers += 1;
        activeSubscriptions += 1;
      } else if (snap.effectivePlan === "pro") {
        proSubscribers += 1;
        activeSubscriptions += 1;
      } else {
        freeUsers += 1;
      }

      if (snap.status === "expired") expiredSubscriptions += 1;
      if (snap.status === "revoked") revokedSubscriptions += 1;

      if (snap.effectivePlan !== "free" || snap.rawPlan !== "free") {
        const lastGrant = grantMap.get(p.id);
        const lastPay = paymentByUser.get(p.id);
        let source = p.subscription_source || "unknown";
        if (source === "unknown") {
          if (lastPay && (!lastGrant || new Date(lastPay.verified_at || lastPay.created_at) >= new Date(lastGrant.created_at))) {
            source = "paystack";
          } else if (lastGrant) {
            source = "admin_grant";
          }
        }
        activePremiumList.push({
          id: p.id,
          fullName: p.full_name || "Unknown",
          email: p.email,
          plan: snap.effectivePlan,
          rawPlan: snap.rawPlan,
          subscriptionStatus: snap.status,
          subscriptionEnd: snap.subscriptionEnd,
          source,
          updatedAt: lastPay?.verified_at || lastGrant?.created_at || p.created_at,
        });
      }
    });

    activePremiumList.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    res.json({
      totalUsers: allProfiles.length,
      freeUsers,
      plusSubscribers,
      proSubscribers,
      activeSubscriptions,
      expiredSubscriptions,
      revokedSubscriptions,
      revenue: {
        totalRevenueNgn: Math.round((subscriptionRevenueKobo + coinRevenueKobo) / 100),
        subscriptionRevenueNgn: Math.round(subscriptionRevenueKobo / 100),
        coinRevenueNgn: Math.round(coinRevenueKobo / 100),
        subscriptionPaymentsCount: subPayments.length,
        totalPaymentsCount: (verifiedPayments || []).length,
      },
      recentlyUpgraded: activePremiumList.slice(0, 20),
      recentPayments: (verifiedPayments || []).slice(0, 20),
    });
  } catch (err) {
    console.error("Subscription overview error:", err.message);
    res.status(500).json({ error: "Failed to fetch subscription overview." });
  }
});

// ── PREMIUM SUBSCRIBERS LIST ──────────────────────────────────
router.get("/premium-subscribers", isAdmin, async (req, res) => {
  try {
    const { data: subscribers, error } = await supabase
      .from("profiles")
      .select("*")
      .neq("plan", "free")
      .order("subscription_end", { ascending: false })
      .range(0, 999);

    if (error) {
      return res.status(500).json({ error: "Failed to fetch premium subscribers." });
    }

    const { data: grantLogs } = await supabase
      .from("activity_logs")
      .select("user_id, action, created_at")
      .in("action", ["gift_plan", "grant_subscription", "extend_subscription"])
      .order("created_at", { ascending: false })
      .limit(200);

    const grantedIds = new Set((grantLogs || []).map((g) => g.user_id));

    res.json({
      total: subscribers?.length || 0,
      subscribers: (subscribers || []).map((s) => {
        const snap = getEffectiveSubSnapshot(s);
        const source = s.subscription_source || (grantedIds.has(s.id) ? "admin_grant" : "paystack");
        return {
          id: s.id,
          email: s.email,
          fullName: s.full_name || "Unknown",
          plan: snap.rawPlan,
          effectivePlan: snap.effectivePlan,
          subscriptionStatus: snap.status,
          subscriptionEnd: s.subscription_end,
          subscriptionSource: source,
          createdAt: s.created_at,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch premium subscribers." });
  }
});

// ── VERIFIED USERS LIST ───────────────────────────────────────
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
      users: (verified || []).map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.full_name || "Unknown",
        plan: u.plan || "free",
        createdAt: u.created_at,
        lastLogin: u.last_login,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch verified users." });
  }
});

// ── RECENT ACTIVITIES ─────────────────────────────────────────
router.get("/recent-activities", isAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit || "50", 10));

    const [{ data: userActivities }, { data: adminActivities }] = await Promise.all([
      supabase
        .from("user_activity")
        .select("id, user_id, action, details, created_at")
        .order("created_at", { ascending: false })
        .limit(limit),
      supabase
        .from("activity_logs")
        .select("id, user_id, admin_id, action, details, created_at")
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);

    const activities = [...(userActivities || []), ...(adminActivities || [])]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);

    res.json({
      activityCount: activities.length,
      activities,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch recent activities.",
      activityCount: 0,
      activities: [],
    });
  }
});

// ── LIST ALL USERS (Search by Name, Email, or User ID + Enriched Metadata) ─
router.get("/users", isAdmin, async (req, res) => {
  try {
    const { search = "", status = "", plan = "" } = req.query;

    const [{ data: profileUsers, error: profErr }, authUsers, { data: aiCounts }, { data: docCounts }] =
      await Promise.all([
        supabase
          .from("profiles")
          .select("*")
          .order("created_at", { ascending: false })
          .range(0, 1999),
        getAllAuthUsers().catch(() => []),
        supabase
          .from("user_activity")
          .select("user_id")
          .in("action", [
            "ai_summarize",
            "ai_explain",
            "ai_questions",
            "ai_flashcards",
            "solve_problem",
            "polish_essay",
            "project_proposals",
            "viva_defense",
            "exam_predict",
            "humanize_rewrite",
          ])
          .limit(5000),
        supabase.from("documents").select("user_id").limit(5000),
      ]);

    const authMap = new Map();
    (authUsers || []).forEach((au) => authMap.set(au.id, au));

    const aiUsageCountMap = new Map();
    (aiCounts || []).forEach((row) => {
      aiUsageCountMap.set(row.user_id, (aiUsageCountMap.get(row.user_id) || 0) + 1);
    });

    const docCountMap = new Map();
    (docCounts || []).forEach((row) => {
      docCountMap.set(row.user_id, (docCountMap.get(row.user_id) || 0) + 1);
    });

    let users = [];
    if (!profErr && Array.isArray(profileUsers) && profileUsers.length > 0) {
      users = profileUsers.map((u) => {
        const au = authMap.get(u.id);
        const snap = getEffectiveSubSnapshot(u);
        const coins =
          u.coins !== undefined && u.coins !== null
            ? Number(u.coins)
            : Number(au?.user_metadata?.coins ?? 5);

        return {
          id: u.id,
          email: u.email || au?.email || "",
          fullName: u.full_name || au?.user_metadata?.full_name || "Unknown",
          role: au?.app_metadata?.role || u.role || "user",
          status: au?.app_metadata?.status || u.status || "active",
          plan: snap.effectivePlan,
          rawPlan: snap.rawPlan,
          subscriptionStatus: snap.status,
          subscriptionEnd: snap.subscriptionEnd,
          subscriptionSource: snap.subscriptionSource,
          coins,
          xp: u.xp || 0,
          level: u.level || 1,
          streak: u.streak || 0,
          isVerified: Boolean(u.is_verified),
          aiUsageCount: aiUsageCountMap.get(u.id) || 0,
          documentsCount: docCountMap.get(u.id) || 0,
          createdAt: u.created_at,
          lastLogin: u.last_login || au?.last_sign_in_at || null,
          bannedReason: u.banned_reason || au?.app_metadata?.banned_reason || null,
          bannedAt: u.banned_at || au?.app_metadata?.banned_at || null,
        };
      });
    } else {
      users = (authUsers || []).map((au) => ({
        id: au.id,
        email: au.email,
        fullName: au.user_metadata?.full_name || "Unknown",
        role: au.app_metadata?.role || "user",
        status: au.app_metadata?.status || "active",
        plan: "free",
        rawPlan: "free",
        subscriptionStatus: "inactive",
        subscriptionEnd: null,
        subscriptionSource: "free",
        coins: Number(au.user_metadata?.coins ?? 5),
        xp: 0,
        level: 1,
        streak: 0,
        isVerified: true,
        aiUsageCount: aiUsageCountMap.get(au.id) || 0,
        documentsCount: docCountMap.get(au.id) || 0,
        createdAt: au.created_at,
        lastLogin: au.last_sign_in_at,
        bannedReason: au.app_metadata?.banned_reason || null,
        bannedAt: au.app_metadata?.banned_at || null,
      }));
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      users = users.filter(
        (u) =>
          (u.fullName || "").toLowerCase().includes(q) ||
          (u.email || "").toLowerCase().includes(q) ||
          (u.id || "").toLowerCase().includes(q)
      );
    }

    if (status && status !== "all") {
      users = users.filter((u) => u.status === status);
    }

    if (plan && plan !== "all") {
      users = users.filter((u) => u.plan === plan.toLowerCase());
    }

    res.json({
      total: users.length,
      users,
    });
  } catch (err) {
    console.error("List users error:", err.message);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// ── SINGLE USER FULL PROFILE (Admin Inspection) ───────────────
router.get("/users/:userId", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const [{ data: profile }, authRes, coinInfo, coinHistory] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
      supabase.auth.admin.getUserById(userId).catch(() => ({ data: null })),
      getUserCoinBalance(userId),
      getCoinHistory(userId, 50),
    ]);

    const au = authRes?.data?.user || null;
    if (!profile && !au) {
      return res.status(404).json({ error: "User not found." });
    }

    const sub = await resolveEffectiveSubscription(userId, profile);
    const isUserAdmin = (au?.app_metadata?.role || profile?.role) === "admin";
    const usage = await getUserUsageSummary(userId, isUserAdmin ? "pro" : sub.plan, isUserAdmin);

    res.json({
      user: {
        id: userId,
        email: profile?.email || au?.email,
        fullName: profile?.full_name || au?.user_metadata?.full_name || "Unknown",
        role: au?.app_metadata?.role || profile?.role || "user",
        status: au?.app_metadata?.status || profile?.status || "active",
        plan: isUserAdmin ? "pro" : sub.plan,
        subscriptionStatus: isUserAdmin ? "active" : sub.status,
        subscriptionEnd: profile?.subscription_end || null,
        subscriptionSource: sub.subscriptionSource,
        coins: Number(coinInfo.coins ?? 0),
        xp: profile?.xp || 0,
        level: profile?.level || 1,
        streak: profile?.streak || 0,
        isVerified: Boolean(profile?.is_verified),
        createdAt: profile?.created_at || au?.created_at,
        lastLogin: profile?.last_login || au?.last_sign_in_at || null,
        bannedReason: profile?.banned_reason || au?.app_metadata?.banned_reason || null,
      },
      usage,
      coinHistory,
    });
  } catch (err) {
    console.error("Get single user error:", err.message);
    res.status(500).json({ error: "Failed to fetch user profile." });
  }
});

// ── MANUAL COIN MANAGEMENT (Credit / Deduct) ──────────────────
router.post("/users/:userId/coins", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { action = "credit", amount, reason } = req.body || {};

    const result = await adminAdjustCoins({
      userId,
      amount,
      action,
      reason,
      adminId: req.adminId,
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const logAction = action === "deduct" ? "admin_deduct_coins" : "admin_credit_coins";
    await logActivity(
      req.adminId,
      logAction,
      userId,
      `${action === "deduct" ? "Deducted" : "Credited"} ${Math.trunc(Number(amount))} coins. Reason: ${String(reason).trim()}. New balance: ${result.coins}`
    );

    res.json({
      success: true,
      userId,
      coins: result.coins,
      previousCoins: result.previousCoins,
      message: `Successfully ${action === "deduct" ? "deducted" : "credited"} ${Math.trunc(Number(amount))} CampusCoins. New balance: ${result.coins}.`,
    });
  } catch (err) {
    console.error("Admin coin adjust error:", err.message);
    res.status(500).json({ error: "Failed to update user coin balance." });
  }
});

router.get("/users/:userId/coins", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const [balance, history] = await Promise.all([
      getUserCoinBalance(userId),
      getCoinHistory(userId, 50),
    ]);
    res.json({ userId, coins: balance.coins, history });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user coin history." });
  }
});

router.get("/coin-transactions", isAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit || "100", 10));
    const [txs, { data: profiles }] = await Promise.all([
      getAllCoinTransactions(limit),
      supabase.from("profiles").select("id, full_name, email").range(0, 1999),
    ]);
    const profMap = new Map();
    (profiles || []).forEach((p) => profMap.set(p.id, p));

    res.json({
      transactions: (txs || []).map((t) => {
        const userProf = profMap.get(t.user_id);
        const adminProf = t.admin_id ? profMap.get(t.admin_id) : null;
        return {
          ...t,
          userName: userProf?.full_name || "Unknown",
          userEmail: userProf?.email || "",
          adminName: adminProf?.full_name || (t.admin_id ? "Admin" : null),
          adminEmail: adminProf?.email || null,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch coin transactions." });
  }
});

// ── MANUAL PREMIUM SUBSCRIPTION MANAGEMENT ────────────────────
async function applyAdminSubscriptionChange({ userId, action, plan, durationDays, reason, adminId }) {
  const { data: profile, error: findErr } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (findErr || !profile) {
    return { ok: false, status: 404, error: "User profile not found." };
  }

  const normalizedAction = String(action || "grant").toLowerCase();
  if (!["grant", "extend", "change", "revoke"].includes(normalizedAction)) {
    return { ok: false, status: 400, error: "Action must be 'grant', 'extend', 'change', or 'revoke'." };
  }

  if (normalizedAction === "revoke") {
    const nowIso = new Date().toISOString();
    let updateErr;
    ({ error: updateErr } = await supabase
      .from("profiles")
      .update({
        plan: "free",
        subscription_status: "revoked",
        subscription_end: nowIso,
        subscription_source: "admin_grant",
        subscription_granted_by: adminId,
        subscription_note: reason || "Revoked by administrator",
      })
      .eq("id", userId));

    if (updateErr && (updateErr.code === "42703" || (updateErr.message || "").includes("column"))) {
      ({ error: updateErr } = await supabase
        .from("profiles")
        .update({ plan: "free", subscription_status: "revoked", subscription_end: nowIso })
        .eq("id", userId));
    }

    if (updateErr) return { ok: false, status: 500, error: "Failed to revoke subscription." };

    await logActivity(adminId, "revoke_subscription", userId, `Revoked premium subscription. ${reason || ""}`.trim());
    return {
      ok: true,
      plan: "free",
      subscriptionStatus: "revoked",
      subscriptionEnd: nowIso,
      message: `Premium access revoked for ${profile.full_name || profile.email}.`,
    };
  }

  const targetPlan = String(plan || "plus").toLowerCase();
  if (!["free", "plus", "pro"].includes(targetPlan)) {
    return { ok: false, status: 400, error: "Plan must be 'free', 'plus', or 'pro'." };
  }

  if (targetPlan === "free") {
    return applyAdminSubscriptionChange({ userId, action: "revoke", reason, adminId });
  }

  const days = Number(durationDays);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    return { ok: false, status: 400, error: "durationDays must be between 1 and 3650 days." };
  }

  const now = new Date();
  let baseDate = now;
  if (
    normalizedAction === "extend" &&
    profile.subscription_end &&
    new Date(profile.subscription_end) > now
  ) {
    baseDate = new Date(profile.subscription_end);
  }

  const subscriptionEnd = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
  const subEndIso = subscriptionEnd.toISOString();

  let updateErr;
  ({ error: updateErr } = await supabase
    .from("profiles")
    .update({
      plan: targetPlan,
      subscription_status: "active",
      subscription_end: subEndIso,
      subscription_source: "admin_grant",
      subscription_granted_by: adminId,
      subscription_note: reason || `Admin ${normalizedAction} (${days} days)`,
    })
    .eq("id", userId));

  if (updateErr && (updateErr.code === "42703" || (updateErr.message || "").includes("column"))) {
    ({ error: updateErr } = await supabase
      .from("profiles")
      .update({
        plan: targetPlan,
        subscription_status: "active",
        subscription_end: subEndIso,
      })
      .eq("id", userId));
  }

  if (updateErr) {
    return { ok: false, status: 500, error: "Failed to update subscription." };
  }

  const logActionName =
    normalizedAction === "extend"
      ? "extend_subscription"
      : normalizedAction === "change"
      ? "change_subscription"
      : "grant_subscription";

  await logActivity(
    adminId,
    logActionName,
    userId,
    `Admin ${normalizedAction}: ${targetPlan.toUpperCase()} for ${days} days (until ${subEndIso.split("T")[0]}). ${reason || ""}`.trim()
  );

  return {
    ok: true,
    plan: targetPlan,
    subscriptionStatus: "active",
    subscriptionEnd: subEndIso,
    subscriptionSource: "admin_grant",
    message: `Successfully ${normalizedAction === "extend" ? "extended" : "granted"} ${targetPlan.toUpperCase()} plan for ${profile.full_name || profile.email} (${days} days).`,
  };
}

router.post("/users/:userId/subscription", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { action = "grant", plan = "plus", durationDays = 30, reason = "" } = req.body || {};

    const result = await applyAdminSubscriptionChange({
      userId,
      action,
      plan,
      durationDays,
      reason,
      adminId: req.adminId,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    console.error("Admin subscription update error:", err.message);
    res.status(500).json({ error: "Failed to update user subscription." });
  }
});

// Backward-compatible Gift Plan route (by email)
router.post("/gift-plan", isAdmin, async (req, res) => {
  try {
    const { email, plan, durationDays, action = "grant", reason = "" } = req.body || {};
    if (!email || !plan || !durationDays) {
      return res.status(400).json({ error: "Email, plan, and durationDays are required." });
    }

    const { data: profile, error: findError } = await supabase
      .from("profiles")
      .select("id")
      .ilike("email", email.trim().toLowerCase())
      .maybeSingle();

    if (findError || !profile) {
      return res.status(404).json({ error: "User with this email not found." });
    }

    const result = await applyAdminSubscriptionChange({
      userId: profile.id,
      action,
      plan,
      durationDays,
      reason: reason || "Manual admin gift",
      adminId: req.adminId,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to gift plan." });
  }
});

// ── AI TOOLS MANAGEMENT ───────────────────────────────────────
router.get("/ai-tools", isAdmin, async (req, res) => {
  try {
    const all = await getAllToolsConfig(true);
    res.json({
      tools: Object.values(all),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load AI tools configuration." });
  }
});

router.put("/ai-tools/:toolKey", isAdmin, async (req, res) => {
  try {
    const { toolKey } = req.params;
    const updated = await updateToolConfig(toolKey, req.body || {}, req.adminId);
    await logActivity(
      req.adminId,
      "update_ai_tool_config",
      req.adminId,
      `Updated tool "${toolKey}": enabled=${updated.enabled}, coinCost=${updated.coinCost}, daily=${JSON.stringify(updated.dailyLimit)}, monthly=${JSON.stringify(updated.monthlyLimit)}`
    );
    res.json({
      success: true,
      tool: updated,
      message: `Updated ${updated.name} configuration.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to update tool configuration." });
  }
});

// ── USER ACTIVITY LOG ─────────────────────────────────────────
router.get("/users/:userId/activity", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const [{ data: adminActions }, { data: userActions }] = await Promise.all([
      supabase
        .from("activity_logs")
        .select("id, action, details, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("user_activity")
        .select("id, action, details, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    const allActivities = [
      ...(adminActions || []).map((a) => ({ type: "admin", ...a })),
      ...(userActions || []).map((a) => ({ type: "user", ...a })),
    ]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
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

// ── BAN USER ──────────────────────────────────────────────────
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

    const nowIso = new Date().toISOString();
    try {
      await supabase
        .from("profiles")
        .update({
          status: "banned",
          banned_reason: reason.trim(),
          banned_at: nowIso,
          banned_by: req.adminId,
        })
        .eq("id", userId);
    } catch (_) {}

    const { data: authData, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
    const authUser = authData?.user;
    if (fetchErr || !authUser) {
      return res.status(404).json({ error: "User not found." });
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: {
        ...(authUser.app_metadata || {}),
        status: "banned",
        banned_reason: reason.trim(),
        banned_at: nowIso,
        banned_by: req.adminId,
      },
    });

    if (updateError) {
      return res.status(500).json({ error: "Failed to ban user: " + updateError.message });
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

    try {
      await supabase
        .from("profiles")
        .update({
          status: "active",
          banned_reason: null,
          banned_at: null,
          banned_by: null,
        })
        .eq("id", userId);
    } catch (_) {}

    const { data: authData, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
    const authUser = authData?.user;
    if (fetchErr || !authUser) {
      return res.status(404).json({ error: "User not found." });
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: {
        ...(authUser.app_metadata || {}),
        status: "active",
        banned_reason: null,
        banned_at: null,
        banned_by: null,
      },
    });

    if (updateError) {
      return res.status(500).json({ error: "Failed to unban user." });
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
    try { await supabase.from("profiles").delete().eq("id", userId); } catch (_) {}

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

    const { error } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });
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

    try { await supabase.from("profiles").update({ role }).eq("id", userId); } catch (_) {}

    const { data: authData, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
    const authUser = authData?.user;
    if (fetchErr || !authUser) {
      return res.status(404).json({ error: "User not found." });
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: { ...(authUser.app_metadata || {}), role },
    });

    if (updateError) {
      return res.status(500).json({ error: "Failed to update role: " + updateError.message });
    }

    await logActivity(req.adminId, "set_role", userId, `Role changed to ${role}.`);
    res.json({ message: "Role updated successfully.", userId, role });
  } catch (err) {
    res.status(500).json({ error: "Failed to update role." });
  }
});

// ── USER UPLOADED FILES & SECURE DOWNLOAD ─────────────────────
router.get("/users/:userId/files", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: files, error } = await supabase
      .from("documents")
      .select("id, file_name, file_type, file_path, page_count, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error && !error.message.includes("does not exist")) {
      throw error;
    }

    res.json({
      userId,
      fileCount: (files || []).length,
      files: (files || []).map((f) => ({
        id: f.id,
        name: f.file_name,
        type: f.file_type || "pdf",
        filePath: f.file_path,
        pages: f.page_count || 0,
        uploadedAt: f.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user files." });
  }
});

router.get("/users/:userId/files/:docId/download", isAdmin, async (req, res) => {
  try {
    const { userId, docId } = req.params;
    const { data: doc, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", docId)
      .eq("user_id", userId)
      .single();

    if (error || !doc) {
      return res.status(404).json({ error: "File not found." });
    }

    if (doc.file_path) {
      const bucket = doc.file_type === "image" ? "images" : "documents";
      const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(doc.file_path);
      if (!dlErr && blob) {
        const buffer = Buffer.from(await blob.arrayBuffer());
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.file_name)}"`);
        res.setHeader("Content-Type", blob.type || "application/octet-stream");
        return res.send(buffer);
      }
    }

    // Fallback: serve extracted text
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.file_name)}.txt"`);
    res.send(doc.extracted_text || "No text extracted.");
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

// ── USER AI INTERACTIONS ──────────────────────────────────────
router.get("/users/:userId/ai-interactions", isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: aiActivities, error } = await supabase
      .from("user_activity")
      .select("id, action, details, created_at")
      .eq("user_id", userId)
      .in("action", [
        "ai_summarize",
        "ai_explain",
        "ai_questions",
        "ai_flashcards",
        "solve_problem",
        "polish_essay",
        "project_proposals",
        "viva_defense",
        "exam_predict",
        "humanize_rewrite",
      ])
      .order("created_at", { ascending: false })
      .limit(100);

    if (error && !error.message.includes("does not exist")) {
      throw error;
    }

    res.json({
      userId,
      aiInteractionCount: (aiActivities || []).length,
      interactions: (aiActivities || []).map((a) => ({
        id: a.id,
        type: a.action.replace(/^ai_/, ""),
        details: a.details || "No details",
        timestamp: a.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch AI interactions." });
  }
});

// ── WITHDRAWALS QUEUE ─────────────────────────────────────────
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
    res.status(500).json({ error: "Failed to fetch withdrawals." });
  }
});

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
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (updateError) {
      return res.status(500).json({ error: "Failed to resolve withdrawal." });
    }

    await logActivity(
      req.adminId,
      `resolve_withdrawal_${status}`,
      withdrawal.user_id,
      `Withdrawal request resolved as ${status}. Remark: ${remark || "None"}`
    );

    res.json({ message: `Withdrawal request has been ${status}.` });
  } catch (err) {
    res.status(500).json({ error: "Failed to resolve withdrawal." });
  }
});

// ── FIX RLS POLICIES ──────────────────────────────────────────
router.post("/fix-rls", isAdmin, async (req, res) => {
  try {
    const tables = ["activity_logs", "user_activity", "ai_results", "documents"];
    for (const table of tables) {
      try {
        await supabase.rpc("exec_sql", {
          sql: `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`,
        });
      } catch (_) {}
    }
    res.json({ message: "RLS policies updated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to fix RLS." });
  }
});

// ── USER FEEDBACK ─────────────────────────────────────────────
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
    res.status(500).json({ error: "Failed to fetch feedback." });
  }
});

// ── SUPPORT TICKETS ───────────────────────────────────────────
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
    res.status(500).json({ error: "Failed to fetch support tickets." });
  }
});

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
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (updateError) {
      return res.status(500).json({ error: "Failed to reply to ticket." });
    }

    await logActivity(req.adminId, "reply_support_ticket", ticket.user_id, `Replied to support ticket: "${ticket.subject}"`);
    res.json({ message: "Reply sent and ticket marked as resolved." });
  } catch (err) {
    res.status(500).json({ error: "Failed to send reply." });
  }
});

module.exports = router;
