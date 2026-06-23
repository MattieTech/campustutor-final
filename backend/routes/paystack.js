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
      const metadata = event.data.metadata;
      const { userId, planName } = metadata || {};

      if (!userId || !planName) {
        console.warn("⚠️ Webhook event missing metadata (userId/planName).");
        return res.sendStatus(200); // return 200 to prevent Paystack retries
      }

      const subscriptionEnd = new Date();
      subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 1);

      // 1. Upgrade user plan in profiles
      const { data: profile, error: updateErr } = await supabase
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
        console.error("❌ Failed to update user plan on success:", updateErr.message);
        return res.status(500).json({ error: "Database update failed." });
      }

      console.log(`🚀 User ${userId} upgraded to ${planName.toUpperCase()} plan.`);

      // 2. Process Referral Rewards
      if (profile && profile.referred_by) {
        const reward = planName === "pro" ? 250 : 200;

        // Update referrals record if exists
        const { data: existingRef } = await supabase
          .from("referrals")
          .select("*")
          .eq("referrer_id", profile.referred_by)
          .eq("referee_id", userId)
          .single();

        if (existingRef) {
          await supabase
            .from("referrals")
            .update({
              reward_amount: reward,
              status: "completed",
            })
            .eq("id", existingRef.id);
          
          console.log(`🎁 Reward of ${reward} awarded to Referrer ${profile.referred_by} for Referee ${userId}`);
        } else {
          // If no pre-existing record, insert one anyway
          await supabase.from("referrals").insert({
            referrer_id: profile.referred_by,
            referee_id: userId,
            reward_amount: reward,
            status: "completed",
            created_at: new Date().toISOString(),
          });
          console.log(`🎁 Created referral record and awarded ${reward} to Referrer ${profile.referred_by}`);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Paystack webhook error:", err);
    res.status(500).json({ error: "Webhook handling failed." });
  }
});

module.exports = router;
