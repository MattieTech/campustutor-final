// ============================================================
// routes/paystack.js — Secure Paystack Checkout, Verify & Webhook
// ============================================================

const express = require("express");
const router = express.Router();
const https = require("https");
const crypto = require("crypto");
const supabase = require("../utils/supabase");
const authMiddleware = require("../middleware/authMiddleware");
const { PLAN_PRICING } = require("../utils/toolConfig");
const { COIN_PACKAGES } = require("./coins");
const { addCoins, getUserCoinBalance } = require("../utils/coins");
const {
  withReferenceLock,
  getPaymentByReference,
  recordPayment,
} = require("../utils/paymentLedger");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "";

function getExpectedPlanAmountKobo(planName, durationMonths) {
  const plan = PLAN_PRICING[String(planName || "").toLowerCase()];
  if (!plan) return null;
  const dur = plan.durations[Number(durationMonths)];
  return dur ? dur.amountKobo : null;
}

function getExpectedCoinPack(meta = {}) {
  if (meta.packageId && COIN_PACKAGES[meta.packageId]) {
    return COIN_PACKAGES[meta.packageId];
  }
  if (meta.coinsAwarded) {
    return Object.values(COIN_PACKAGES).find((p) => p.coins === Number(meta.coinsAwarded)) || null;
  }
  return null;
}

