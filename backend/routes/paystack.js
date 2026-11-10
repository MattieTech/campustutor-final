// ============================================================
// routes/paystack.js — Paystack Checkout & Webhooks
// ============================================================

const express = require("express");
const router = express.Router();
const https = require("https");
const supabase = require("../utils/supabase");
const authMiddleware = require("../middleware/authMiddleware");
const crypto = require("crypto");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "sk_test_mockkey";

// ── INITIALIZE CHECKOUT ───────────────────────────────────────
// POST /api/paystack/initialize
router.post("/initialize", authMiddleware, async (req, res) => {
  try {
    const planName = (req.body.planName || req.body.planType || "").toLowerCase();
    const duration = parseInt(req.body.duration || "1");
    const userId = req.user.id;

    if (!planName || !["plus", "pro"].includes(planName)) {
      return res.status(400).json({ error: "Invalid plan name. Choose 'plus' or 'pro'." });
    }

    // Get user email
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .single();

    if (profileErr || !profile) {
      return res.status(404).json({ error: "User profile not found." });
    }

    // Dynamic pricing based on tiers & duration (in Kobo: NGN * 100)
    let amount = 0;
    if (planName === "plus") {
      if (duration === 3) amount = 250000;      // ₦2,500
      else if (duration === 6) amount = 450000; // ₦4,500
      else amount = 100000;                     // ₦1,000
    } else if (planName === "pro") {
      if (duration === 3) amount = 400000;      // ₦4,000
      else if (duration === 6) amount = 750000; // ₦7,500
      else amount = 250000;                     // ₦2,500
    }

    const callbackBase = req.body.callbackUrl || `${req.headers.origin || "http://localhost:3000"}/pages/dashboard.html`;
    const callbackUrl = callbackBase.includes("?") 
      ? `${callbackBase}&payment=success&plan=${planName}&duration=${duration}`
      : `${callbackBase}?payment=success&plan=${planName}&duration=${duration}`;

    const params = JSON.stringify({
      email: profile.email,
      amount: amount,
      callback_url: callbackUrl,
      metadata: {
        userId,
        planName,
        duration,
      },
    });

    const options = {
      hostname: "api.paystack.co",
      port: 443,
      path: "/transaction/initialize",
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
      },
    };

    const paystackReq = https.request(options, (paystackRes) => {
      let data = "";

      paystackRes.on("data", (chunk) => {
        data += chunk;
      });

      paystackRes.on("end", () => {
        try {
          const response = JSON.parse(data);
          if (response.status) {
            res.json({ 
              checkoutUrl: response.data.authorization_url, 
              authorization_url: response.data.authorization_url, 
              reference: response.data.reference 
            });
          } else {
            res.status(400).json({ error: response.message || "Paystack initialization failed." });
          }
        } catch (e) {
          res.status(500).json({ error: "Parsing response failed." });
        }
      });
    });

    paystackReq.on("error", (error) => {
      console.error("Paystack API error:", error);
      res.status(500).json({ error: "Failed to connect to Paystack." });
    });

    paystackReq.write(params);
    paystackReq.end();
  } catch (err) {
    console.error("Initialize checkout error:", err);
    res.status(500).json({ error: "Failed to initialize checkout." });
  }
});

// Helper: Idempotent fulfillment for Paystack payment (coins or subscription)
async function processPaystackTransaction(reference, userId, meta = {}) {
  const { addCoins, getUserCoinBalance } = require("../utils/coins");

  // Check idempotency via Supabase Auth user_metadata
  const { data: userData } = await supabase.auth.admin.getUserById(userId);
  const authUser = userData?.user || null;
  const userMeta = authUser?.user_metadata || {};
  const processedRefs = Array.isArray(userMeta.processed_paystack_refs) ? userMeta.processed_paystack_refs : [];

  if (reference && processedRefs.includes(reference)) {
    const { data: freshProfile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    const coinInfo = await getUserCoinBalance(userId, authUser);
    return {
      alreadyProcessed: true,
      type: meta.type === "coins" || meta.coinsAwarded ? "coins" : "plan",
      plan: (freshProfile?.plan || "free").toLowerCase(),
      coins: Number(coinInfo.coins ?? 0),
      user: freshProfile,
    };
  }

  // Record reference first to prevent concurrent double-crediting
  if (reference && authUser) {
    const updatedRefs = [...processedRefs, reference].slice(-50);
    await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { ...userMeta, processed_paystack_refs: updatedRefs },
    }).catch(() => {});
  }

  // Case 1: Coin Pack Purchase
  if (meta.type === "coins" || meta.coinsAwarded) {
    const coinsToAdd = Number(meta.coinsAwarded || 100);
    const addRes = await addCoins(userId, coinsToAdd, "buy_coins", `Purchased coin pack (+${coinsToAdd} coins)`, authUser);
    const { data: freshProfile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();

    return {
      alreadyProcessed: false,
      type: "coins",
      coinsAdded: coinsToAdd,
      coins: Number(addRes.coins ?? 0),
      plan: (freshProfile?.plan || "free").toLowerCase(),
      user: freshProfile,
    };
  }

  // Case 2: Subscription Plan Purchase
  const planName = (meta.planName || meta.planType || "plus").toLowerCase();
  const durationMonths = parseInt(meta.duration || "1") || 1;
  const subscriptionEnd = new Date();
  subscriptionEnd.setMonth(subscriptionEnd.getMonth() + durationMonths);

  const { data: updatedProfile, error: updateErr } = await supabase
    .from("profiles")
    .update({
      plan: planName,
      subscription_status: "active",
      subscription_end: subscriptionEnd.toISOString(),
    })
    .eq("id", userId)
    .select()
    .single();

  if (updateErr) {
    throw new Error("Failed to activate subscription in database.");
  }

  // Process Referral Commission (₦200 for Plus, ₦500 for Pro)
  if (updatedProfile && updatedProfile.referred_by) {
    const reward = planName === "pro" ? 500 : 200;
    const { data: existingRef } = await supabase
      .from("referrals")
      .select("*")
      .eq("referrer_id", updatedProfile.referred_by)
      .eq("referee_id", userId)
      .maybeSingle();

    if (existingRef && existingRef.status !== "completed") {
      await supabase
        .from("referrals")
        .update({ reward_amount: reward, status: "completed" })
        .eq("id", existingRef.id);
    } else if (!existingRef) {
      await supabase.from("referrals").insert({
        referrer_id: updatedProfile.referred_by,
        referee_id: userId,
        reward_amount: reward,
        status: "completed",
        created_at: new Date().toISOString(),
      });
    }
  }

  return {
    alreadyProcessed: false,
    type: "plan",
    plan: planName,
    subscriptionEnd: subscriptionEnd.toISOString(),
    user: updatedProfile,
  };
}

