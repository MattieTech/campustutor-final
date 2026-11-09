// ============================================================
// utils/coins.js — CampusCoins Economy & Gamified Rewards
// ============================================================

const supabase = require("./supabase");

let _hasCoinsColumn = null;

/**
 * Check if profiles table has native 'coins' column.
 * If not, seamlessly falls back to existing 'xp', 'streak', and 'last_activity_date' columns.
 */
async function checkCoinsColumn() {
  if (_hasCoinsColumn !== null) return _hasCoinsColumn;
  try {
    const { error } = await supabase.from("profiles").select("coins").limit(1);
    _hasCoinsColumn = !(error && error.code === "42703");
  } catch (e) {
    _hasCoinsColumn = false;
  }
  return _hasCoinsColumn;
}

/**
 * Get user's current coin balance and daily bonus status
 */
async function getUserCoinBalance(userId) {
  try {
    const hasCol = await checkCoinsColumn();
    const selectCols = hasCol
      ? "coins, last_daily_bonus, daily_streak_count, role, plan, subscription_status"
      : "xp, last_activity_date, streak, role, plan, subscription_status";

    const { data: profile, error } = await supabase
      .from("profiles")
      .select(selectCols)
      .eq("id", userId)
      .single();

    if (error || !profile) {
      return { coins: 5, canClaimDaily: true, streak: 1, lastClaim: null, plan: "free" };
    }

    const todayStr = new Date().toISOString().split("T")[0];
    const lastClaim = hasCol ? profile.last_daily_bonus : profile.last_activity_date;
    const canClaimDaily = !lastClaim || lastClaim !== todayStr;
    const streak = Math.max(1, Number((hasCol ? profile.daily_streak_count : profile.streak) || 1));
    const rawVal = hasCol ? profile.coins : profile.xp;
    // New accounts get initial 5 coins starter balance
    const coins = (rawVal === null || rawVal === undefined) ? 5 : Number(rawVal);

    return {
      coins,
      canClaimDaily,
      streak,
      lastClaim,
      plan: profile.plan || "free",
    };
  } catch (err) {
    console.error("Error getting user coins:", err.message);
    return { coins: 5, canClaimDaily: true, streak: 1, lastClaim: null, plan: "free" };
  }
}

/**
 * Add coins to a user's wallet
 */
async function addCoins(userId, amount, actionType, description = "") {
  try {
    const hasCol = await checkCoinsColumn();
    const colName = hasCol ? "coins" : "xp";

    const { data: profile } = await supabase
      .from("profiles")
      .select(colName)
      .eq("id", userId)
      .single();

    const currentCoins = Number((hasCol ? profile?.coins : profile?.xp) ?? 0);
    const newBalance = currentCoins + Number(amount);

    const updatePayload = hasCol ? { coins: newBalance } : { xp: newBalance };
    await supabase
      .from("profiles")
      .update(updatePayload)
      .eq("id", userId);

    // Record ledger transaction if table exists
    try {
      await supabase.from("coin_transactions").insert({
        user_id: userId,
        amount: Number(amount),
        action_type: actionType,
        description: description || `Earned ${amount} coins via ${actionType}`,
        balance_after: newBalance,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      // Ledger table is optional
    }

    return { success: true, coins: newBalance };
  } catch (err) {
    console.error("Error adding coins:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Deduct coins from user's wallet
 */
async function deductCoins(userId, amount, actionType, description = "") {
  try {
    const hasCol = await checkCoinsColumn();
    const selectCols = hasCol ? "coins, role" : "xp, role";

    const { data: profile, error } = await supabase
      .from("profiles")
      .select(selectCols)
      .eq("id", userId)
      .single();

    if (error || !profile) {
      return { success: false, error: "Profile not found." };
    }

    // Admins have infinite coins
    if (profile.role === "admin") {
      return { success: true, coins: 9999 };
    }

    const currentCoins = Number((hasCol ? profile.coins : profile.xp) ?? 0);
    const numAmount = Number(amount);

    if (currentCoins < numAmount) {
      return {
        success: false,
        insufficient: true,
        currentCoins,
        needed: numAmount,
        error: `Insufficient coins. You have ${currentCoins} coins, but ${numAmount} coins are required.`,
      };
    }

    const newBalance = currentCoins - numAmount;
    const updatePayload = hasCol ? { coins: newBalance } : { xp: newBalance };

    await supabase
      .from("profiles")
      .update(updatePayload)
      .eq("id", userId);

    try {
      await supabase.from("coin_transactions").insert({
        user_id: userId,
        amount: -numAmount,
        action_type: actionType,
        description: description || `Spent ${numAmount} coins on ${actionType}`,
        balance_after: newBalance,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      // Ledger table is optional
    }

    return { success: true, coins: newBalance };
  } catch (err) {
    console.error("Error deducting coins:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Claim Daily Login Reward (Gamification retention loop)
 */
async function claimDailyBonus(userId) {
  try {
    const hasCol = await checkCoinsColumn();
    const selectCols = hasCol
      ? "coins, last_daily_bonus, daily_streak_count"
      : "xp, last_activity_date, streak";

    const { data: profile, error } = await supabase
      .from("profiles")
      .select(selectCols)
      .eq("id", userId)
      .single();

    if (error || !profile) return { success: false, error: "Profile not found." };

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const lastClaim = hasCol ? profile.last_daily_bonus : profile.last_activity_date;

    if (lastClaim === todayStr) {
      return { success: false, alreadyClaimed: true, message: "You already claimed your daily bonus today! Check back tomorrow." };
    }

    // Check streak
    let currentStreak = Number((hasCol ? profile.daily_streak_count : profile.streak) || 1);
    let newStreak = 1;
    if (lastClaim) {
      const lastDate = new Date(lastClaim);
      const diffTime = today.getTime() - lastDate.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays <= 1) {
        newStreak = currentStreak + 1;
      } else {
        newStreak = 1;
      }
    }

    // Daily reward: 3 coins base reward, scales with streak (Day 1-2: 3, Day 3-4: 4, Day 5+: 5)
    const baseReward = 3;
    const streakBonus = Math.min(Math.floor((newStreak - 1) / 2), 2);
    const totalCoinsAwarded = baseReward + streakBonus;

    const currentCoins = Number((hasCol ? profile.coins : profile.xp) ?? 0);
    const newBalance = currentCoins + totalCoinsAwarded;

    const updatePayload = hasCol
      ? {
          coins: newBalance,
          last_daily_bonus: todayStr,
          daily_streak_count: newStreak,
        }
      : {
          xp: newBalance,
          last_activity_date: todayStr,
          streak: newStreak,
        };

    const { error: updateErr } = await supabase
      .from("profiles")
      .update(updatePayload)
      .eq("id", userId);

    if (updateErr) {
      console.error("Daily bonus DB update failed:", updateErr.message);
      return { success: false, error: "Failed to update wallet balance." };
    }

    try {
      await supabase.from("coin_transactions").insert({
        user_id: userId,
        amount: totalCoinsAwarded,
        action_type: "daily_bonus",
        description: `Claimed Day ${newStreak} Daily Study Reward (+${totalCoinsAwarded} coins)`,
        balance_after: newBalance,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      // Optional ledger
    }

    return {
      success: true,
      coinsAwarded: totalCoinsAwarded,
      newBalance,
      streak: newStreak,
      message: `🎉 +${totalCoinsAwarded} CampusCoins added! (Streak: Day ${newStreak})`,
    };
  } catch (err) {
    console.error("Daily bonus error:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  getUserCoinBalance,
  addCoins,
  deductCoins,
  claimDailyBonus,
};
