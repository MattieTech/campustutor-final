// ============================================================
// utils/toolConfig.js — Centralized AI Tools & Plan Limits Config
// ============================================================

const supabase = require("./supabase");

const STORAGE_BUCKET = "documents";
const STORAGE_CONFIG_PATH = "__system__/ai_tools_config.json";
const CACHE_TTL_MS = 15 * 1000;

let _hasToolsConfigTable = null;
let _cachedConfigMap = null;
let _cacheTimestamp = 0;

// Canonical catalog of all AI tools & upload capabilities
const DEFAULT_TOOLS_CONFIG = {
  explain: {
    toolKey: "explain",
    name: "AI Concept Explainer",
    description: "Beginner-friendly explanations with real-world examples and LaTeX math.",
    category: "core",
    enabled: true,
    coinCost: 2,
    allowCoinsBypass: true,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 5, plus: 30, pro: -1 },
    monthlyLimit: { free: 40, plus: 300, pro: -1 },
    extraConfig: {},
  },
  upload_pdf: {
    toolKey: "upload_pdf",
    name: "PDF & PPTX Upload",
    description: "Upload and extract text from lecture PDFs and PowerPoint slides.",
    category: "core",
    enabled: true,
    coinCost: 5,
    allowCoinsBypass: false,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 2, plus: 10, pro: -1 },
    monthlyLimit: { free: 2, plus: 15, pro: -1 },
    extraConfig: { maxFileSizeMB: 50 },
  },
  upload_image: {
    toolKey: "upload_image",
    name: "Camera Image Scanner & OCR",
    description: "Extract text, notes, and equations from photos and handwritten images.",
    category: "core",
    enabled: true,
    coinCost: 8,
    allowCoinsBypass: false,
    allowedPlans: ["pro"],
    dailyLimit: { free: 0, plus: 0, pro: 50 },
    monthlyLimit: { free: 0, plus: 0, pro: -1 },
    extraConfig: { maxFileSizeMB: 50 },
  },
  summarize: {
    toolKey: "summarize",
    name: "Smart Note Summarizer",
    description: "Generate structured textbook summaries at Standard, Detailed, or Comprehensive depth.",
    category: "core",
    enabled: true,
    coinCost: 3,
    allowCoinsBypass: false,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 3, plus: 20, pro: -1 },
    monthlyLimit: { free: 15, plus: 150, pro: -1 },
    extraConfig: { maxDepth: { free: 1, plus: 2, pro: 3 } },
  },
  questions: {
    toolKey: "questions",
    name: "Revision Quiz & Exam Simulator",
    description: "Generate MCQs, short-answer, and essay practice pools with grading.",
    category: "core",
    enabled: true,
    coinCost: 4,
    allowCoinsBypass: false,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 2, plus: 15, pro: -1 },
    monthlyLimit: { free: 10, plus: 120, pro: -1 },
    extraConfig: { maxQuestions: { free: 15, plus: 40, pro: 50 } },
  },
  flashcards: {
    toolKey: "flashcards",
    name: "Interactive Flashcards",
    description: "Create interactive flip-card revision decks with LaTeX equation support.",
    category: "core",
    enabled: true,
    coinCost: 3,
    allowCoinsBypass: false,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 2, plus: 15, pro: -1 },
    monthlyLimit: { free: 10, plus: 120, pro: -1 },
    extraConfig: { maxCards: { free: 10, plus: 25, pro: 50 } },
  },
  solve_problem: {
    toolKey: "solve_problem",
    name: "Assignment & Problem Solver",
    description: "Step-by-step academic solutions with formulas, derivations, and examiner tips.",
    category: "academic",
    enabled: true,
    coinCost: 5,
    allowCoinsBypass: true,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 0, plus: 5, pro: -1 },
    monthlyLimit: { free: 0, plus: 60, pro: -1 },
    extraConfig: {},
  },
  polish_essay: {
    toolKey: "polish_essay",
    name: "Thesis & Coursework Polisher",
    description: "Academic polisher, paraphraser, summarizer, and grammar checker with citations.",
    category: "academic",
    enabled: true,
    coinCost: 8,
    allowCoinsBypass: true,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 0, plus: 5, pro: -1 },
    monthlyLimit: { free: 0, plus: 50, pro: -1 },
    extraConfig: {},
  },
  project_proposals: {
    toolKey: "project_proposals",
    name: "Project & Proposal Architect",
    description: "Generate committee-ready thesis/final-year project proposals and methodologies.",
    category: "academic",
    enabled: true,
    coinCost: 10,
    allowCoinsBypass: true,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 0, plus: 3, pro: -1 },
    monthlyLimit: { free: 0, plus: 25, pro: -1 },
    extraConfig: {},
  },
  viva_defense: {
    toolKey: "viva_defense",
    name: "Viva Defense Panel Drill",
    description: "Simulate tough oral defense questions, model responses, and opening scripts.",
    category: "academic",
    enabled: true,
    coinCost: 12,
    allowCoinsBypass: true,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 0, plus: 2, pro: -1 },
    monthlyLimit: { free: 0, plus: 15, pro: -1 },
    extraConfig: {},
  },
  exam_predict: {
    toolKey: "exam_predict",
    name: "Exam Past Question Predictor",
    description: "High-probability theory, calculation, and CBT MCQ exam dossiers.",
    category: "academic",
    enabled: true,
    coinCost: 15,
    allowCoinsBypass: true,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 0, plus: 2, pro: -1 },
    monthlyLimit: { free: 0, plus: 15, pro: -1 },
    extraConfig: {},
  },
  humanize_rewrite: {
    toolKey: "humanize_rewrite",
    name: "Turnitin Originality Humanizer",
    description: "Rewrite AI-flagged drafts with natural academic cadence and burstiness.",
    category: "academic",
    enabled: true,
    coinCost: 10,
    allowCoinsBypass: true,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 0, plus: 3, pro: -1 },
    monthlyLimit: { free: 0, plus: 30, pro: -1 },
    extraConfig: {},
  },
};

