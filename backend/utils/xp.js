// ============================================================
// utils/xp.js — XP, Streaks, Achievements & Real Progress Analytics
// ============================================================

const supabase = require("./supabase");
const { getUserCoinBalance, computeEffectiveStreak } = require("./coins");

// XP Values for activities
const XP_AMOUNTS = {
  upload_pdf: 25,
  upload_image: 20,
  ai_summarize: 30,
  ai_explain: 25,
  ai_questions: 35,
  ai_flashcards: 40,
  solve_problem: 20,
  polish_essay: 25,
  project_proposals: 30,
  viva_defense: 35,
  exam_predict: 35,
  humanize_rewrite: 25,
  download_content: 10,
  first_upload: 50,
  first_ai: 50,
  level_up: 100,
};

// Achievement definitions (FontAwesome classes — no emojis)
const ACHIEVEMENTS = [
  {
    key: "first_upload",
    name: "First Upload",
    icon: "fa-solid fa-rocket",
    description: "Upload your first document",
    requirement: (stats) => stats.documents_uploaded >= 1,
  },
  {
    key: "first_summary",
    name: "Summarizer",
    icon: "fa-solid fa-list-check",
    description: "Generate your first summary",
    requirement: (stats) => stats.summaries_generated >= 1,
  },
  {
    key: "first_flashcards",
    name: "Flashmaster",
    icon: "fa-solid fa-id-card",
    description: "Create your first flashcard set",
    requirement: (stats) => stats.flashcards_generated >= 1,
  },
  {
    key: "streak_3",
    name: "3-Day Streak",
    icon: "fa-solid fa-fire",
    description: "Study 3 days in a row",
    requirement: (stats) => stats.streak >= 3,
  },
  {
    key: "first_quiz",
    name: "Quiz Ace",
    icon: "fa-solid fa-pen-to-square",
    description: "Generate your first quiz",
    requirement: (stats) => stats.questions_generated >= 1,
  },
  {
    key: "level_5",
    name: "Level 5 Scholar",
    icon: "fa-solid fa-star",
    description: "Reach Level 5",
    requirement: (stats) => stats.level >= 5,
  },
  {
    key: "power_user",
    name: "Power User",
    icon: "fa-solid fa-bolt",
    description: "Earn 1000 XP",
    requirement: (stats) => stats.xp >= 1000,
  },
  {
    key: "documents_5",
    name: "Document Collector",
    icon: "fa-solid fa-book",
    description: "Upload 5 documents",
    requirement: (stats) => stats.documents_uploaded >= 5,
  },
];

// Progressive Leveling Thresholds
const LEVEL_THRESHOLDS = [0, 100, 350, 750, 1350, 2150, 3150, 4350, 5850, 7850];

let _hasAwardedXpTable = null;

async function checkAwardedXpTable() {
  if (_hasAwardedXpTable !== null) return _hasAwardedXpTable;
  try {
    const { error } = await supabase.from("awarded_xp").select("id").limit(1);
    _hasAwardedXpTable = !(error && (error.code === "PGRST205" || (error.message || "").includes("does not exist")));
  } catch (_) {
    _hasAwardedXpTable = false;
  }
  return _hasAwardedXpTable;
}