// ── INITIALIZE CHECKOUT ───────────────────────────────────────
// POST /api/paystack/initialize
router.post("/initialize", authMiddleware, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) {
      return res.status(503).json({ error: "Payment service is not configured." });
    }

    const planName = String(req.body.planName || req.body.planType || "").toLowerCase();
    const duration = parseInt(req.body.duration || "1", 10);
    const userId = req.user.id;

    if (!["plus", "pro"].includes(planName)) {
      return res.status(400).json({ error: "Invalid plan name. Choose 'plus' or 'pro'." });
    }

    const amountKobo = getExpectedPlanAmountKobo(planName, duration);
    if (!amountKobo) {
      return res.status(400).json({ error: "Invalid subscription duration. Choose 1, 3, or 6 months." });
    }

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .single();

    if (profileErr || !profile) {
      return res.status(404).json({ error: "User profile not found." });
    }

    const callbackBase = req.body.callbackUrl || `${req.headers.origin || "http://localhost:3000"}/pages/dashboard.html`;
    const callbackUrl = callbackBase.includes("?")
      ? `${callbackBase}&payment=success&plan=${planName}&duration=${duration}`
      : `${callbackBase}?payment=success&plan=${planName}&duration=${duration}`;

    const params = JSON.stringify({
      email: profile.email,
      amount: amountKobo,
      currency: "NGN",
      callback_url: callbackUrl,
      metadata: {
        userId,
        type: "subscription",
        planName,
        duration,
        expectedAmountKobo: amountKobo,
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
      paystackRes.on("data", (chunk) => { data += chunk; });
      paystackRes.on("end", () => {
        try {
          const response = JSON.parse(data);
          if (response.status) {
            res.json({
              checkoutUrl: response.data.authorization_url,
              authorization_url: response.data.authorization_url,
              reference: response.data.reference,
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

// ── IDEMPOTENT & AMOUNT-VERIFIED FULFILLMENT ──────────────────
async function processPaystackTransaction(reference, userId, meta = {}, gatewayData = {}) {
  if (!reference) {
    throw new Error("Transaction reference is required.");
  }

  return withReferenceLock(reference, async () => {
    // 1. Check persistent payment ledger first
    const existingPayment = await getPaymentByReference(reference);
    if (existingPayment && existingPayment.status === "success") {
      const { data: freshProfile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
      const coinInfo = await getUserCoinBalance(userId);
      return {
        alreadyProcessed: true,
        type: existingPayment.payment_type === "coins" ? "coins" : "plan",
        plan: (freshProfile?.plan || existingPayment.plan_name || "free").toLowerCase(),
        coinsAdded: Number(existingPayment.coins_awarded || 0),
        coins: Number(coinInfo.coins ?? 0),
        subscriptionEnd: freshProfile?.subscription_end || null,
        user: freshProfile,
      };
    }

    // 2. Also check user_metadata processed_paystack_refs for backward compatibility
    const { data: userData } = await supabase.auth.admin.getUserById(userId);
    const authUser = userData?.user || null;
    const userMeta = authUser?.user_metadata || {};
    const processedRefs = Array.isArray(userMeta.processed_paystack_refs)
      ? userMeta.processed_paystack_refs
      : [];

    if (processedRefs.includes(reference)) {
      const { data: freshProfile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
      const coinInfo = await getUserCoinBalance(userId, authUser);
      return {
        alreadyProcessed: true,
        type: meta.type === "coins" || meta.coinsAwarded ? "coins" : "plan",
        plan: (freshProfile?.plan || "free").toLowerCase(),
        coins: Number(coinInfo.coins ?? 0),
        subscriptionEnd: freshProfile?.subscription_end || null,
        user: freshProfile,
      };
    }

    const paidAmountKobo = Number(gatewayData.amount || 0);
    const paidCurrency = String(gatewayData.currency || "NGN").toUpperCase();
    if (paidCurrency !== "NGN") {
      throw new Error(`Unexpected payment currency: ${paidCurrency}`);
    }

    // Case 1: Coin Pack Purchase
    if (meta.type === "coins" || meta.coinsAwarded || meta.packageId) {
      const pkg = getExpectedCoinPack(meta);
      if (!pkg) {
        throw new Error("Invalid or unrecognized coin package in payment metadata.");
      }
      if (paidAmountKobo < pkg.amountKobo) {
        throw new Error(`Insufficient payment amount for ${pkg.name}. Expected ₦${pkg.priceNGN}, received ₦${paidAmountKobo / 100}.`);
      }

      const addRes = await addCoins(
        userId,
        pkg.coins,
        "buy_coins",
        `Purchased ${pkg.name} (+${pkg.coins} coins) [Ref: ${reference}]`,
        authUser,
        { transactionType: "purchase", reason: `Paystack ${pkg.name} (${reference})` }
      );
      if (!addRes.success) {
        throw new Error(addRes.error || "Failed to credit purchased coins.");
      }

      await recordPayment({
        reference,
        userId,
        paymentType: "coins",
        packageId: pkg.id,
        coinsAwarded: pkg.coins,
        amountKobo: paidAmountKobo,
        currency: paidCurrency,
        status: "success",
        gatewayResponse: gatewayData.gateway_response || "Approved",
        metadata: meta,
      });

      if (authUser) {
        const updatedRefs = [...processedRefs, reference].slice(-50);
        await supabase.auth.admin
          .updateUserById(userId, { user_metadata: { ...userMeta, processed_paystack_refs: updatedRefs } })
          .catch(() => {});
      }

      const { data: freshProfile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
      return {
        alreadyProcessed: false,
        type: "coins",
        coinsAdded: pkg.coins,
        coins: Number(addRes.coins ?? 0),
        plan: (freshProfile?.plan || "free").toLowerCase(),
        user: freshProfile,
      };
    }

    // Case 2: Subscription Plan Purchase
    const planName = String(meta.planName || meta.planType || meta.plan || "").toLowerCase();
    const durationMonths = parseInt(meta.duration || meta.durationMonths || "1", 10);
    const expectedAmountKobo = getExpectedPlanAmountKobo(planName, durationMonths);

    if (!["plus", "pro"].includes(planName) || !expectedAmountKobo) {
      throw new Error("Invalid subscription plan or duration in payment metadata.");
    }
    if (paidAmountKobo < expectedAmountKobo) {
      throw new Error(
        `Insufficient payment amount for ${planName.toUpperCase()} (${durationMonths} mo). Expected ₦${expectedAmountKobo / 100}, got ₦${paidAmountKobo / 100}.`
      );
    }

    // Check existing profile to preserve remaining active time when extending same plan
    const { data: currentProfile } = await supabase
      .from("profiles")
      .select("plan, subscription_status, subscription_end")
      .eq("id", userId)
      .maybeSingle();

    const now = new Date();
    let baseDate = now;
    if (
      currentProfile &&
      String(currentProfile.plan || "").toLowerCase() === planName &&
      String(currentProfile.subscription_status || "").toLowerCase() === "active" &&
      currentProfile.subscription_end &&
      new Date(currentProfile.subscription_end) > now
    ) {
      baseDate = new Date(currentProfile.subscription_end);
    }

    const subscriptionEnd = new Date(baseDate);
    subscriptionEnd.setMonth(subscriptionEnd.getMonth() + durationMonths);

    let updatePayload = {
      plan: planName,
      subscription_status: "active",
      subscription_end: subscriptionEnd.toISOString(),
      subscription_source: "paystack",
      subscription_note: `Paystack Ref: ${reference} (${durationMonths} mo)`,
    };

    let { data: updatedProfile, error: updateErr } = await supabase
      .from("profiles")
      .update(updatePayload)
      .eq("id", userId)
      .select()
      .single();

    // Backward compatibility if subscription_source column isn't migrated yet
    if (updateErr && (updateErr.code === "42703" || (updateErr.message || "").includes("column"))) {
      ({ data: updatedProfile, error: updateErr } = await supabase
        .from("profiles")
        .update({
          plan: planName,
          subscription_status: "active",
          subscription_end: subscriptionEnd.toISOString(),
        })
        .eq("id", userId)
        .select()
        .single());
    }

    if (updateErr) {
      throw new Error("Failed to activate subscription in database.");
    }

    await recordPayment({
      reference,
      userId,
      paymentType: "subscription",
      planName,
      durationMonths,
      amountKobo: paidAmountKobo,
      currency: paidCurrency,
      status: "success",
      gatewayResponse: gatewayData.gateway_response || "Approved",
      metadata: meta,
    });

    if (authUser) {
      const updatedRefs = [...processedRefs, reference].slice(-50);
      await supabase.auth.admin
        .updateUserById(userId, { user_metadata: { ...userMeta, processed_paystack_refs: updatedRefs } })
        .catch(() => {});
    }

    try {
      await supabase
        .from("user_activity")
        .insert({
          user_id: userId,
          action: "subscription_activated",
          details: `Activated ${planName.toUpperCase()} Plan (${durationMonths} mo) via Paystack (${reference})`,
          created_at: new Date().toISOString(),
        });
    } catch (_) {}

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
  });
}

// ── VERIFY TRANSACTION DIRECTLY ───────────────────────────────
// GET /api/paystack/verify/:reference
router.get("/verify/:reference", authMiddleware, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) {
      return res.status(503).json({ error: "Payment service is not configured." });
    }

    const { reference } = req.params;
    if (!reference) {
      return res.status(400).json({ error: "Reference parameter is required." });
    }

    const tokenUserId = req.user.id;

    // Fast-path: check persistent ledger first for ownership & idempotency
    const recorded = await getPaymentByReference(reference);
    if (recorded) {
      const ownerId = recorded.user_id || recorded.userId;
      if (ownerId && ownerId !== tokenUserId) {
        return res.status(403).json({ error: "This payment reference does not belong to your account." });
      }
      const { data: freshProfile } = await supabase.from("profiles").select("*").eq("id", tokenUserId).maybeSingle();
      return res.json({
        success: true,
        alreadyProcessed: true,
        type: recorded.paymentType === "coins" ? "coins" : "plan",
        plan: recorded.planName || (freshProfile?.plan || "free").toLowerCase(),
        message: "Payment already verified and applied.",
        user: freshProfile,
      });
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
      verifyRes.on("data", (chunk) => { data += chunk; });

      verifyRes.on("end", async () => {
        try {
          const response = JSON.parse(data);
          if (response.status && response.data && response.data.status === "success") {
            const meta = response.data.metadata || {};
            if (meta.userId && meta.userId !== tokenUserId) {
              return res.status(403).json({ error: "This payment reference does not belong to your account." });
            }

            const result = await processPaystackTransaction(reference, tokenUserId, meta, response.data);
            if (result.type === "coins") {
              return res.json({
                success: true,
                alreadyProcessed: result.alreadyProcessed,
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
              alreadyProcessed: result.alreadyProcessed,
              message: result.alreadyProcessed
                ? `Your ${result.plan.toUpperCase()} subscription is already active.`
                : `Successfully upgraded to ${result.plan.toUpperCase()} plan!`,
              plan: result.plan,
              type: "plan",
              subscriptionEnd: result.subscriptionEnd || null,
              user: result.user,
            });
          }

          return res.status(400).json({
            success: false,
            error: response.data?.gateway_response || response.message || "Payment verification failed or incomplete.",
          });
        } catch (parseErr) {
          console.error("Verify error:", parseErr.message);
          res.status(400).json({ success: false, error: parseErr.message || "Failed to verify payment." });
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
    if (!PAYSTACK_SECRET) {
      return res.status(503).json({ error: "Payment service not configured." });
    }

    const rawBody = req.rawBody ? req.rawBody : JSON.stringify(req.body);
    const signature = req.headers["x-paystack-signature"];
    if (!signature) {
      return res.status(401).json({ error: "Missing Paystack signature." });
    }

    // Paystack signs webhooks with HMAC-SHA512
    const expectedHash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(String(signature), "utf8");
    const hashBuf = Buffer.from(expectedHash, "utf8");
    if (sigBuf.length !== hashBuf.length || !crypto.timingSafeEqual(sigBuf, hashBuf)) {
      console.error("❌ Invalid Paystack webhook signature.");
      return res.status(401).json({ error: "Invalid webhook signature." });
    }

    const event = req.body;
    console.log(`🔌 Paystack Webhook Event: ${event.event}`);

    let hookResult = null;
    if (event.event === "charge.success") {
      const metadata = event.data?.metadata || {};
      const reference = event.data?.reference;
      const userId = metadata.userId;

      if (!userId || !reference) {
        console.warn("⚠️ Webhook event missing userId or reference.");
        return res.status(200).json({ received: true, ignored: true });
      }

      if (event.data?.status && event.data.status !== "success") {
        return res.status(200).json({ received: true, ignored: true });
      }

      hookResult = await processPaystackTransaction(reference, userId, metadata, event.data);
    }

    res.status(200).json({
      received: true,
      duplicate: Boolean(hookResult?.alreadyProcessed),
    });
  } catch (err) {
    console.error("Paystack webhook error:", err.message);
    const isClientError = /insufficient|invalid|unexpected|unrecognized/i.test(err.message || "");
    res.status(isClientError ? 400 : 500).json({ error: err.message || "Webhook handling failed." });
  }
});

module.exports = router;
module.exports.processPaystackTransaction = processPaystackTransaction;
