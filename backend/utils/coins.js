// ============================================================
// utils/coins.js — CampusCoins Economy & Gamified Rewards
// ============================================================

const supabase = require("./supabase");

/**
 * Get user's current coin balance and daily bonus status
 */
async function getUserCoinBalance(userId) {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("coins, last_daily_bonus, daily_streak_count, plan, subscription_status")
      .eq("id", userId)
      .single();

    if (error || !profile) {
      return { coins: 0, canClaimDaily: false, streak: 1 };
    }

    const todayStr = new Date().toISOString().split("T")[0];
    const lastClaim = profile.last_daily_bonus;
    const canClaimDaily = !lastClaim || lastClaim !== todayStr;

    return {
      coins: Number(profile.coins ?? 5),
      canClaimDaily,
      streak: profile.daily_streak_count || 1,
      lastClaim,
    };
  } catch (err) {
    console.error("Error getting user coins:", err.message);
    return { coins: 0, canClaimDaily: false, streak: 1 };
  }
}

/**
 * Add coins to a user's wallet
 */
async function addCoins(userId, amount, actionType, description = "") {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("coins")
      .eq("id", userId)
      .single();

    const currentCoins = Number(profile?.coins ?? 0);
    const newBalance = currentCoins + amount;

    await supabase
      .from("profiles")
      .update({ coins: newBalance })
      .eq("id", userId);

    // Record ledger transaction
    await supabase.from("coin_transactions").insert({
      user_id: userId,
      amount: amount,
      action_type: actionType,
      description: description || `Earned ${amount} coins via ${actionType}`,
      balance_after: newBalance,
      created_at: new Date().toISOString(),
    }).catch(err => console.warn("Could not log coin transaction:", err.message));

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
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("coins, role")
      .eq("id", userId)
      .single();

    if (error || !profile) {
      return { success: false, error: "Profile not found." };
    }

    // Admins have infinite coins
    if (profile.role === "admin") {
      return { success: true, coins: 9999 };
    }

    const currentCoins = Number(profile.coins ?? 0);
    if (currentCoins < amount) {
      return {
        success: false,
        insufficient: true,
        currentCoins,
        needed: amount,
        error: `Insufficient coins. You have ${currentCoins} coins, but ${amount} coins are required.`,
      };
    }

    const newBalance = currentCoins - amount;
    await supabase
      .from("profiles")
      .update({ coins: newBalance })
      .eq("id", userId);

    await supabase.from("coin_transactions").insert({
      user_id: userId,
      amount: -amount,
      action_type: actionType,
      description: description || `Spent ${amount} coins on ${actionType}`,
      balance_after: newBalance,
      created_at: new Date().toISOString(),
    }).catch(err => console.warn("Could not log coin debit:", err.message));

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
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("coins, last_daily_bonus, daily_streak_count")
      .eq("id", userId)
      .single();

    if (error || !profile) return { success: false, error: "Profile not found." };

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    if (profile.last_daily_bonus === todayStr) {
      return { success: false, alreadyClaimed: true, message: "You already claimed your daily bonus today! Check back tomorrow." };
    }

    // Check streak
    let newStreak = 1;
    if (profile.last_daily_bonus) {
      const lastDate = new Date(profile.last_daily_bonus);
      const diffDays = Math.round((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        newStreak = (profile.daily_streak_count || 1) + 1;
      }
    }

    // Expensive coin economy: 3 coins for daily check-in (streak scales gently 3 -> 5 max)
    const baseReward = 3;
    const streakBonus = Math.min(Math.floor((newStreak - 1) / 2), 2); // Day 1-2: 3, Day 3-4: 4, Day 5+: 5
    const totalCoinsAwarded = baseReward + streakBonus;

    const currentCoins = Number(profile.coins ?? 0);
    const newBalance = currentCoins + totalCoinsAwarded;

    await supabase
      .from("profiles")
      .update({
        coins: newBalance,
        last_daily_bonus: todayStr,
        daily_streak_count: newStreak,
      })
      .eq("id", userId);

    await supabase.from("coin_transactions").insert({
      user_id: userId,
      amount: totalCoinsAwarded,
      action_type: "daily_bonus",
      description: `Claimed Day ${newStreak} Daily Study Reward (+${totalCoinsAwarded} coins)`,
      balance_after: newBalance,
      created_at: new Date().toISOString(),
    }).catch(err => console.warn("Could not log bonus transaction:", err.message));

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
