// ============================================================
// utils/coins.js — CampusCoins Economy & Gamified Rewards
// ============================================================

const supabase = require("./supabase");

let _hasCoinsColumn = null;

/**
 * Check if profiles table has native 'coins' column.
 * If not, persists coins & daily reward state in Supabase Auth user_metadata
 * (never mixing or corrupting profiles.xp).
 */
async function checkCoinsColumn() {
  if (_hasCoinsColumn !== null) return _hasCoinsColumn;
  try {
    const { error } = await supabase.from("profiles").select("coins").limit(1);
    _hasCoinsColumn = !(error && (error.code === "42703" || (error.message || "").includes("does not exist")));
  } catch (e) {
    _hasCoinsColumn = false;
  }
  return _hasCoinsColumn;
}

function getTodayAndYesterdayUTC() {
  const todayObj = new Date();
  const todayStr = todayObj.toISOString().split("T")[0];
  const yestObj = new Date(todayObj);
  yestObj.setUTCDate(yestObj.getUTCDate() - 1);
  const yesterdayStr = yestObj.toISOString().split("T")[0];
  return { todayStr, yesterdayStr };
}

/**
 * Compute real active streak: returns 0 if user has never been active
 * or missed yesterday & today.
 */
function computeEffectiveStreak(rawStreak, lastDateStr) {
  const numStreak = Number(rawStreak || 0);
  if (!lastDateStr || numStreak <= 0) return 0;
  const cleanDate = String(lastDateStr).split("T")[0];
  const { todayStr, yesterdayStr } = getTodayAndYesterdayUTC();
  if (cleanDate === todayStr || cleanDate === yesterdayStr) {
    return numStreak;
  }
  return 0;
}

async function getAuthUser(userId, authUser = null) {
  if (authUser && authUser.id === userId) return authUser;
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) return null;
  return data.user;
}

async function recordCoinTransaction(userId, amount, actionType, description, balanceAfter) {
  const now = new Date().toISOString();
  try {
    const { error } = await supabase.from("coin_transactions").insert({
      user_id: userId,
      amount: Number(amount),
      action_type: actionType,
      description: description || `${actionType} (${amount >= 0 ? "+" : ""}${amount} coins)`,
      balance_after: balanceAfter,
      created_at: now,
    });
    if (!error) return;
  } catch (_) {}

  // Fallback to user_activity so students still get real coin history when coin_transactions table isn't migrated
  try {
    const actionLabel = Number(amount) >= 0 ? "coin_credit" : "coin_spend";
    await supabase.from("user_activity").insert({
      user_id: userId,
      action: actionLabel,
      details: JSON.stringify({
        amount: Number(amount),
        action_type: actionType,
        description: description || `${actionType} (${amount >= 0 ? "+" : ""}${amount} coins)`,
        balance_after: balanceAfter,
      }),
      created_at: now,
    });
  } catch (_) {}
}

/**
 * Get user's real coin balance, daily bonus eligibility, and active streak
 */
async function getUserCoinBalance(userId, authUser = null) {
  try {
    const hasCol = await checkCoinsColumn();
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    const { todayStr } = getTodayAndYesterdayUTC();

    if (hasCol && profile) {
      const lastClaim = profile.last_daily_bonus ? String(profile.last_daily_bonus).split("T")[0] : null;
      const canClaimDaily = !lastClaim || lastClaim !== todayStr;
      const dailyStreak = computeEffectiveStreak(profile.daily_streak_count, lastClaim);
      const studyStreak = computeEffectiveStreak(profile.streak, profile.last_activity_date);
      const streak = Math.max(dailyStreak, studyStreak);

      let coins = profile.coins;
      if (coins === null || coins === undefined) {
        coins = 5;
        await supabase.from("profiles").update({ coins: 5 }).eq("id", userId);
      }

      return {
        coins: Number(coins),
        canClaimDaily,
        streak,
        dailyStreak,
        lastClaim,
        plan: (profile.plan || "free").toLowerCase(),
      };
    }

    // Fallback when profiles.coins column is not present: use Supabase Auth user_metadata
    const userObj = await getAuthUser(userId, authUser);
    const meta = userObj?.user_metadata || {};

    let coins = meta.coins;
    if (coins === undefined || coins === null) {
      coins = 5; // Real initial starter coins for account
      if (userObj) {
        await supabase.auth.admin.updateUserById(userId, {
          user_metadata: { ...meta, coins: 5 },
        }).catch(() => {});
      }
    }

    const lastClaim = meta.last_daily_bonus || null;
    const canClaimDaily = !lastClaim || lastClaim !== todayStr;
    const dailyStreak = computeEffectiveStreak(meta.daily_streak_count, lastClaim);
    const studyStreak = computeEffectiveStreak(profile?.streak, profile?.last_activity_date);
    const streak = Math.max(dailyStreak, studyStreak);

    return {
      coins: Number(coins),
      canClaimDaily,
      streak,
      dailyStreak,
      lastClaim,
      plan: (profile?.plan || "free").toLowerCase(),
    };
  } catch (err) {
    console.error("Error getting user coins:", err.message);
    return { coins: 0, canClaimDaily: true, streak: 0, dailyStreak: 0, lastClaim: null, plan: "free" };
  }
}