const PLAN_PRICING = {
  plus: {
    name: "Plus",
    durations: {
      1: { months: 1, priceNgn: 1000, amountKobo: 100000 },
      3: { months: 3, priceNgn: 2500, amountKobo: 250000 },
      6: { months: 6, priceNgn: 4500, amountKobo: 450000 },
    },
  },
  pro: {
    name: "Pro",
    durations: {
      1: { months: 1, priceNgn: 2500, amountKobo: 250000 },
      3: { months: 3, priceNgn: 4000, amountKobo: 400000 },
      6: { months: 6, priceNgn: 7500, amountKobo: 750000 },
    },
  },
};

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_TOOLS_CONFIG));
}

function normalizeToolRow(row, fallback) {
  const base = fallback || {
    toolKey: row.tool_key || row.toolKey,
    name: row.name || row.tool_key,
    description: row.description || "",
    category: row.category || "core",
    enabled: true,
    coinCost: 0,
    allowCoinsBypass: false,
    allowedPlans: ["free", "plus", "pro"],
    dailyLimit: { free: 0, plus: 10, pro: -1 },
    monthlyLimit: { free: 0, plus: 100, pro: -1 },
    extraConfig: {},
  };

  return {
    toolKey: row.tool_key || row.toolKey || base.toolKey,
    name: row.name ?? base.name,
    description: row.description ?? base.description,
    category: row.category ?? base.category,
    enabled: row.enabled !== undefined ? Boolean(row.enabled) : base.enabled,
    coinCost: Number(row.coin_cost ?? row.coinCost ?? base.coinCost),
    allowCoinsBypass:
      row.allow_coins_bypass !== undefined
        ? Boolean(row.allow_coins_bypass)
        : row.allowCoinsBypass !== undefined
        ? Boolean(row.allowCoinsBypass)
        : base.allowCoinsBypass,
    allowedPlans: Array.isArray(row.allowed_plans || row.allowedPlans)
      ? (row.allowed_plans || row.allowedPlans).map((p) => String(p).toLowerCase())
      : base.allowedPlans,
    dailyLimit: {
      free: Number(row.daily_limit_free ?? row.dailyLimit?.free ?? base.dailyLimit.free),
      plus: Number(row.daily_limit_plus ?? row.dailyLimit?.plus ?? base.dailyLimit.plus),
      pro: Number(row.daily_limit_pro ?? row.dailyLimit?.pro ?? base.dailyLimit.pro),
    },
    monthlyLimit: {
      free: Number(row.monthly_limit_free ?? row.monthlyLimit?.free ?? base.monthlyLimit.free),
      plus: Number(row.monthly_limit_plus ?? row.monthlyLimit?.plus ?? base.monthlyLimit.plus),
      pro: Number(row.monthly_limit_pro ?? row.monthlyLimit?.pro ?? base.monthlyLimit.pro),
    },
    extraConfig: {
      ...(base.extraConfig || {}),
      ...((row.extra_config || row.extraConfig) || {}),
    },
    updatedAt: row.updated_at || row.updatedAt || null,
  };
}

