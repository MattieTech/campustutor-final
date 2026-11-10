// ============================================================
// middleware/subscriptionMiddleware.js — Enforce Pay-First Access
//
// Ensures that users have either an active paid plan (plus/pro)
// or available CampusCoins before accessing premium tools.
// ============================================================

const supabase = require("../utils/supabase");
const { getUserCoinBalance } = require("../utils/coins");

async function subscriptionMiddleware(req, res, next) {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: "Authentication required. Please log in first.",
        subscriptionRequired: true,
      });
    }

    const userId = req.user.id;

    // Fetch user profile safely using select('*') so schema differences don't break access
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error || !profile) {
      return res.status(403).json({
        error: "User profile not found. Please log in or subscribe.",
        subscriptionRequired: true,
      });
    }

    // Admins bypass subscription requirements
    if (profile.role === "admin" || req.user.app_metadata?.role === "admin") {
      req.userProfile = profile;
      req.userPlan = "pro";
      req.hasSubscription = true;
      req.userCoins = 9999;
      return next();
    }

    let plan = (profile.plan || "free").toLowerCase();
    let status = (profile.subscription_status || "inactive").toLowerCase();
    const hasExpired = profile.subscription_end
      ? new Date(profile.subscription_end).getTime() < Date.now()
      : false;

    if (plan !== "free" && hasExpired) {
      plan = "free";
      status = "expired";
      await supabase
        .from("profiles")
        .update({ plan: "free", subscription_status: "expired" })
        .eq("id", userId)
        .catch(() => {});
    }

    const hasActiveSubscription = plan !== "free" && status === "active" && !hasExpired;
    const coinInfo = await getUserCoinBalance(userId, req.user);
    const userCoins = Number(coinInfo.coins ?? 0);

    // If neither active subscription nor coins available
    if (!hasActiveSubscription && userCoins <= 0) {
      return res.status(403).json({
        error: "Active subscription or CampusCoins required. Please choose a plan or top up coins to continue.",
        subscriptionRequired: true,
        coinsNeeded: true,
        insufficientCoins: true,
        coins: userCoins,
        plan,
        status,
      });
    }

    // Attach profile and verified status to request
    req.userProfile = profile;
    req.userPlan = hasActiveSubscription ? plan : "coins";
    req.hasSubscription = hasActiveSubscription;
    req.userCoins = userCoins;
    next();
  } catch (err) {
    console.error("Subscription middleware error:", err.message);
    res.status(500).json({ error: "Failed to verify subscription." });
  }
}

module.exports = subscriptionMiddleware;
