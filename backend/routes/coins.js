// ============================================================
// routes/coins.js — CampusCoins Wallet, Purchasing & Daily Streaks
// ============================================================

const express = require("express");
const router = express.Router();
const https = require("https");
const authMiddleware = require("../middleware/authMiddleware");
const { getUserCoinBalance, claimDailyBonus } = require("../utils/coins");
const supabase = require("../utils/supabase");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "sk_test_mockkey";

// Expensive coin packages definition (100 coins = ₦1,500)
const COIN_PACKAGES = {
  starter: { id: "starter", name: "Starter Stash", coins: 100, priceNGN: 1500, amountKobo: 150000 },
  popular: { id: "popular", name: "Scholar Pack", coins: 250, priceNGN: 3500, amountKobo: 350000 },
  pro:     { id: "pro",     name: "Campus Master", coins: 600, priceNGN: 7500, amountKobo: 750000 },
  vip:     { id: "vip",     name: "Semester Pass", coins: 1600, priceNGN: 18000, amountKobo: 1800000 },
};

// ── GET AVAILABLE PACKAGES ────────────────────────────────────
// GET /api/coins/packages
router.get("/packages", (req, res) => {
  res.json({ packages: Object.values(COIN_PACKAGES) });
});

// ── GET USER COIN BALANCE ─────────────────────────────────────
// GET /api/coins/balance
router.get("/balance", authMiddleware, async (req, res) => {
  try {
    const data = await getUserCoinBalance(req.user.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve coin balance." });
  }
});

// ── CLAIM DAILY LOGIN BONUS (GAMIFICATION) ────────────────────
// POST /api/coins/claim-daily
router.post("/claim-daily", authMiddleware, async (req, res) => {
  try {
    const result = await claimDailyBonus(req.user.id);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to claim daily reward." });
  }
});

// ── BUY COINS CHECKOUT (PAYSTACK) ─────────────────────────────
// POST /api/coins/buy-package
router.post("/buy-package", authMiddleware, async (req, res) => {
  try {
    let { packageId, coins, amountNgn } = req.body;
    let pkg = null;

    if (packageId && COIN_PACKAGES[packageId]) {
      pkg = COIN_PACKAGES[packageId];
    } else if (coins) {
      // Find matching package by coins
      pkg = Object.values(COIN_PACKAGES).find(p => p.coins === Number(coins));
    }

    // Fallback if custom or direct
    if (!pkg) {
      if (coins && amountNgn) {
        pkg = {
          id: `custom_${coins}`,
          name: `${coins} CampusCoins`,
          coins: Number(coins),
          priceNGN: Number(amountNgn),
          amountKobo: Number(amountNgn) * 100,
        };
      } else {
        return res.status(400).json({ error: "Invalid coin package selected." });
      }
    }

    const userId = req.user.id;
    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .single();

    if (!profile) {
      return res.status(404).json({ error: "User profile not found." });
    }

    const callbackBase = req.body.callbackUrl || `${req.headers.origin || "http://localhost:3000"}/pages/dashboard.html`;
    const callbackUrl = callbackBase.includes("?")
      ? `${callbackBase}&payment=coins_success&pkg=${packageId}`
      : `${callbackBase}?payment=coins_success&pkg=${packageId}`;

    const params = JSON.stringify({
      email: profile.email,
      amount: pkg.amountKobo,
      callback_url: callbackUrl,
      metadata: {
        userId,
        type: "coins",
        packageId,
        coinsAwarded: pkg.coins,
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
              package: pkg,
            });
          } else {
            res.status(400).json({ error: response.message || "Paystack initialization failed." });
          }
        } catch (e) {
          res.status(500).json({ error: "Could not parse Paystack response." });
        }
      });
    });

    paystackReq.on("error", (error) => {
      res.status(500).json({ error: "Failed to connect to Paystack." });
    });

    paystackReq.write(params);
    paystackReq.end();
  } catch (err) {
    res.status(500).json({ error: "Failed to initialize coin purchase." });
  }
});

// ── GET TRANSACTION HISTORY ───────────────────────────────────
// GET /api/coins/history
router.get("/history", authMiddleware, async (req, res) => {
  try {
    const { data: logs, error } = await supabase
      .from("coin_transactions")
      .select("amount, action_type, description, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      return res.json({ history: [] });
    }
    res.json({ history: logs || [] });
  } catch (err) {
    res.json({ history: [] });
  }
});

module.exports = router;
module.exports.COIN_PACKAGES = COIN_PACKAGES;
