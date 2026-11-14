// ============================================================
// utils/usageService.js — Subscription Resolution & Tool Usage Limits
// ============================================================

const supabase = require("./supabase");
const { getAllToolsConfig, getToolConfig } = require("./toolConfig");

let _hasToolUsageTable = null;
const _userLocks = new Map();

/**
 * Per-user async mutex to prevent race conditions on usage checks & coin ops.
 */
async function withUserLock(userId, fn) {
  const key = String(userId || "anon");
  const prev = _userLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  _userLocks.set(key, prev.then(() => next));

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (_userLocks.get(key) === next) {
      _userLocks.delete(key);
    }
  }
}

function getPeriodKeys(now = new Date()) {
  const iso = now.toISOString();
  const dailyKey = iso.slice(0, 10); // YYYY-MM-DD (UTC)
  const monthlyKey = iso.slice(0, 7); // YYYY-MM (UTC)

  const nextDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

  return {
    dailyKey,
    monthlyKey,
    resetsAtDaily: nextDay.toISOString(),
    resetsAtMonthly: nextMonth.toISOString(),
    startOfDayISO: `${dailyKey}T00:00:00.000Z`,
    startOfMonthISO: `${monthlyKey}-01T00:00:00.000Z`,
  };
}

async function checkToolUsageTable() {
  if (_hasToolUsageTable !== null) return _hasToolUsageTable;
  try {
    const { error } = await supabase.from("tool_usage").select("id").limit(1);
    _hasToolUsageTable = !(
      error &&
      (error.code === "PGRST205" || (error.message || "").includes("does not exist") || (error.message || "").includes("schema cache"))
    );
  } catch (_) {
    _hasToolUsageTable = false;
  }
  return _hasToolUsageTable;
}

/**
 * Resolve a user's effective subscription plan, auto-reverting expired plans to 'free'.
 */
async function resolveEffectiveSubscription(userId, profile = null) {
  let prof = profile;
  if (!prof && userId) {
    const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    prof = data;
  }
  if (!prof) {
    return {
      plan: "free",
      status: "inactive",
      subscriptionEnd: null,
      subscriptionSource: "free",
      expiredNow: false,
      profile: null,
    };
  }

  let plan = String(prof.plan || "free").toLowerCase();
  if (!["free", "plus", "pro"].includes(plan)) plan = "free";

  let status = String(prof.subscription_status || (plan === "free" ? "inactive" : "active")).toLowerCase();
  const subEnd = prof.subscription_end ? new Date(prof.subscription_end) : null;
  const isExpired = Boolean(subEnd && !Number.isNaN(subEnd.getTime()) && subEnd.getTime() <= Date.now());
  let expiredNow = false;

  if (plan !== "free" && (isExpired || status === "expired" || status === "revoked")) {
    const nextStatus = status === "revoked" ? "revoked" : "expired";
    if (prof.plan !== "free" || prof.subscription_status !== nextStatus) {
      expiredNow = true;
      try {
        await supabase
          .from("profiles")
          .update({ plan: "free", subscription_status: nextStatus })
          .eq("id", userId);
      } catch (_) {}
      prof.plan = "free";
      prof.subscription_status = nextStatus;
    }
    plan = "free";
    status = nextStatus;
  }

  if (plan !== "free" && status !== "active") {
    // Inactive non-free plan should not grant paid privileges
    plan = "free";
  }

  return {
    plan,
    status,
    subscriptionEnd: prof.subscription_end || null,
    subscriptionSource: prof.subscription_source || (plan === "free" ? "free" : "paystack"),
    expiredNow,
    profile: prof,
  };
}

