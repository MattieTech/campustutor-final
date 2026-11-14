// ============================================================
// utils/coins.js — CampusCoins Economy, Locking & Audit Ledger
// ============================================================

const supabase = require("./supabase");
const { withUserLock } = require("./usageService");

let _hasCoinsColumn = null;
let _hasCoinTxTable = null;

async function checkCoinsColumn() {
  if (_hasCoinsColumn !== null) return _hasCoinsColumn;
  try {
    const { error } = await supabase.from("profiles").select("coins").limit(1);
    _hasCoinsColumn = !(
      error &&
      (error.code === "42703" || (error.message || "").includes("does not exist"))
    );
  } catch (_) {
    _hasCoinsColumn = false;
  }
  return _hasCoinsColumn;
}

async function checkCoinTransactionsTable() {
  if (_hasCoinTxTable !== null) return _hasCoinTxTable;
  try {
    const { error } = await supabase.from("coin_transactions").select("id").limit(1);
    _hasCoinTxTable = !(
      error &&
      (error.code === "PGRST205" || (error.message || "").includes("does not exist") || (error.message || "").includes("schema cache"))
    );
  } catch (_) {
    _hasCoinTxTable = false;
  }
  return _hasCoinTxTable;
}

function getTodayAndYesterdayUTC() {
  const todayObj = new Date();
  const todayStr = todayObj.toISOString().split("T")[0];
  const yestObj = new Date(todayObj);
  yestObj.setUTCDate(yestObj.getUTCDate() - 1);
  const yesterdayStr = yestObj.toISOString().split("T")[0];
  return { todayStr, yesterdayStr };
}

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
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (!error && data?.user) return data.user;
  } catch (_) {}
  if (authUser && authUser.id === userId) return authUser;
  return null;
}