// ── AWARD XP ──────────────────────────────────────────────
async function awardXP(userId, activityType, details = {}) {
  try {
    const xpAmount = XP_AMOUNTS[activityType] || 0;
    if (xpAmount === 0) return null;

    const { data: profile, error: fetchErr } = await supabase
      .from("profiles")
      .select("xp, level, streak")
      .eq("id", userId)
      .maybeSingle();

    if (fetchErr || !profile) {
      return null;
    }

    const currentXP = profile.xp || 0;
    const currentLevel = profile.level || 1;

    if (details.documentId && ["ai_summarize", "ai_questions", "ai_flashcards"].includes(activityType)) {
      const hasTable = await checkAwardedXpTable();
      if (hasTable) {
        const { data: existing } = await supabase
          .from("awarded_xp")
          .select("id")
          .eq("user_id", userId)
          .eq("document_id", details.documentId)
          .eq("activity_type", activityType)
          .maybeSingle();

        if (existing) {
          return {
            xpAwarded: 0,
            totalXP: currentXP,
            newLevel: currentLevel,
            leveledUp: false,
            details,
          };
        }

        try {
          await supabase.from("awarded_xp").insert({
            user_id: userId,
            document_id: details.documentId,
            activity_type: activityType,
          });
        } catch (_) {}
      }
    }

    const newXP = currentXP + xpAmount;
    const newLevel = calculateLevel(newXP);
    const leveledUp = newLevel > currentLevel;

    const { error: updateErr } = await supabase
      .from("profiles")
      .update({ xp: newXP, level: newLevel })
      .eq("id", userId);

    if (updateErr) {
      return null;
    }

    return {
      xpAwarded: xpAmount,
      totalXP: newXP,
      newLevel,
      leveledUp,
      details,
    };
  } catch (err) {
    console.error("Error awarding XP:", err.message);
    return null;
  }
}

// ── CALCULATE LEVEL ──────────────────────────────────────
function calculateLevel(totalXP) {
  let level = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (totalXP >= LEVEL_THRESHOLDS[i]) {
      level = i + 1;
    } else {
      break;
    }
  }
  return level;
}

// ── UPDATE STREAK ─────────────────────────────────────────
// Called only on real study activities (upload, AI summarize/quiz/flashcards/explain/tools)
async function updateStreak(userId) {
  try {
    const todayObj = new Date();
    const today = todayObj.toISOString().split("T")[0];

    const yesterdayObj = new Date(todayObj);
    yesterdayObj.setUTCDate(yesterdayObj.getUTCDate() - 1);
    const yesterday = yesterdayObj.toISOString().split("T")[0];

    const { data: profile, error: fetchErr } = await supabase
      .from("profiles")
      .select("streak, last_activity_date")
      .eq("id", userId)
      .maybeSingle();

    if (fetchErr || !profile) {
      return 0;
    }

    let currentStreak = Number(profile.streak || 0);
    const lastDate = profile.last_activity_date ? String(profile.last_activity_date).split("T")[0] : null;
    let newStreak = currentStreak;

    if (lastDate !== today) {
      if (lastDate === yesterday) {
        newStreak = Math.max(1, currentStreak + 1);
      } else {
        newStreak = 1;
      }

      await supabase
        .from("profiles")
        .update({
          streak: newStreak,
          last_activity_date: today,
        })
        .eq("id", userId);
    }

    return newStreak;
  } catch (err) {
    console.error("Error updating streak:", err.message);
    return 0;
  }
}

// ── CHECK & UNLOCK ACHIEVEMENTS ──────────────────────────
async function checkAchievements(userId, preloaded = null) {
  try {
    const profile = preloaded?.profile || (await supabase.from("profiles").select("xp, level, streak, last_activity_date").eq("id", userId).maybeSingle()).data;
    if (!profile) return [];

    const documents = preloaded?.documents || (await supabase.from("documents").select("id").eq("user_id", userId)).data || [];
    const aiResults = preloaded?.aiResults || (await supabase.from("ai_results").select("id, result_type").eq("user_id", userId)).data || [];

    const effectiveStreak = computeEffectiveStreak(profile.streak, profile.last_activity_date);

    const stats = {
      xp: profile.xp || 0,
      level: profile.level || 1,
      streak: effectiveStreak,
      documents_uploaded: documents.length,
      summaries_generated: aiResults.filter((r) => r.result_type === "summary").length,
      flashcards_generated: aiResults.filter((r) => r.result_type === "flashcards").length,
      questions_generated: aiResults.filter((r) => r.result_type === "questions").length,
    };

    return ACHIEVEMENTS.filter((ach) => ach.requirement(stats)).map((ach) => ach.key);
  } catch (err) {
    console.error("Error checking achievements:", err.message);
    return [];
  }
}

