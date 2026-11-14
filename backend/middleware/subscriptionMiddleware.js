// ============================================================
// middleware/subscriptionMiddleware.js — Plan & Wallet Resolver
//
// Resolves the user's real subscription plan (auto-reverting expired
// plans to 'free'), active status, and CampusCoins balance.
// Per-tool access, daily/monthly limits, and coin charges are enforced
// centrally via usageService.evaluateToolAccess().
// ============================================================

const supabase = require("../utils/supabase");
const { getUserCoinBalance } = require("../utils/coins");
const { resolveEffectiveSubscription } = require("../utils/usageService");

async function subscriptionMiddleware(req, res, next) {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: "Authentication required. Please log in first.",
        subscriptionRequired: true,
      });
    }

    const userId = req.user.id;

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error || !profile) {
      return res.status(403).json({
        error: "User profile not found. Please log in again.",
        subscriptionRequired: true,
      });
    }

    const isAdmin =
      profile.role === "admin" || req.user.app_metadata?.role === "admin";

    if (isAdmin) {
      req.userProfile = profile;
      req.userPlan = "pro";
      req.effectivePlan = "pro";
      req.subscriptionStatus = "active";
      req.subscriptionEnd = null;
      req.subscriptionSource = "admin";
      req.hasSubscription = true;
      req.isAdmin = true;
      req.userCoins = 9999;
      return next();
    }

    const sub = await resolveEffectiveSubscription(userId, profile);
    const coinInfo = await getUserCoinBalance(userId, req.user);
    const userCoins = Number(coinInfo.coins ?? 0);

    req.userProfile = sub.profile || profile;
    req.userPlan = sub.plan; // 'free' | 'plus' | 'pro'
    req.effectivePlan = sub.plan;
    req.subscriptionStatus = sub.status;
    req.subscriptionEnd = sub.subscriptionEnd;
    req.subscriptionSource = sub.subscriptionSource;
    req.hasSubscription = sub.plan === "plus" || sub.plan === "pro";
    req.isAdmin = false;
    req.userCoins = userCoins;

    next();
  } catch (err) {
    console.error("Subscription middleware error:", err.message);
    res.status(500).json({ error: "Failed to verify subscription." });
  }
}

module.exports = subscriptionMiddleware;