// Map tool keys to legacy user_activity actions so existing history also counts fairly
const LEGACY_ACTIVITY_MAP = {
  explain: ["ai_explain"],
  summarize: ["ai_summarize"],
  questions: ["ai_questions"],
  flashcards: ["ai_flashcards"],
  solve_problem: ["solve_problem"],
  polish_essay: ["polish_essay"],
  project_proposals: ["project_proposals"],
  viva_defense: ["viva_defense"],
  exam_predict: ["exam_predict"],
  humanize_rewrite: ["humanize_rewrite"],
};

async function getAllToolUsageCountsForUser(userId) {
  const { dailyKey, monthlyKey, startOfDayISO, startOfMonthISO } = getPeriodKeys();
  const counts = {};

  const ensureKey = (k) => {
    if (!counts[k]) counts[k] = { daily: 0, monthly: 0 };
    return counts[k];
  };

  const hasTable = await checkToolUsageTable();
  if (hasTable) {
    const { data: rows, error } = await supabase
      .from("tool_usage")
      .select("tool_key, period_type, period_key, usage_count")
      .eq("user_id", userId)
      .in("period_key", [dailyKey, monthlyKey]);

    if (!error && Array.isArray(rows)) {
      rows.forEach((r) => {
        const entry = ensureKey(r.tool_key);
        if (r.period_type === "daily" && r.period_key === dailyKey) {
          entry.daily = Number(r.usage_count || 0);
        } else if (r.period_type === "monthly" && r.period_key === monthlyKey) {
          entry.monthly = Number(r.usage_count || 0);
        }
      });
    }
  } else {
    // Fallback: compute from user_activity (current month) + documents (for uploads)
    const { data: acts } = await supabase
      .from("user_activity")
      .select("action, details, created_at")
      .eq("user_id", userId)
      .gte("created_at", startOfMonthISO)
      .order("created_at", { ascending: false })
      .limit(1000);

    (acts || []).forEach((a) => {
      const ts = String(a.created_at || "");
      const isToday = ts >= startOfDayISO || ts.startsWith(dailyKey);
      let toolKey = null;

      if (a.action === "tool_usage") {
        try {
          const parsed = JSON.parse(a.details || "{}");
          toolKey = parsed.toolKey || null;
        } catch (_) {}
      } else {
        for (const [k, actions] of Object.entries(LEGACY_ACTIVITY_MAP)) {
          if (actions.includes(a.action)) {
            toolKey = k;
            break;
          }
        }
      }

      if (toolKey) {
        const entry = ensureKey(toolKey);
        entry.monthly += 1;
        if (isToday) entry.daily += 1;
      }
    });
  }

  // Always reconcile upload counts directly with real documents table for accuracy
  const { data: docs } = await supabase
    .from("documents")
    .select("file_type, created_at")
    .eq("user_id", userId)
    .gte("created_at", startOfMonthISO);

  if (Array.isArray(docs)) {
    let pdfDaily = 0;
    let pdfMonthly = 0;
    let imgDaily = 0;
    let imgMonthly = 0;

    docs.forEach((d) => {
      const isToday = String(d.created_at || "") >= startOfDayISO || String(d.created_at || "").startsWith(dailyKey);
      if (d.file_type === "image") {
        imgMonthly += 1;
        if (isToday) imgDaily += 1;
      } else {
        pdfMonthly += 1;
        if (isToday) pdfDaily += 1;
      }
    });

    const pdfEntry = ensureKey("upload_pdf");
    pdfEntry.daily = Math.max(pdfEntry.daily, pdfDaily);
    pdfEntry.monthly = Math.max(pdfEntry.monthly, pdfMonthly);

    const imgEntry = ensureKey("upload_image");
    imgEntry.daily = Math.max(imgEntry.daily, imgDaily);
    imgEntry.monthly = Math.max(imgEntry.monthly, imgMonthly);
  }

  return counts;
}

