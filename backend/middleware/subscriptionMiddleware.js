// ============================================================
// middleware/subscriptionMiddleware.js — Enforce Pay-First Access
//
// Ensures that only users with an active paid plan (plus or pro)
// can access study, upload, and generation features.
// ============================================================

const supabase = require("../utils/supabase");

async function subscriptionMiddleware(req, res, next) {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: "Authentication required. Please log in first.",
        subscriptionRequired: true,
      });
    }

    const userId = req.user.id;

    // Fetch user profile to check subscription status
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, role, plan, subscription_status, subscription_end")
      .eq("id", userId)
      .single();

    if (error || !profile) {
      return res.status(403).json({
        error: "User profile not found. Please log in or subscribe.",
        subscriptionRequired: true,
      });
    }

    // Admins bypass subscription requirements
    if (profile.role === "admin") {
      req.userProfile = profile;
      req.userPlan = "pro";
      return next();
    }

    const plan = (profile.plan || "free").toLowerCase();
    const status = (profile.subscription_status || "inactive").toLowerCase();
    const hasExpired = profile.subscription_end
      ? new Date(profile.subscription_end).getTime() < Date.now()
      : false;

    // Reject free plan or inactive/expired subscriptions
    if (plan === "free" || status !== "active" || hasExpired) {
      return res.status(403).json({
        error: "Active subscription required. Please subscribe to CampusTutor AI to unlock this feature.",
        subscriptionRequired: true,
        plan: plan,
        status: hasExpired ? "expired" : status,
      });
    }

    // Attach profile and verified plan to request
    req.userProfile = profile;
    req.userPlan = plan;
    next();
  } catch (err) {
    console.error("Subscription middleware error:", err.message);
    res.status(500).json({ error: "Failed to verify subscription." });
  }
}

module.exports = subscriptionMiddleware;