// ── REAL PROGRESS ANALYTICS COMPUTATION ───────────────────
function computeAnalytics(documents = [], aiResults = [], activities = []) {
  const now = new Date();

  // Merge all real timestamped study events (exclude auth/coin-only metadata entries when counting study tasks)
  const studyActivities = activities.filter(
    (a) => !["user_signup"].includes(a.action)
  );

  const totalActivities = activities.length;
  const completedTasks = aiResults.length + studyActivities.filter((a) =>
    ["upload_document", "upload_image", "solve_problem", "polish_essay", "project_proposals", "viva_defense", "exam_predict", "humanize_rewrite", "ai_explain"].includes(a.action)
  ).length;

  const totalPages = documents.reduce((sum, d) => sum + Number(d.page_count || 1), 0);
  const studyTimeMinutes =
    documents.length * 8 +
    totalPages * 2 +
    aiResults.length * 10 +
    studyActivities.length * 4;

  // Success / completion rate: ratio of documents that have generated AI assets or study sessions (0 if no docs/tasks)
  let successRate = 0;
  if (documents.length > 0) {
    const docsWithResults = new Set(aiResults.map((r) => r.document_id)).size;
    successRate = Math.min(100, Math.round((docsWithResults / documents.length) * 100));
  } else if (completedTasks > 0) {
    successRate = 100;
  }

  // Build real 7-day daily activity chart (last 7 days ending today)
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const allEvents = [
    ...documents.map((d) => d.created_at),
    ...aiResults.map((r) => r.created_at),
    ...activities.map((a) => a.created_at),
  ].filter(Boolean);

  const weeklyLabels = [];
  const weeklyCounts = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().split("T")[0];
    weeklyLabels.push(dayNames[d.getUTCDay()]);
    const count = allEvents.filter((ts) => String(ts).startsWith(key)).length;
    weeklyCounts.push(count);
  }

  // Monthly: last 4 weeks (7-day buckets)
  const monthlyLabels = ["Week 1", "Week 2", "Week 3", "Week 4"];
  const monthlyCounts = [0, 0, 0, 0];
  allEvents.forEach((ts) => {
    const diffDays = Math.floor((now.getTime() - new Date(ts).getTime()) / 86400000);
    if (diffDays >= 0 && diffDays < 28) {
      const bucket = 3 - Math.floor(diffDays / 7);
      if (bucket >= 0 && bucket <= 3) monthlyCounts[bucket] += 1;
    }
  });

  // All Time: last 6 calendar months
  const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const allTimeLabels = [];
  const allTimeCounts = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    allTimeLabels.push(monthShort[d.getUTCMonth()]);
    allTimeCounts.push(allEvents.filter((ts) => String(ts).startsWith(ym)).length);
  }

  // Tools Usage Breakdown from real ai_results + user_activity
  const toolCounts = {
    "Summaries & Notes": aiResults.filter((r) => r.result_type === "summary" || r.result_type === "explanation").length +
      activities.filter((a) => a.action === "ai_explain").length,
    "Quizzes & Flashcards": aiResults.filter((r) => r.result_type === "questions" || r.result_type === "flashcards").length,
    "Coursework & Solver Tools": activities.filter((a) =>
      ["solve_problem", "polish_essay", "project_proposals", "viva_defense", "exam_predict", "humanize_rewrite"].includes(a.action)
    ).length,
  };

  const totalToolUses = Object.values(toolCounts).reduce((a, b) => a + b, 0);

  return {
    totalActivities,
    completedTasks,
    studyTimeMinutes,
    successRate,
    charts: {
      weekly: { labels: weeklyLabels, data: weeklyCounts },
      monthly: { labels: monthlyLabels, data: monthlyCounts },
      all: { labels: allTimeLabels, data: allTimeCounts },
    },
    toolsBreakdown: {
      total: totalToolUses,
      items: [
        {
          name: "Summaries & Explanations",
          count: toolCounts["Summaries & Notes"],
          percent: totalToolUses > 0 ? Math.round((toolCounts["Summaries & Notes"] / totalToolUses) * 100) : 0,
          color: "#2563eb",
        },
        {
          name: "Quizzes & Flashcards",
          count: toolCounts["Quizzes & Flashcards"],
          percent: totalToolUses > 0 ? Math.round((toolCounts["Quizzes & Flashcards"] / totalToolUses) * 100) : 0,
          color: "#9333ea",
        },
        {
          name: "Solver & Coursework Tools",
          count: toolCounts["Coursework & Solver Tools"],
          percent: totalToolUses > 0 ? Math.round((toolCounts["Coursework & Solver Tools"] / totalToolUses) * 100) : 0,
          color: "#16a34a",
        },
      ],
    },
  };
}