async function recordToolUsage(userId, toolKey) {
  if (!userId || !toolKey) return;
  const { dailyKey, monthlyKey } = getPeriodKeys();
  const hasTable = await checkToolUsageTable();

  if (hasTable) {
    try {
      const { error } = await supabase.rpc("increment_tool_usage", {
        p_user_id: userId,
        p_tool_key: toolKey,
        p_daily_key: dailyKey,
        p_monthly_key: monthlyKey,
      });
      if (!error) return;
    } catch (_) {}

    // Direct upsert fallback if RPC isn't installed
    for (const [periodType, periodKey] of [
      ["daily", dailyKey],
      ["monthly", monthlyKey],
    ]) {
      const { data: existing } = await supabase
        .from("tool_usage")
        .select("id, usage_count")
        .eq("user_id", userId)
        .eq("tool_key", toolKey)
        .eq("period_type", periodType)
        .eq("period_key", periodKey)
        .maybeSingle();

      if (existing) {
        await supabase
          .from("tool_usage")
          .update({ usage_count: Number(existing.usage_count || 0) + 1, updated_at: new Date().toISOString() })
          .eq("id", existing.id);
      } else {
        await supabase.from("tool_usage").insert({
          user_id: userId,
          tool_key: toolKey,
          period_type: periodType,
          period_key: periodKey,
          usage_count: 1,
          updated_at: new Date().toISOString(),
        });
      }
    }
    return;
  }

  // Fallback when tool_usage table isn't migrated yet:
  // Only insert a dedicated tool_usage event for tools that don't already log their own action in user_activity
  // (or always log tool_usage cleanly and avoid double-counting by only logging when needed).
  if (!LEGACY_ACTIVITY_MAP[toolKey] && !["upload_pdf", "upload_image"].includes(toolKey)) {
    try {
      await supabase
        .from("user_activity")
        .insert({
          user_id: userId,
          action: "tool_usage",
          details: JSON.stringify({ toolKey, dailyKey, monthlyKey }),
          created_at: new Date().toISOString(),
        });
    } catch (_) {}
  }
}

/**
 * Evaluate whether a user is allowed to run a tool right now.
 * Returns: { allowed: boolean, statusCode?: number, errorPayload?: object, chargeCoins: number, cfg, plan, usage }
 */