async function checkToolsConfigTable() {
  if (_hasToolsConfigTable !== null) return _hasToolsConfigTable;
  try {
    const { error } = await supabase.from("ai_tools_config").select("tool_key").limit(1);
    _hasToolsConfigTable = !(
      error &&
      (error.code === "PGRST205" || (error.message || "").includes("does not exist") || (error.message || "").includes("schema cache"))
    );
  } catch (_) {
    _hasToolsConfigTable = false;
  }
  return _hasToolsConfigTable;
}

async function readConfigFromStorage() {
  try {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(STORAGE_CONFIG_PATH);
    if (!error && data) {
      const parsed = JSON.parse(await data.text());
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (_) {}

  try {
    const { data: rows } = await supabase
      .from("activity_logs")
      .select("details")
      .eq("action", "system_ai_tools_config")
      .order("created_at", { ascending: false })
      .limit(1);
    if (rows && rows[0]?.details) {
      const parsed = JSON.parse(rows[0].details);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (_) {}

  return null;
}

async function writeConfigToStorage(configMap, adminId = null) {
  const payload = JSON.stringify(configMap, null, 2);
  try {
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(STORAGE_CONFIG_PATH, Buffer.from(payload, "utf-8"), {
        contentType: "application/json",
        upsert: true,
      });
    if (!error) return;
  } catch (_) {}

  // Fallback to activity_logs table if storage bucket has RLS restrictions
  const { error: logErr } = await supabase.from("activity_logs").insert({
    admin_id: adminId || null,
    user_id: adminId || null,
    action: "system_ai_tools_config",
    details: payload,
    created_at: new Date().toISOString(),
  });
  if (logErr) {
    throw new Error(`Failed to persist tool config: ${logErr.message}`);
  }
}

async function getAllToolsConfig(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedConfigMap && now - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedConfigMap;
  }

  const merged = cloneDefaults();
  const hasTable = await checkToolsConfigTable();

  if (hasTable) {
    const { data: rows, error } = await supabase.from("ai_tools_config").select("*");
    if (!error && Array.isArray(rows) && rows.length > 0) {
      rows.forEach((row) => {
        if (row.tool_key) {
          merged[row.tool_key] = normalizeToolRow(row, merged[row.tool_key]);
        }
      });
    } else if (!error && Array.isArray(rows) && rows.length === 0) {
      // Seed defaults into table on first run
      const seedRows = Object.values(merged).map((cfg) => ({
        tool_key: cfg.toolKey,
        name: cfg.name,
        description: cfg.description,
        category: cfg.category,
        enabled: cfg.enabled,
        coin_cost: cfg.coinCost,
        allow_coins_bypass: cfg.allowCoinsBypass,
        allowed_plans: cfg.allowedPlans,
        daily_limit_free: cfg.dailyLimit.free,
        daily_limit_plus: cfg.dailyLimit.plus,
        daily_limit_pro: cfg.dailyLimit.pro,
        monthly_limit_free: cfg.monthlyLimit.free,
        monthly_limit_plus: cfg.monthlyLimit.plus,
        monthly_limit_pro: cfg.monthlyLimit.pro,
        extra_config: cfg.extraConfig || {},
        updated_at: new Date().toISOString(),
      }));
      try {
        await supabase.from("ai_tools_config").upsert(seedRows, { onConflict: "tool_key" });
      } catch (_) {}
    }
  } else {
    const stored = await readConfigFromStorage();
    if (stored) {
      Object.entries(stored).forEach(([key, val]) => {
        if (val && typeof val === "object") {
          merged[key] = normalizeToolRow({ ...val, toolKey: key }, merged[key]);
        }
      });
    }
  }

  _cachedConfigMap = merged;
  _cacheTimestamp = now;
  return merged;
}

async function getToolConfig(toolKey) {
  const all = await getAllToolsConfig();
  return all[toolKey] || null;
}

async function updateToolConfig(toolKey, updates, adminId = null) {
  const all = await getAllToolsConfig(true);
  const current = all[toolKey];
  if (!current) {
    throw new Error(`Unknown tool key: ${toolKey}`);
  }

  const sanitizeLimit = (val, fallback) => {
    if (val === undefined || val === null || val === "") return fallback;
    const n = parseInt(val, 10);
    if (!Number.isFinite(n)) return fallback;
    return n < 0 ? -1 : n;
  };

  const next = {
    ...current,
    name: typeof updates.name === "string" && updates.name.trim() ? updates.name.trim() : current.name,
    description: typeof updates.description === "string" ? updates.description.trim() : current.description,
    enabled: updates.enabled !== undefined ? Boolean(updates.enabled) : current.enabled,
    coinCost: updates.coinCost !== undefined ? Math.max(0, parseInt(updates.coinCost, 10) || 0) : current.coinCost,
    allowCoinsBypass:
      updates.allowCoinsBypass !== undefined ? Boolean(updates.allowCoinsBypass) : current.allowCoinsBypass,
    allowedPlans: Array.isArray(updates.allowedPlans)
      ? updates.allowedPlans.map((p) => String(p).toLowerCase()).filter((p) => ["free", "plus", "pro"].includes(p))
      : current.allowedPlans,
    dailyLimit: {
      free: sanitizeLimit(updates.dailyLimit?.free, current.dailyLimit.free),
      plus: sanitizeLimit(updates.dailyLimit?.plus, current.dailyLimit.plus),
      pro: sanitizeLimit(updates.dailyLimit?.pro, current.dailyLimit.pro),
    },
    monthlyLimit: {
      free: sanitizeLimit(updates.monthlyLimit?.free, current.monthlyLimit.free),
      plus: sanitizeLimit(updates.monthlyLimit?.plus, current.monthlyLimit.plus),
      pro: sanitizeLimit(updates.monthlyLimit?.pro, current.monthlyLimit.pro),
    },
    extraConfig: {
      ...(current.extraConfig || {}),
      ...(updates.extraConfig && typeof updates.extraConfig === "object" ? updates.extraConfig : {}),
    },
    updatedAt: new Date().toISOString(),
  };

  if (!next.allowedPlans.length) {
    next.allowedPlans = ["pro"];
  }

  const hasTable = await checkToolsConfigTable();
  if (hasTable) {
    const { error } = await supabase.from("ai_tools_config").upsert(
      {
        tool_key: toolKey,
        name: next.name,
        description: next.description,
        category: next.category,
        enabled: next.enabled,
        coin_cost: next.coinCost,
        allow_coins_bypass: next.allowCoinsBypass,
        allowed_plans: next.allowedPlans,
        daily_limit_free: next.dailyLimit.free,
        daily_limit_plus: next.dailyLimit.plus,
        daily_limit_pro: next.dailyLimit.pro,
        monthly_limit_free: next.monthlyLimit.free,
        monthly_limit_plus: next.monthlyLimit.plus,
        monthly_limit_pro: next.monthlyLimit.pro,
        extra_config: next.extraConfig,
        updated_at: next.updatedAt,
        updated_by: adminId,
      },
      { onConflict: "tool_key" }
    );
    if (error) {
      throw new Error(`Failed to update ai_tools_config: ${error.message}`);
    }
  } else {
    all[toolKey] = next;
    await writeConfigToStorage(all, adminId);
  }

  // Refresh cache immediately
  _cachedConfigMap = { ...all, [toolKey]: next };
  _cacheTimestamp = Date.now();
  return next;
}

function invalidateToolConfigCache() {
  _cachedConfigMap = null;
  _cacheTimestamp = 0;
}

module.exports = {
  DEFAULT_TOOLS_CONFIG,
  PLAN_PRICING,
  getAllToolsConfig,
  getToolConfig,
  updateToolConfig,
  invalidateToolConfigCache,
};
