// ============================================================
// utils/xp.js — XP & Achievement System
//
// Handles XP tracking, leveling, achievements, and streaks
// ============================================================

const supabase = require("./supabase");

// XP Values for activities
const XP_AMOUNTS = {
  upload_pdf: 25,
  upload_image: 20,
  ai_summarize: 30,
  ai_explain: 25,
  ai_questions: 35,
  ai_flashcards: 40,
  download_content: 10,
  first_upload: 50,     // Bonus
  first_ai: 50,         // Bonus
  level_up: 100,        // Milestone
};

// Achievement definitions
const ACHIEVEMENTS = [
  {
    key: "first_upload",
    name: "First Upload",
    icon: "🚀",
    description: "Upload your first document",
    requirement: (stats) => stats.documents_uploaded >= 1,
  },
  {
    key: "first_summary",
    name: "Summarizer",
    icon: "📋",
    description: "Generate your first summary",
    requirement: (stats) => stats.summaries_generated >= 1,
  },
  {
    key: "first_flashcards",
    name: "Flashmaster",
    icon: "🃏",
    description: "Create your first flashcard set",
    requirement: (stats) => stats.flashcards_generated >= 1,
  },
  {
    key: "streak_3",
    name: "3-Day Streak",
    icon: "🔥",
    description: "Study 3 days in a row",
    requirement: (stats) => stats.streak >= 3,
  },
  {
    key: "first_quiz",
    name: "Quiz Ace",
    icon: "📝",
    description: "Generate your first quiz",
    requirement: (stats) => stats.questions_generated >= 1,
  },
  {
    key: "level_5",
    name: "Level 5 Scholar",
    icon: "⭐",
    description: "Reach Level 5",
    requirement: (stats) => stats.level >= 5,
  },
  {
    key: "power_user",
    name: "Power User",
    icon: "⚡",
    description: "Earn 1000 XP",
    requirement: (stats) => stats.xp >= 1000,
  },
  {
    key: "documents_5",
    name: "Document Collector",
    icon: "📚",
    description: "Upload 5 documents",
    requirement: (stats) => stats.documents_uploaded >= 5,
  },
];

// Progressive Leveling Thresholds
const LEVEL_THRESHOLDS = [0, 100, 350, 750, 1350, 2150, 3150, 4350, 5850, 7850];