async function evaluateToolAccess({ userId, plan, coins, isAdmin = false, toolKey, useCoins = false }) {
  const cfg = await getToolConfig(toolKey);
  if (!cfg) {
    return { allowed: true, chargeCoins: 0, cfg: null, plan, usage: { daily: 0, monthly: 0 } };
  }

  if (isAdmin) {
    return { allowed: true, chargeCoins: 0, cfg, plan: "pro", usage: { daily: 0, monthly: 0 } };
  }

  if (!cfg.enabled) {
    return {
      allowed: false,
      statusCode: 503,
      errorPayload: {
        error: `${cfg.name} is temporarily disabled by the administrator.`,
        toolDisabled: true,
        toolKey,
      },
      chargeCoins: 0,
      cfg,
      plan,
    };
  }

  const normalizedPlan = ["free", "plus", "pro"].includes(plan) ? plan : "free";
  const allCounts = await getAllToolUsageCountsForUser(userId);
  const usage = allCounts[toolKey] || { daily: 0, monthly: 0 };
  const { resetsAtDaily, resetsAtMonthly } = getPeriodKeys();

  const dailyLimit = Number(cfg.dailyLimit?.[normalizedPlan] ?? 0);
  const monthlyLimit = Number(cfg.monthlyLimit?.[normalizedPlan] ?? 0);
  const planAllowed = Array.isArray(cfg.allowedPlans) ? cfg.allowedPlans.includes(normalizedPlan) : true;
  const recommendedUpgrade = normalizedPlan === "free" ? (cfg.allowedPlans.includes("plus") ? "plus" : "pro") : "pro";

  // Case 1: Plan is explicitly not allowed for this tool (e.g., upload_image is Pro-only)
  if (!planAllowed) {
    if (cfg.allowCoinsBypass && cfg.coinCost > 0) {
      if (coins >= cfg.coinCost) {
        return { allowed: true, chargeCoins: cfg.coinCost, cfg, plan: normalizedPlan, usage };
      }
      return {
        allowed: false,
        statusCode: 403,
        errorPayload: {
          error: `${cfg.name} requires ${recommendedUpgrade.toUpperCase()} Plan or ${cfg.coinCost} CampusCoins.`,
          planRestricted: true,
          subscriptionRequired: true,
          insufficientCoins: true,
          needCoins: true,
          needed: cfg.coinCost,
          currentCoins: coins,
          toolKey,
          recommendedUpgrade,
        },
        chargeCoins: 0,
        cfg,
        plan: normalizedPlan,
        usage,
      };
    }

    return {
      allowed: false,
      statusCode: 403,
      errorPayload: {
        error: `${cfg.name} is exclusive to ${cfg.allowedPlans.map((p) => p.toUpperCase()).join(" / ")} subscribers. Upgrade to ${recommendedUpgrade.toUpperCase()} to unlock it.`,
        planRestricted: true,
        subscriptionRequired: true,
        toolKey,
        plan: normalizedPlan,
        recommendedUpgrade,
      },
      chargeCoins: 0,
      cfg,
      plan: normalizedPlan,
      usage,
    };
  }

  // Case 2: Plan allowance is 0 (pay-as-you-go coin tool on Free, or 0 quota configured)
  if (dailyLimit === 0 || monthlyLimit === 0) {
    if (cfg.allowCoinsBypass && cfg.coinCost > 0) {
      if (coins >= cfg.coinCost) {
        return { allowed: true, chargeCoins: cfg.coinCost, cfg, plan: normalizedPlan, usage };
      }
      return {
        allowed: false,
        statusCode: 403,
        errorPayload: {
          error: `${cfg.name} costs ${cfg.coinCost} CampusCoins (you have ${coins}). Top up coins or upgrade to ${recommendedUpgrade.toUpperCase()}!`,
          insufficientCoins: true,
          needCoins: true,
          needed: cfg.coinCost,
          currentCoins: coins,
          toolKey,
          plan: normalizedPlan,
          recommendedUpgrade,
        },
        chargeCoins: 0,
        cfg,
        plan: normalizedPlan,
        usage,
      };
    }

    return {
      allowed: false,
      statusCode: 403,
      errorPayload: {
        error: `${cfg.name} is not included in the ${normalizedPlan.toUpperCase()} plan. Upgrade to ${recommendedUpgrade.toUpperCase()} to continue.`,
        limitReached: true,
        subscriptionRequired: true,
        toolKey,
        plan: normalizedPlan,
        recommendedUpgrade,
      },
      chargeCoins: 0,
      cfg,
      plan: normalizedPlan,
      usage,
    };
  }

  // Case 3: Check daily limit (-1 = unlimited)
  const dailyExceeded = dailyLimit > 0 && usage.daily >= dailyLimit;
  const monthlyExceeded = monthlyLimit > 0 && usage.monthly >= monthlyLimit;

  if (dailyExceeded || monthlyExceeded) {
    const period = dailyExceeded ? "daily" : "monthly";
    const limit = dailyExceeded ? dailyLimit : monthlyLimit;
    const used = dailyExceeded ? usage.daily : usage.monthly;
    const resetsAt = dailyExceeded ? resetsAtDaily : resetsAtMonthly;

    // If tool supports coins bypass AND user explicitly opted to use coins after hitting plan quota
    if (cfg.allowCoinsBypass && cfg.coinCost > 0 && useCoins) {
      if (coins >= cfg.coinCost) {
        return { allowed: true, chargeCoins: cfg.coinCost, cfg, plan: normalizedPlan, usage };
      }
      return {
        allowed: false,
        statusCode: 403,
        errorPayload: {
          error: `${period === "daily" ? "Daily" : "Monthly"} limit reached (${used}/${limit}) and insufficient CampusCoins (${coins}/${cfg.coinCost}).`,
          limitReached: true,
          insufficientCoins: true,
          needCoins: true,
          needed: cfg.coinCost,
          currentCoins: coins,
          toolKey,
          period,
          used,
          limit,
          resetsAt,
          recommendedUpgrade,
        },
        chargeCoins: 0,
        cfg,
        plan: normalizedPlan,
        usage,
      };
    }

    const resetHuman = new Date(resetsAt).toUTCString().replace("GMT", "UTC");
    const upgradeHint = normalizedPlan === "pro" ? "" : ` Upgrade to ${recommendedUpgrade.toUpperCase()} for higher allowances.`;
    const coinHint =
      cfg.allowCoinsBypass && cfg.coinCost > 0
        ? ` You can also continue using ${cfg.coinCost} CampusCoins.`
        : "";

    return {
      allowed: false,
      statusCode: 429,
      errorPayload: {
        error: `You have reached your ${period} limit for ${cfg.name} (${used}/${limit} used). Resets at ${resetHuman}.${upgradeHint}${coinHint}`,
        limitReached: true,
        toolKey,
        toolName: cfg.name,
        plan: normalizedPlan,
        period,
        used,
        limit,
        resetsAt,
        recommendedUpgrade: normalizedPlan === "pro" ? null : recommendedUpgrade,
        canUseCoins: Boolean(cfg.allowCoinsBypass && cfg.coinCost > 0),
        coinCost: cfg.coinCost,
        currentCoins: coins,
      },
      chargeCoins: 0,
      cfg,
      plan: normalizedPlan,
      usage,
    };
  }

  return { allowed: true, chargeCoins: 0, cfg, plan: normalizedPlan, usage };
}