/**
 * Add coins to a user's wallet
 */
async function addCoins(userId, amount, actionType, description = "", authUser = null) {
  try {
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return { success: false, error: "Invalid coin amount." };
    }

    const hasCol = await checkCoinsColumn();
    if (hasCol) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("coins")
        .eq("id", userId)
        .maybeSingle();

      const currentCoins = Number(profile?.coins ?? 0);
      const newBalance = currentCoins + numAmount;

      const { error: updErr } = await supabase
        .from("profiles")
        .update({ coins: newBalance })
        .eq("id", userId);

      if (updErr) return { success: false, error: updErr.message };

      await recordCoinTransaction(userId, numAmount, actionType, description, newBalance);
      return { success: true, coins: newBalance };
    }

    // Fallback via Supabase Auth user_metadata
    const userObj = await getAuthUser(userId, authUser);
    if (!userObj) return { success: false, error: "User account not found." };

    const meta = userObj.user_metadata || {};
    const currentCoins = Number(meta.coins ?? 5);
    const newBalance = currentCoins + numAmount;

    const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { ...meta, coins: newBalance },
    });
    if (updErr) return { success: false, error: updErr.message };

    await recordCoinTransaction(userId, numAmount, actionType, description, newBalance);
    return { success: true, coins: newBalance };
  } catch (err) {
    console.error("Error adding coins:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Deduct coins from user's wallet
 */
async function deductCoins(userId, amount, actionType, description = "", authUser = null) {
  try {
    const numAmount = Number(amount);
    const hasCol = await checkCoinsColumn();

    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .select(hasCol ? "coins, role" : "role")
      .eq("id", userId)
      .maybeSingle();

    if (profErr || !profile) {
      return { success: false, error: "Profile not found." };
    }

    if (profile.role === "admin") {
      return { success: true, coins: 9999 };
    }

    if (hasCol) {
      const currentCoins = Number(profile.coins ?? 0);
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
      const { error: updErr } = await supabase
        .from("profiles")
        .update({ coins: newBalance })
        .eq("id", userId);

      if (updErr) return { success: false, error: updErr.message };

      await recordCoinTransaction(userId, -numAmount, actionType, description, newBalance);
      return { success: true, coins: newBalance };
    }

    // Fallback via Supabase Auth user_metadata
    const userObj = await getAuthUser(userId, authUser);
    if (!userObj) return { success: false, error: "User account not found." };

    const meta = userObj.user_metadata || {};
    const currentCoins = Number(meta.coins ?? 5);

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
    const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { ...meta, coins: newBalance },
    });
    if (updErr) return { success: false, error: updErr.message };

    await recordCoinTransaction(userId, -numAmount, actionType, description, newBalance);
    return { success: true, coins: newBalance };
  } catch (err) {
    console.error("Error deducting coins:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Claim Daily Login Reward (Gamification retention loop)
 */
async function claimDailyBonus(userId, authUser = null) {
  try {
    const hasCol = await checkCoinsColumn();
    const { todayStr, yesterdayStr } = getTodayAndYesterdayUTC();

    if (hasCol) {
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("coins, last_daily_bonus, daily_streak_count, streak, last_activity_date")
        .eq("id", userId)
        .single();

      if (error || !profile) return { success: false, error: "Profile not found." };

      const lastClaim = profile.last_daily_bonus ? String(profile.last_daily_bonus).split("T")[0] : null;
      if (lastClaim === todayStr) {
        return {
          success: false,
          alreadyClaimed: true,
          message: "You already claimed your daily bonus today! Check back tomorrow.",
        };
      }

      const prevStreak = computeEffectiveStreak(profile.daily_streak_count, lastClaim);
      const newStreak = lastClaim === yesterdayStr ? prevStreak + 1 : 1;

      const baseReward = 3;
      const streakBonus = Math.min(Math.floor((newStreak - 1) / 2), 2);
      const totalCoinsAwarded = baseReward + streakBonus;

      const currentCoins = Number(profile.coins ?? 0);
      const newBalance = currentCoins + totalCoinsAwarded;

      const { error: updateErr } = await supabase
        .from("profiles")
        .update({
          coins: newBalance,
          last_daily_bonus: todayStr,
          daily_streak_count: newStreak,
          streak: Math.max(Number(profile.streak || 0), newStreak),
          last_activity_date: todayStr,
        })
        .eq("id", userId);

      if (updateErr) {
        return { success: false, error: "Failed to update wallet balance." };
      }

      await recordCoinTransaction(
        userId,
        totalCoinsAwarded,
        "daily_bonus",
        `Claimed Day ${newStreak} Daily Study Reward (+${totalCoinsAwarded} coins)`,
        newBalance
      );

      return {
        success: true,
        coinsAwarded: totalCoinsAwarded,
        newBalance,
        coins: newBalance,
        streak: newStreak,
        message: `+${totalCoinsAwarded} CampusCoins added! (Streak: Day ${newStreak})`,
      };
    }

    // Fallback via Supabase Auth user_metadata + profiles streak sync
    const userObj = await getAuthUser(userId, authUser);
    if (!userObj) return { success: false, error: "User account not found." };

    const meta = userObj.user_metadata || {};
    const lastClaim = meta.last_daily_bonus ? String(meta.last_daily_bonus).split("T")[0] : null;

    if (lastClaim === todayStr) {
      return {
        success: false,
        alreadyClaimed: true,
        message: "You already claimed your daily bonus today! Check back tomorrow.",
      };
    }

    const prevStreak = computeEffectiveStreak(meta.daily_streak_count, lastClaim);
    const newStreak = lastClaim === yesterdayStr ? prevStreak + 1 : 1;

    const baseReward = 3;
    const streakBonus = Math.min(Math.floor((newStreak - 1) / 2), 2);
    const totalCoinsAwarded = baseReward + streakBonus;

    const currentCoins = Number(meta.coins ?? 5);
    const newBalance = currentCoins + totalCoinsAwarded;

    const { error: authUpdErr } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...meta,
        coins: newBalance,
        last_daily_bonus: todayStr,
        daily_streak_count: newStreak,
      },
    });

    if (authUpdErr) {
      return { success: false, error: "Failed to update wallet balance." };
    }

    // Also sync profiles.streak and profiles.last_activity_date
    await supabase
      .from("profiles")
      .update({
        streak: newStreak,
        last_activity_date: todayStr,
      })
      .eq("id", userId)
      .catch(() => {});

    await recordCoinTransaction(
      userId,
      totalCoinsAwarded,
      "daily_bonus",
      `Claimed Day ${newStreak} Daily Study Reward (+${totalCoinsAwarded} coins)`,
      newBalance
    );

    return {
      success: true,
      coinsAwarded: totalCoinsAwarded,
      newBalance,
      coins: newBalance,
      streak: newStreak,
      message: `+${totalCoinsAwarded} CampusCoins added! (Streak: Day ${newStreak})`,
    };
  } catch (err) {
    console.error("Daily bonus error:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get real coin transaction history for user
 */
async function getCoinHistory(userId) {
  try {
    const { data: logs, error } = await supabase
      .from("coin_transactions")
      .select("amount, action_type, description, balance_after, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(25);

    if (!error && Array.isArray(logs)) {
      return logs;
    }
  } catch (_) {}

  // Fallback: read coin events from user_activity
  try {
    const { data: acts, error } = await supabase
      .from("user_activity")
      .select("action, details, created_at")
      .eq("user_id", userId)
      .in("action", ["coin_credit", "coin_spend", "daily_bonus"])
      .order("created_at", { ascending: false })
      .limit(25);

    if (error || !acts) return [];
    return acts.map((a) => {
      try {
        const parsed = JSON.parse(a.details || "{}");
        return {
          amount: parsed.amount ?? 0,
          action_type: parsed.action_type || a.action,
          description: parsed.description || a.details,
          balance_after: parsed.balance_after ?? null,
          created_at: a.created_at,
        };
      } catch (_) {
        return {
          amount: 0,
          action_type: a.action,
          description: a.details,
          balance_after: null,
          created_at: a.created_at,
        };
      }
    });
  } catch (_) {
    return [];
  }
}

module.exports = {
  getUserCoinBalance,
  addCoins,
  deductCoins,
  claimDailyBonus,
  getCoinHistory,
  computeEffectiveStreak,
  checkCoinsColumn,
};