async function recordCoinTransaction(
  userId,
  amount,
  actionType,
  description,
  balanceAfter,
  meta = {}
) {
  const now = new Date().toISOString();
  const txType = meta.transactionType || actionType;
  const reason = meta.reason || description || `${actionType} (${amount >= 0 ? "+" : ""}${amount} coins)`;
  const adminId = meta.adminId || null;

  const hasTxTable = await checkCoinTransactionsTable();
  if (hasTxTable) {
    try {
      const { error } = await supabase.from("coin_transactions").insert({
        user_id: userId,
        amount: Number(amount),
        action_type: actionType,
        transaction_type: txType,
        description: description || reason,
        reason,
        admin_id: adminId,
        balance_after: balanceAfter,
        created_at: now,
      });
      if (!error) return;
    } catch (_) {}
  }

  // Persistent fallback in user_activity when coin_transactions table isn't migrated
  try {
    const actionLabel = Number(amount) >= 0 ? "coin_credit" : "coin_spend";
    await supabase.from("user_activity").insert({
      user_id: userId,
      action: actionLabel,
      details: JSON.stringify({
        amount: Number(amount),
        action_type: actionType,
        transaction_type: txType,
        description: description || reason,
        reason,
        admin_id: adminId,
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
    const { data: profile } = await supabase
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

    const userObj = await getAuthUser(userId, authUser);
    const meta = userObj?.user_metadata || {};

    let coins = meta.coins;
    if (coins === undefined || coins === null) {
      coins = 5;
      if (userObj) {
        await supabase.auth.admin
          .updateUserById(userId, { user_metadata: { ...meta, coins: 5 } })
          .catch(() => {});
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
 * Internal locked balance mutation (used by addCoins, deductCoins, adminAdjustCoins)
 */
async function mutateCoinsLocked(userId, delta, actionType, description, meta = {}, authUser = null) {
  const numDelta = Math.trunc(Number(delta));
  if (!Number.isFinite(numDelta) || numDelta === 0) {
    return { success: false, error: "Invalid coin amount." };
  }

  return withUserLock(userId, async () => {
    const hasCol = await checkCoinsColumn();
    const hasTx = await checkCoinTransactionsTable();

    // Try atomic SQL RPC first if both column and table exist
    if (hasCol && hasTx) {
      try {
        const { data: rpcRes, error: rpcErr } = await supabase.rpc("adjust_user_coins", {
          p_user_id: userId,
          p_delta: numDelta,
          p_action_type: actionType,
          p_transaction_type: meta.transactionType || actionType,
          p_description: description || "",
          p_reason: meta.reason || description || null,
          p_admin_id: meta.adminId || null,
        });
        if (!rpcErr && Array.isArray(rpcRes) && rpcRes[0]) {
          const row = rpcRes[0];
          if (!row.success) {
            return {
              success: false,
              insufficient: numDelta < 0,
              error: row.error_msg || "Coin transaction failed.",
              currentCoins: Number(row.new_balance ?? 0),
            };
          }
          return { success: true, coins: Number(row.new_balance) };
        }
      } catch (_) {}
    }

    if (hasCol) {
      const { data: profile, error: profErr } = await supabase
        .from("profiles")
        .select("coins, role")
        .eq("id", userId)
        .maybeSingle();

      if (profErr || !profile) {
        return { success: false, error: "Profile not found." };
      }

      if (numDelta < 0 && profile.role === "admin" && !meta.forceAdminMutation) {
        return { success: true, coins: Number(profile.coins ?? 9999) };
      }

      const currentCoins = Number(profile.coins ?? 0);
      const newBalance = currentCoins + numDelta;
      if (newBalance < 0) {
        return {
          success: false,
          insufficient: true,
          currentCoins,
          needed: Math.abs(numDelta),
          error: `Insufficient coins. You have ${currentCoins} coins, but ${Math.abs(numDelta)} coins are required.`,
        };
      }

      // Conditional update for optimistic concurrency safety
      const { data: updatedRows, error: updErr } = await supabase
        .from("profiles")
        .update({ coins: newBalance })
        .eq("id", userId)
        .eq("coins", profile.coins)
        .select("coins");

      if (updErr) {
        return { success: false, error: updErr.message };
      }
      if (!updatedRows || updatedRows.length === 0) {
        return { success: false, error: "Concurrent balance modification detected. Please retry." };
      }

      await recordCoinTransaction(userId, numDelta, actionType, description, newBalance, meta);
      return { success: true, coins: newBalance, previousCoins: currentCoins };
    }

    // Fallback via Supabase Auth user_metadata (always fresh fetch inside lock!)
    const userObj = await getAuthUser(userId, null);
    if (!userObj) return { success: false, error: "User account not found." };

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .maybeSingle();

    if (numDelta < 0 && profile?.role === "admin" && !meta.forceAdminMutation) {
      return { success: true, coins: Number(userObj.user_metadata?.coins ?? 9999) };
    }

    const userMeta = userObj.user_metadata || {};
    const currentCoins = Number(userMeta.coins ?? 5);
    const newBalance = currentCoins + numDelta;

    if (newBalance < 0) {
      return {
        success: false,
        insufficient: true,
        currentCoins,
        needed: Math.abs(numDelta),
        error: `Insufficient coins. You have ${currentCoins} coins, but ${Math.abs(numDelta)} coins are required.`,
      };
    }

    const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { ...userMeta, coins: newBalance },
    });
    if (updErr) return { success: false, error: updErr.message };

    await recordCoinTransaction(userId, numDelta, actionType, description, newBalance, meta);
    return { success: true, coins: newBalance, previousCoins: currentCoins };
  });
}

async function addCoins(userId, amount, actionType, description = "", authUser = null, meta = {}) {
  const numAmount = Math.trunc(Number(amount));
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return { success: false, error: "Invalid coin amount." };
  }
  return mutateCoinsLocked(userId, numAmount, actionType, description, {
    transactionType: meta.transactionType || actionType,
    ...meta,
  }, authUser);
}

async function deductCoins(userId, amount, actionType, description = "", authUser = null, meta = {}) {
  const numAmount = Math.trunc(Number(amount));
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return { success: false, error: "Invalid coin deduction amount." };
  }
  return mutateCoinsLocked(userId, -numAmount, actionType, description, {
    transactionType: meta.transactionType || "tool_spend",
    ...meta,
  }, authUser);
}

async function adminAdjustCoins({ userId, amount, action, reason, adminId }) {
  const numAmount = Math.trunc(Number(amount));
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return { success: false, error: "Coin amount must be a positive integer." };
  }
  if (!["credit", "deduct"].includes(action)) {
    return { success: false, error: "Action must be 'credit' or 'deduct'." };
  }
  if (!reason || !String(reason).trim()) {
    return { success: false, error: "A reason/description is required for manual coin adjustments." };
  }

  const cleanReason = String(reason).trim();
  const delta = action === "credit" ? numAmount : -numAmount;
  const txType = action === "credit" ? "admin_credit" : "admin_deduct";
  const desc = `Admin ${action}: ${cleanReason}`;

  return mutateCoinsLocked(userId, delta, txType, desc, {
    transactionType: txType,
    reason: cleanReason,
    adminId,
    forceAdminMutation: true,
  });
}

async function claimDailyBonus(userId, authUser = null) {
  return withUserLock(userId, async () => {
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
          newBalance,
          { transactionType: "daily_bonus" }
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

      const userObj = await getAuthUser(userId, null);
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

      try {
        await supabase
          .from("profiles")
          .update({ streak: newStreak, last_activity_date: todayStr })
          .eq("id", userId);
      } catch (_) {}

      await recordCoinTransaction(
        userId,
        totalCoinsAwarded,
        "daily_bonus",
        `Claimed Day ${newStreak} Daily Study Reward (+${totalCoinsAwarded} coins)`,
        newBalance,
        { transactionType: "daily_bonus" }
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
  });
}

async function getCoinHistory(userId, limit = 50) {
  const hasTx = await checkCoinTransactionsTable();
  if (hasTx) {
    try {
      const { data: logs, error } = await supabase
        .from("coin_transactions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!error && Array.isArray(logs)) {
        return logs;
      }
    } catch (_) {}
  }

  try {
    const { data: acts, error } = await supabase
      .from("user_activity")
      .select("action, details, created_at")
      .eq("user_id", userId)
      .in("action", ["coin_credit", "coin_spend", "daily_bonus"])
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !acts) return [];
    return acts.map((a) => {
      try {
        const parsed = JSON.parse(a.details || "{}");
        return {
          user_id: userId,
          amount: Number(parsed.amount ?? 0),
          action_type: parsed.action_type || a.action,
          transaction_type: parsed.transaction_type || parsed.action_type || a.action,
          description: parsed.description || a.details,
          reason: parsed.reason || parsed.description || a.details,
          admin_id: parsed.admin_id || null,
          balance_after: parsed.balance_after ?? null,
          created_at: a.created_at,
        };
      } catch (_) {
        return {
          user_id: userId,
          amount: 0,
          action_type: a.action,
          transaction_type: a.action,
          description: a.details,
          reason: a.details,
          admin_id: null,
          balance_after: null,
          created_at: a.created_at,
        };
      }
    });
  } catch (_) {
    return [];
  }
}

async function getAllCoinTransactions(limit = 100) {
  const hasTx = await checkCoinTransactionsTable();
  if (hasTx) {
    try {
      const { data: logs, error } = await supabase
        .from("coin_transactions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (!error && Array.isArray(logs)) return logs;
    } catch (_) {}
  }

  try {
    const { data: acts, error } = await supabase
      .from("user_activity")
      .select("user_id, action, details, created_at")
      .in("action", ["coin_credit", "coin_spend", "daily_bonus"])
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !acts) return [];
    return acts.map((a) => {
      try {
        const parsed = JSON.parse(a.details || "{}");
        return {
          user_id: a.user_id,
          amount: Number(parsed.amount ?? 0),
          action_type: parsed.action_type || a.action,
          transaction_type: parsed.transaction_type || parsed.action_type || a.action,
          description: parsed.description || a.details,
          reason: parsed.reason || parsed.description || a.details,
          admin_id: parsed.admin_id || null,
          balance_after: parsed.balance_after ?? null,
          created_at: a.created_at,
        };
      } catch (_) {
        return {
          user_id: a.user_id,
          amount: 0,
          action_type: a.action,
          transaction_type: a.action,
          description: a.details,
          reason: a.details,
          admin_id: null,
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
  adminAdjustCoins,
  claimDailyBonus,
  getCoinHistory,
  getAllCoinTransactions,
  computeEffectiveStreak,
  checkCoinsColumn,
};