/**
 * Build complete per-tool usage & allowance summary for a user.
 */
async function getUserUsageSummary(userId, plan, isAdmin = false) {
  const effectivePlan = isAdmin ? "pro" : ["free", "plus", "pro"].includes(plan) ? plan : "free";
  const allConfigs = await getAllToolsConfig();
  const counts = await getAllToolUsageCountsForUser(userId);
  const { dailyKey, monthlyKey, resetsAtDaily, resetsAtMonthly } = getPeriodKeys();

  const tools = Object.values(allConfigs).map((cfg) => {
    const u = counts[cfg.toolKey] || { daily: 0, monthly: 0 };
    const dailyLimit = isAdmin ? -1 : Number(cfg.dailyLimit?.[effectivePlan] ?? 0);
    const monthlyLimit = isAdmin ? -1 : Number(cfg.monthlyLimit?.[effectivePlan] ?? 0);
    const planAllowed = isAdmin || (Array.isArray(cfg.allowedPlans) ? cfg.allowedPlans.includes(effectivePlan) : true);

    return {
      toolKey: cfg.toolKey,
      name: cfg.name,
      category: cfg.category,
      enabled: cfg.enabled,
      planAllowed,
      coinCost: cfg.coinCost,
      allowCoinsBypass: cfg.allowCoinsBypass,
      usedToday: u.daily,
      dailyLimit,
      remainingDaily: dailyLimit < 0 ? -1 : Math.max(0, dailyLimit - u.daily),
      usedThisMonth: u.monthly,
      monthlyLimit,
      remainingMonthly: monthlyLimit < 0 ? -1 : Math.max(0, monthlyLimit - u.monthly),
      extraConfig: cfg.extraConfig || {},
    };
  });

  return {
    plan: effectivePlan,
    dailyKey,
    monthlyKey,
    resetsAtDaily,
    resetsAtMonthly,
    tools,
  };
}

module.exports = {
  withUserLock,
  getPeriodKeys,
  resolveEffectiveSubscription,
  getAllToolUsageCountsForUser,
  recordToolUsage,
  evaluateToolAccess,
  getUserUsageSummary,
};