// ── AWARD XP ──────────────────────────────────────────────
// Call this whenever a user completes an activity
async function awardXP(userId, activityType, details = {}) {
  try {
    const xpAmount = XP_AMOUNTS[activityType] || 0;
    if (xpAmount === 0) return null;

    // Fetch current user stats
    const { data: profile, error: fetchErr } = await supabase
      .from("profiles")
      .select("xp, level, streak")
      .eq("id", userId)
      .single();

    if (fetchErr) {
      console.error("XP fetch error:", fetchErr.message);
      return null;
    }

    const currentXP = profile.xp || 0;
    const currentLevel = profile.level || 1;

    // If a document ID is provided for AI actions, check if XP was already awarded
    if (details.documentId && (activityType === "ai_summarize" || activityType === "ai_questions" || activityType === "ai_flashcards")) {
      const { data: existing, error: checkErr } = await supabase
        .from("awarded_xp")
        .select("id")
        .eq("user_id", userId)
        .eq("document_id", details.documentId)
        .eq("activity_type", activityType)
        .maybeSingle();

      if (checkErr) {
        console.error("awarded_xp query error:", checkErr.message);
      }

      if (existing) {
        console.log(`ℹ️ XP already awarded for ${activityType} on document ${details.documentId}. Skipping.`);
        return {
          xpAwarded: 0,
          totalXP: currentXP,
          newLevel: currentLevel,
          leveledUp: false,
          details,
        };
      }

      // Record the XP award
      const { error: insertErr } = await supabase
        .from("awarded_xp")
        .insert({
          user_id: userId,
          document_id: details.documentId,
          activity_type: activityType,
        });

      if (insertErr) {
        console.error("Failed to insert awarded_xp record:", insertErr.message);
      }
    }

    const newXP = currentXP + xpAmount;
    const newLevel = calculateLevel(newXP);
    const leveledUp = newLevel > currentLevel;

    // Update profile with new XP and level
    const { error: updateErr } = await supabase
      .from("profiles")
      .update({
        xp: newXP,
        level: newLevel,
      })
      .eq("id", userId);

    if (updateErr) {
      console.error("XP update error:", updateErr.message);
      return null;
    }

    console.log(
      `✨ Awarded ${xpAmount} XP to user ${userId.substring(0, 8)} | Total XP: ${newXP} | Level: ${newLevel}`
    );

    return {
      xpAwarded: xpAmount,
      totalXP: newXP,
      newLevel: newLevel,
      leveledUp: leveledUp,
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
// Called after any activity to maintain study streak
async function updateStreak(userId) {
  try {
    // Get dates in user's local timezone parsed to 'YYYY-MM-DD'
    const todayObj = new Date();
    const today = `${todayObj.getFullYear()}-${String(todayObj.getMonth() + 1).padStart(2, '0')}-${String(todayObj.getDate()).padStart(2, '0')}`;
    
    const yesterdayObj = new Date();
    yesterdayObj.setDate(yesterdayObj.getDate() - 1);
    const yesterday = `${yesterdayObj.getFullYear()}-${String(yesterdayObj.getMonth() + 1).padStart(2, '0')}-${String(yesterdayObj.getDate()).padStart(2, '0')}`;

    const { data: profile, error: fetchErr } = await supabase
      .from("profiles")
      .select("streak, last_activity_date")
      .eq("id", userId)
      .single();

    if (fetchErr) {
      console.error("Streak fetch error:", fetchErr.message);
      return null;
    }

    let newStreak = profile.streak || 0;
    const lastDate = profile.last_activity_date; // YYYY-MM-DD string in DB

    // If this is the first activity today, check if it's consecutive
    if (lastDate !== today) {
      if (lastDate === yesterday) {
        newStreak += 1;
      } else if (!lastDate) {
        newStreak = 1; // First time ever
      } else {
        // If last active date was more than 1 day ago, reset to 1
        newStreak = 1;
      }

      const { error: updateErr } = await supabase
        .from("profiles")
        .update({
          streak: newStreak,
          last_activity_date: today,
        })
        .eq("id", userId);

      if (updateErr) {
        console.error("Streak update error:", updateErr.message);
        return null;
      }

      console.log(`🔥 Updated streak for user ${userId.substring(0, 8)} | Streak: ${newStreak}`);
    }

    return newStreak;
  } catch (err) {
    console.error("Error updating streak:", err.message);
    return null;
  }
}

// ── CHECK & UNLOCK ACHIEVEMENTS ──────────────────────────
// Determines which achievements have been unlocked
async function checkAchievements(userId) {
  try {
    // Fetch user stats
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("xp, level, streak")
      .eq("id", userId)
      .single();

    if (profileErr) {
      console.error("Achievement check error:", profileErr.message);
      return [];
    }

    // Count user activities
    const { data: documents, error: docsErr } = await supabase
      .from("documents")
      .select("id")
      .eq("user_id", userId);

    const { data: summaries, error: summErr } = await supabase
      .from("ai_results")
      .select("id")
      .eq("user_id", userId)
      .eq("result_type", "summary");

    const { data: flashcards, error: flashErr } = await supabase
      .from("ai_results")
      .select("id")
      .eq("user_id", userId)
      .eq("result_type", "flashcards");

    const { data: questions, error: questErr } = await supabase
      .from("ai_results")
      .select("id")
      .eq("user_id", userId)
      .eq("result_type", "questions");

    // Build stats object
    const stats = {
      xp: profile.xp || 0,
      level: profile.level || 1,
      streak: profile.streak || 0,
      documents_uploaded: documents?.length || 0,
      summaries_generated: summaries?.length || 0,
      flashcards_generated: flashcards?.length || 0,
      questions_generated: questions?.length || 0,
    };

    // Check which achievements are unlocked
    const unlockedKeys = ACHIEVEMENTS.filter((ach) =>
      ach.requirement(stats)
    ).map((ach) => ach.key);

    return unlockedKeys;
  } catch (err) {
    console.error("Error checking achievements:", err.message);
    return [];
  }
}

// ── GET USER STATS ────────────────────────────────────────
// Returns complete user stats for dashboard
async function getUserStats(userId) {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("xp, level, streak")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Stats fetch error:", error.message);
      return null;
    }

    // Get counts
    const { data: documents } = await supabase
      .from("documents")
      .select("id")
      .eq("user_id", userId);

    const { data: activity } = await supabase
      .from("user_activity")
      .select("id")
      .eq("user_id", userId);

    // Check achievements
    const achievements = await checkAchievements(userId);

    const level = profile.level || 1;
    const xp = profile.xp || 0;
    
    // Calculate level thresholds
    const currentThreshold = LEVEL_THRESHOLDS[level - 1] || 0;
    const nextThreshold = LEVEL_THRESHOLDS[level] || LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
    const xpInLevel = xp - currentThreshold;
    const xpForNextLevel = nextThreshold - currentThreshold;
    const xpProgressPercent = Math.min(Math.round((xpInLevel / xpForNextLevel) * 100), 100);
    const xpToNextLevel = Math.max(nextThreshold - xp, 0);

    return {
      xp: xp,
      level: level,
      streak: profile.streak || 0,
      xpInLevel: xpInLevel,
      xpForNextLevel: xpForNextLevel,
      xpProgressPercent: xpProgressPercent,
      xpToNextLevel: xpToNextLevel,
      documentsCount: documents?.length || 0,
      activityCount: activity?.length || 0,
      achievements: achievements,
      allAchievements: ACHIEVEMENTS,
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