// ── VERIFY TRANSACTION DIRECTLY ───────────────────────────────
// GET /api/paystack/verify/:reference
router.get("/verify/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    if (!reference) {
      return res.status(400).json({ error: "Reference parameter is required." });
    }

    let tokenUserId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const { data: { user }, error: tokenErr } = await supabase.auth.getUser(token);
        if (!tokenErr && user) {
          tokenUserId = user.id;
        }
      } catch (e) {}
    }

    const options = {
      hostname: "api.paystack.co",
      port: 443,
      path: `/transaction/verify/${encodeURIComponent(reference)}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
      },
    };

    const verifyReq = https.request(options, (verifyRes) => {
      let data = "";
      verifyRes.on("data", (chunk) => {
        data += chunk;
      });

      verifyRes.on("end", async () => {
        try {
          const response = JSON.parse(data);
          if (response.status && response.data && response.data.status === "success") {
            const meta = response.data.metadata || {};
            const effectiveUserId = tokenUserId || meta.userId;

            if (!effectiveUserId) {
              return res.status(400).json({ error: "Could not associate payment with a user profile." });
            }

            const result = await processPaystackTransaction(reference, effectiveUserId, meta);
            if (result.type === "coins") {
              return res.json({
                success: true,
                type: "coins",
                plan: result.plan,
                coinsAdded: result.coinsAdded || 0,
                user: result.user,
                coins: result.coins,
                message: result.alreadyProcessed
                  ? "CampusCoins already credited to your wallet."
                  : `+${result.coinsAdded} CampusCoins added to your wallet!`,
              });
            }

            return res.json({
              success: true,
              message: `Successfully upgraded to ${result.plan.toUpperCase()} plan!`,
              plan: result.plan,
              type: "plan",
              subscriptionEnd: result.subscriptionEnd || null,
              user: result.user,
            });
          } else {
            return res.status(400).json({
              success: false,
              error: response.data?.gateway_response || response.message || "Payment verification failed or incomplete.",
            });
          }
        } catch (parseErr) {
          console.error("Parse verification error:", parseErr);
          res.status(500).json({ error: "Failed to parse verification response." });
        }
      });
    });

    verifyReq.on("error", (err) => {
      console.error("Paystack verify API error:", err);
      res.status(500).json({ error: "Failed to communicate with Paystack." });
    });

    verifyReq.end();
  } catch (err) {
    console.error("Verification endpoint error:", err);
    res.status(500).json({ error: "Failed to verify transaction." });
  }
});

// ── PAYSTACK WEBHOOK ──────────────────────────────────────────
// POST /api/paystack/webhook
router.post("/webhook", async (req, res) => {
  try {
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers["x-paystack-signature"];

    // Validate Signature
    const hash = crypto
      .createHmac("sha256", PAYSTACK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (hash !== signature) {
      console.error("❌ Invalid Paystack signature.");
      return res.status(401).json({ error: "Invalid webhook signature." });
    }

    const event = req.body;
    console.log(`🔌 Paystack Webhook Event: ${event.event}`);

    if (event.event === "charge.success") {
      const metadata = event.data?.metadata || {};
      const reference = event.data?.reference;
      const userId = metadata.userId;

      if (!userId) {
        console.warn("⚠️ Webhook event missing userId.");
        return res.sendStatus(200);
      }

      await processPaystackTransaction(reference, userId, metadata);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Paystack webhook error:", err);
    res.status(500).json({ error: "Webhook handling failed." });
  }
});

module.exports = router;