// ── GET USER STATS ────────────────────────────────────────
// Returns complete REAL user stats for dashboard and progress pages
async function getUserStats(userId, authUser = null) {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error || !profile) {
      return null;
    }

    const [docsRes, aiRes, actRes, coinInfo] = await Promise.all([
      supabase.from("documents").select("id, page_count, created_at").eq("user_id", userId),
      supabase.from("ai_results").select("id, document_id, result_type, created_at").eq("user_id", userId),
      supabase.from("user_activity").select("id, action, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      getUserCoinBalance(userId, authUser),
    ]);

    const documents = docsRes.data || [];
    const aiResults = aiRes.data || [];
    const activities = actRes.data || [];

    const achievements = await checkAchievements(userId, { profile, documents, aiResults });

    const level = profile.level || 1;
    const xp = profile.xp || 0;

    const currentThreshold = LEVEL_THRESHOLDS[level - 1] || 0;
    const nextThreshold = LEVEL_THRESHOLDS[level] || LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
    const xpInLevel = xp - currentThreshold;
    const xpForNextLevel = nextThreshold - currentThreshold;
    const xpProgressPercent = xpForNextLevel > 0 ? Math.min(Math.round((xpInLevel / xpForNextLevel) * 100), 100) : 100;
    const xpToNextLevel = Math.max(nextThreshold - xp, 0);

    // Resolve active plan (auto-downgrade if subscription expired)
    let activePlan = (profile.plan || "free").toLowerCase();
    let subStatus = (profile.subscription_status || "inactive").toLowerCase();
    const subEnd = profile.subscription_end ? new Date(profile.subscription_end) : null;

    if (activePlan !== "free" && subEnd && subEnd < new Date()) {
      activePlan = "free";
      subStatus = "expired";
      try {
        await supabase
          .from("profiles")
          .update({ plan: "free", subscription_status: "expired" })
          .eq("id", userId);
      } catch (_) {}
    }

    const effectiveProfileStreak = computeEffectiveStreak(profile.streak, profile.last_activity_date);
    const effectiveStreak = Math.max(effectiveProfileStreak, Number(coinInfo.streak || 0));

    const analytics = computeAnalytics(documents, aiResults, activities);

    return {
      xp,
      level,
      coins: Number(coinInfo.coins ?? 0),
      canClaimDaily: Boolean(coinInfo.canClaimDaily),
      streak: effectiveStreak,
      xpInLevel,
      xpForNextLevel,
      xpProgressPercent,
      xpToNextLevel,
      documentsCount: documents.length,
      activityCount: activities.length,
      aiResultsCount: aiResults.length,
      achievements,
      allAchievements: ACHIEVEMENTS,
      plan: activePlan,
      subscriptionStatus: subStatus,
      subscriptionEnd: profile.subscription_end || null,
      is_verified: Boolean(profile.is_verified),
      analytics,
    };
  } catch (err) {
    console.error("Error getting user stats:", err.message);
    return null;
  }
}

module.exports = {
  awardXP,
  updateStreak,
  checkAchievements,
  getUserStats,
  calculateLevel,
  ACHIEVEMENTS,
  XP_AMOUNTS,
};
