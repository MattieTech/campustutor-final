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
// Formula: Each level requires (level * 100) total XP
// Level 1: 0 XP, Level 2: 100 XP, Level 3: 200 XP, etc.
function calculateLevel(totalXP) {
  if (totalXP < 100) return 1;
  if (totalXP < 200) return 2;
  if (totalXP < 300) return 3;
  if (totalXP < 400) return 4;
  if (totalXP < 500) return 5;
  if (totalXP < 750) return 6;
  if (totalXP < 1000) return 7;
  if (totalXP < 1500) return 8;
  if (totalXP < 2000) return 9;
  return 10; // Max level
}

// ── UPDATE STREAK ─────────────────────────────────────────
// Called after any activity to maintain study streak
async function updateStreak(userId) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

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
    const lastDate = profile.last_activity_date;

    // If this is the first activity today, check if it's consecutive
    if (lastDate !== today) {
      if (lastDate === yesterday) {
        newStreak += 1;
      } else {
        newStreak = 1; // Break in streak
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

    return {
      xp: profile.xp || 0,
      level: profile.level || 1,
      streak: profile.streak || 0,
      xpToNextLevel: (profile.level * 100) - (profile.xp || 0),
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
