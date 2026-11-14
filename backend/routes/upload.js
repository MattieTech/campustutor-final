// ============================================================
// routes/upload.js — PDF, PPTX, DOCX & Image Upload & Extraction
// ============================================================

const express = require("express");
const router = express.Router();
const multer = require("multer");
const pdfParse = require("pdf-parse");
const officeParser = require("officeparser");
const supabase = require("../utils/supabase");
const authMiddleware = require("../middleware/authMiddleware");
const subscriptionMiddleware = require("../middleware/subscriptionMiddleware");
const { awardXP, updateStreak } = require("../utils/xp");
const { warmDocumentStudyAssets } = require("./ai");
const { ocrScannedPDF, extractTextFromImage } = require("../utils/gemini");
const { evaluateToolAccess, recordToolUsage, withUserLock } = require("../utils/usageService");
const { deductCoins, addCoins } = require("../utils/coins");

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ];
    const ext = (file.originalname || "").split(".").pop().toLowerCase();
    const allowedExts = ["pdf", "pptx", "ppt", "docx", "txt", "jpg", "jpeg", "png", "webp"];

    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only PDF, PowerPoint (.pptx), Word (.docx), Text (.txt), and image files (JPG, PNG, WEBP) are allowed!"
        ),
        false
      );
    }
  },
});

async function parseOfficeToText(fileBuffer) {
  const ast = await officeParser.parseOffice(fileBuffer);
  if (typeof ast === "string") return ast;
  if (ast && typeof ast.toText === "function") return ast.toText();
  return String(ast || "");
}

async function uploadFileToStorage(userId, file, fileType) {
  const safeName = String(file.originalname || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileName = `${userId}/${Date.now()}-${safeName}`;
  const bucketName = fileType === "image" ? "images" : "documents";

  try {
    const { error } = await supabase.storage
      .from(bucketName)
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        cacheControl: "3600",
      });

    if (error) {
      throw new Error(`Storage upload failed: ${error.message}`);
    }

    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return {
      path: fileName,
      url: urlData?.publicUrl,
      bucket: bucketName,
    };
  } catch (err) {
    console.error("❌ Storage upload error:", err.message);
    return null;
  }
}

// ── UPLOAD PDF / PPTX / DOCX / TXT ─────────────────────────────
router.post("/pdf", authMiddleware, subscriptionMiddleware, upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No document file was uploaded." });
    }

    const ext = (req.file.originalname || "").split(".").pop().toLowerCase();
    const isPdf = req.file.mimetype === "application/pdf" || ext === "pdf";
    const isPptx =
      req.file.mimetype === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      req.file.mimetype === "application/vnd.ms-powerpoint" ||
      ext === "pptx" ||
      ext === "ppt";
    const isDocx =
      req.file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      ext === "docx";
    const isTxt = req.file.mimetype === "text/plain" || ext === "txt";

    if (!isPdf && !isPptx && !isDocx && !isTxt) {
      return res.status(400).json({ error: "Only PDF, PPTX, DOCX, and TXT files are allowed here!" });
    }

    const userId = req.user.id;
    const access = await withUserLock(userId, () =>
      evaluateToolAccess({
        userId,
        plan: req.effectivePlan,
        coins: req.userCoins,
        isAdmin: req.isAdmin,
        toolKey: "upload_pdf",
        useCoins: Boolean(req.body?.useCoins),
      })
    );

    if (!access.allowed) {
      return res.status(access.statusCode || 403).json(access.errorPayload);
    }

    let deductedCoins = 0;
    if (access.chargeCoins > 0) {
      const coinRes = await deductCoins(userId, access.chargeCoins, "upload_pdf", `Uploaded "${req.file.originalname}"`, req.user);
      if (!coinRes.success) {
        return res.status(403).json({
          error: coinRes.error,
          insufficientCoins: true,
          needCoins: true,
          needed: access.chargeCoins,
          currentCoins: coinRes.currentCoins ?? req.userCoins,
        });
      }
      deductedCoins = access.chargeCoins;
    }

    const fileName = req.file.originalname;
    const fileBuffer = req.file.buffer;
    const fileType = isPdf ? "pdf" : isPptx ? "pptx" : isDocx ? "docx" : "txt";

    console.log(`📄 Processing ${fileType.toUpperCase()}: ${fileName} for user ${userId}`);

    let extractedText = "";
    let pageCount = 1;

    try {
      if (isPdf) {
        try {
          const pdfData = await pdfParse(fileBuffer);
          extractedText = pdfData.text || "";
          pageCount = pdfData.numpages || 1;
        } catch (pdfErr) {
          console.warn("⚠️ pdf-parse failed, attempting OCR:", pdfErr.message);
        }

        if (!extractedText || extractedText.trim().length < 50) {
          extractedText = await ocrScannedPDF(fileBuffer);
          pageCount = pageCount || Math.max(1, Math.ceil(extractedText.length / 2500));
        }
      } else if (isTxt) {
        extractedText = fileBuffer.toString("utf-8");
        pageCount = Math.max(1, Math.ceil(extractedText.length / 3000));
      } else {
        extractedText = await parseOfficeToText(fileBuffer);
        pageCount = Math.max(1, Math.ceil(extractedText.length / 2500));
      }
    } catch (parseErr) {
      if (deductedCoins > 0) {
        await addCoins(userId, deductedCoins, "coin_refund", "Refund for failed document extraction", req.user).catch(() => {});
      }
      return res.status(400).json({
        error: parseErr.message || "Could not extract text from this document. It may be encrypted or corrupted.",
      });
    }

    if (!extractedText || !extractedText.trim()) {
      if (deductedCoins > 0) {
        await addCoins(userId, deductedCoins, "coin_refund", "Refund for empty document", req.user).catch(() => {});
      }
      return res.status(400).json({
        error: "No readable text was found in this document. Please upload a text-based PDF, PPTX, DOCX, or clear scanned document.",
      });
    }

    const maxChars = 120000;
    const storedText =
      extractedText.length > maxChars
        ? extractedText.substring(0, maxChars) + "\n\n[Document truncated at 120,000 characters...]"
        : extractedText;

    const fileStorageData = await uploadFileToStorage(userId, req.file, fileType);

    const { data: document, error: dbError } = await supabase
      .from("documents")
      .insert({
        user_id: userId,
        file_name: fileName,
        file_type: fileType,
        file_path: fileStorageData?.path || null,
        extracted_text: storedText,
        page_count: pageCount,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (dbError) {
      if (deductedCoins > 0) {
        await addCoins(userId, deductedCoins, "coin_refund", "Refund for failed database save", req.user).catch(() => {});
      }
      console.error("Database error:", dbError.message);
      return res.status(500).json({ error: "Failed to save document to database." });
    }

    await recordToolUsage(userId, "upload_pdf");

    res.json({
      success: true,
      documentId: document.id,
      message: `${fileType.toUpperCase()} uploaded and processed successfully!`,
      document: {
        id: document.id,
        fileName: document.file_name,
        fileType,
        fileUrl: fileStorageData?.url,
        pageCount: document.page_count,
        textLength: storedText.length,
        extractedText: storedText,
      },
    });

    setImmediate(async () => {
      try {
        await supabase.from("user_activity").insert({
          user_id: userId,
          action: "upload_document",
          details: `Uploaded ${fileType.toUpperCase()} "${fileName}" (${pageCount} pages)`,
          created_at: new Date().toISOString(),
        });
      } catch (activityErr) {
        console.log("Note: Could not log activity:", activityErr.message);
      }

      Promise.allSettled([
        awardXP(userId, "upload_pdf", { fileName, pageCount }),
        updateStreak(userId),
      ]).catch(() => {});
    });
  } catch (err) {
    console.error("Upload error:", err.message);
    if (err.message.includes("allowed")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Upload failed. Please try again." });
  }
});

// ── UPLOAD IMAGE (Pro Plan / Centrally Configured OCR) ────────
router.post(
  "/image",
  authMiddleware,
  subscriptionMiddleware,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file was uploaded." });
      }

      const allowedImageTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
      if (!allowedImageTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          error: "Only JPG, JPEG, PNG, and WEBP images are allowed!",
        });
      }

      const userId = req.user.id;
      const access = await withUserLock(userId, () =>
        evaluateToolAccess({
          userId,
          plan: req.effectivePlan,
          coins: req.userCoins,
          isAdmin: req.isAdmin,
          toolKey: "upload_image",
          useCoins: Boolean(req.body?.useCoins),
        })
      );

      if (!access.allowed) {
        return res.status(access.statusCode || 403).json(access.errorPayload);
      }

      let deductedCoins = 0;
      if (access.chargeCoins > 0) {
        const coinRes = await deductCoins(userId, access.chargeCoins, "upload_image", `Scanned image "${req.file.originalname}"`, req.user);
        if (!coinRes.success) {
          return res.status(403).json({
            error: coinRes.error,
            insufficientCoins: true,
            needCoins: true,
            needed: access.chargeCoins,
            currentCoins: coinRes.currentCoins ?? req.userCoins,
          });
        }
        deductedCoins = access.chargeCoins;
      }

      const fileName = req.file.originalname;
      const fileBuffer = req.file.buffer;

      console.log(`📸 Processing & OCR-scanning image: ${fileName} for user ${userId}`);

      let extractedText = "";
      try {
        extractedText = await extractTextFromImage(fileBuffer, req.file.mimetype);
      } catch (ocrErr) {
        if (deductedCoins > 0) {
          await addCoins(userId, deductedCoins, "coin_refund", "Refund for failed image OCR", req.user).catch(() => {});
        }
        return res.status(502).json({
          error: ocrErr.message || "Could not transcribe text from this image. Please try a clearer photo.",
        });
      }

      const fileStorageData = await uploadFileToStorage(userId, req.file, "image");

      const { data: document, error: dbError } = await supabase
        .from("documents")
        .insert({
          user_id: userId,
          file_name: fileName,
          file_type: "image",
          file_path: fileStorageData?.path || null,
          extracted_text: extractedText,
          page_count: 1,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (dbError) {
        if (deductedCoins > 0) {
          await addCoins(userId, deductedCoins, "coin_refund", "Refund for failed image DB save", req.user).catch(() => {});
        }
        console.error("Database error:", dbError.message);
        return res.status(500).json({ error: "Failed to save image to database." });
      }

      await recordToolUsage(userId, "upload_image");

      res.json({
        success: true,
        documentId: document.id,
        message: "Image scanned and transcribed successfully!",
        document: {
          id: document.id,
          fileName: document.file_name,
          fileType: "image",
          fileUrl: fileStorageData?.url,
          mimeType: req.file.mimetype,
          size: req.file.size,
          textLength: extractedText.length,
          extractedText,
        },
      });

      setImmediate(async () => {
        try {
          await supabase.from("user_activity").insert({
            user_id: userId,
            action: "upload_image",
            details: `Scanned & uploaded image "${fileName}" (${req.file.mimetype})`,
            created_at: new Date().toISOString(),
          });
        } catch (_) {}

        Promise.allSettled([
          awardXP(userId, "upload_image", { fileName }),
          updateStreak(userId),
        ]).catch(() => {});
      });
    } catch (err) {
      console.error("Image upload error:", err.message);
      if (err.message.includes("allowed")) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Image upload failed. Please try again." });
    }
  }
);

// ── LIST USER'S DOCUMENTS ─────────────────────────────────────
router.get("/my-docs", authMiddleware, async (req, res) => {
  try {
    const { data: documents, error } = await supabase
      .from("documents")
      .select("id, file_name, file_type, page_count, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: "Failed to fetch documents." });
    }

    res.json({ documents: documents || [] });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch documents." });
  }
});

// ── GET USER'S ACTIVITY LOG ───────────────────────────────────
router.get("/my-activity", authMiddleware, async (req, res) => {
  try {
    const { data: activities, error } = await supabase
      .from("user_activity")
      .select("id, action, details, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      if (error.message.includes("does not exist")) {
        return res.json({ activities: [], total: 0 });
      }
      return res.status(500).json({ error: "Failed to fetch activity." });
    }

    res.json({
      total: (activities || []).length,
      activities: activities || [],
    });
  } catch (err) {
    res.json({ activities: [], total: 0 });
  }
});

// ── GET LEADERBOARD DATA ──────────────────────────────────────
router.get("/leaderboard", authMiddleware, async (req, res) => {
  try {
    const { getUserCoinBalance } = require("../utils/coins");
    const { data: profilesList, error } = await supabase
      .from("profiles")
      .select("id, full_name, xp, level, streak")
      .order("xp", { ascending: false })
      .limit(10);

    if (error) {
      return res.status(500).json({ error: "Failed to fetch leaderboard data." });
    }

    const enriched = await Promise.all(
      (profilesList || []).map(async (p) => {
        const coinInfo = await getUserCoinBalance(p.id);
        return {
          id: p.id,
          full_name: p.full_name || "Student",
          xp: p.xp || 0,
          level: p.level || 1,
          coins: Number(coinInfo.coins ?? 0),
        };
      })
    );

    enriched.sort((a, b) => b.coins - a.coins || b.xp - a.xp);
    res.json({ leaderboard: enriched.slice(0, 5) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch leaderboard." });
  }
});

// ── GET SINGLE DOCUMENT ───────────────────────────────────────
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { data: document, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();

    if (error || !document) {
      return res.status(404).json({ error: "Document not found." });
    }

    res.json({ document });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch document." });
  }
});

// ── DELETE DOCUMENT ───────────────────────────────────────────
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);

    if (error) {
      return res.status(500).json({ error: "Failed to delete document." });
    }

    res.json({ message: "Document deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete document." });
  }
});

async function ensureProfile(userId, email) {
  try {
    const cleanEmail = email ? email.trim().toLowerCase() : null;
    let query = supabase.from("profiles").select("*");
    if (userId) query = query.eq("id", userId);
    else if (cleanEmail) query = query.ilike("email", cleanEmail);

    const { data: profile } = await query.maybeSingle();

    if (!profile) {
      const refCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      await supabase.from("profiles").insert({
        id: userId,
        full_name: email ? email.split("@")[0] : "Student",
        email: cleanEmail || `${userId}@campustutor.com`,
        plan: "free",
        is_verified: false,
        referral_code: refCode,
        created_at: new Date().toISOString(),
      });
    } else if (!profile.referral_code) {
      const refCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      await supabase.from("profiles").update({ referral_code: refCode }).eq("id", profile.id);
    }
  } catch (err) {
    console.error("Failed to ensure profile:", err.message);
  }
}

router.get("/stats/:userId", authMiddleware, async (req, res) => {
  try {
    const { getUserStats } = require("../utils/xp");
    const { getUserCoinBalance, computeEffectiveStreak } = require("../utils/coins");
    const { getUserUsageSummary } = require("../utils/usageService");
    const userId = req.params.userId;

    if (userId !== req.user.id && req.user.app_metadata?.role !== "admin") {
      return res.status(403).json({ error: "Cannot view other users' stats." });
    }

    await ensureProfile(userId, req.user.email);

    let stats = null;
    try {
      stats = await getUserStats(userId, req.user);
    } catch (xpErr) {
      console.error("XP utility fetch error:", xpErr.message);
    }

    if (!stats) {
      const { data: fallbackProfile } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();
      const coinInfo = await getUserCoinBalance(userId, req.user);

      stats = {
        level: fallbackProfile?.level || 1,
        xp: fallbackProfile?.xp || 0,
        coins: Number(coinInfo.coins ?? 0),
        canClaimDaily: Boolean(coinInfo.canClaimDaily),
        xpInLevel: (fallbackProfile?.xp || 0) % 100,
        xpForNextLevel: 100,
        xpProgressPercent: (fallbackProfile?.xp || 0) % 100,
        streak: Math.max(
          computeEffectiveStreak(fallbackProfile?.streak, fallbackProfile?.last_activity_date),
          Number(coinInfo.streak || 0)
        ),
        documentsCount: 0,
        activityCount: 0,
        aiResultsCount: 0,
        plan: (fallbackProfile?.plan || "free").toLowerCase(),
        subscriptionStatus: (fallbackProfile?.subscription_status || "inactive").toLowerCase(),
        subscriptionEnd: fallbackProfile?.subscription_end || null,
        is_verified: Boolean(fallbackProfile?.is_verified),
      };
    }

    const isAdmin = req.user.app_metadata?.role === "admin";
    try {
      stats.usage = await getUserUsageSummary(userId, stats.plan || "free", isAdmin);
    } catch (_) {}

    res.json(stats);
  } catch (err) {
    console.error("Stats fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch stats." });
  }
});

// ── GET USER'S AI RESULTS ─────────────────────────────────────
router.get("/my-results", authMiddleware, async (req, res) => {
  try {
    const { data: results, error } = await supabase
      .from("ai_results")
      .select(`
        id,
        document_id,
        result_type,
        content,
        created_at,
        documents(id, file_name, created_at)
      `)
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      if (error.message.includes("does not exist")) {
        return res.json({ results: [], total: 0 });
      }
      return res.status(500).json({ error: "Failed to fetch AI results." });
    }

    const groupedResults = {};
    (results || []).forEach((result) => {
      const docId = result.document_id;
      const docObj = Array.isArray(result.documents) ? result.documents[0] : result.documents;
      if (!groupedResults[docId]) {
        groupedResults[docId] = {
          document_id: docId,
          document_name: docObj?.file_name || "Untitled Document",
          document_created_at: docObj?.created_at || null,
          results: [],
        };
      }
      groupedResults[docId].results.push({
        id: result.id,
        type: result.result_type,
        content: result.content,
        created_at: result.created_at,
      });
    });

    res.json({
      total: (results || []).length,
      results: Object.values(groupedResults),
    });
  } catch (err) {
    res.json({ results: [], total: 0 });
  }
});

// ── GET REFERRAL DASHBOARD STATS ──────────────────────────────
router.get("/referrals/stats", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    await ensureProfile(userId, req.user.email);

    let { data: profile } = await supabase
      .from("profiles")
      .select("referral_code, referred_by")
      .eq("id", userId)
      .maybeSingle();

    if (!profile) {
      const cleanEmail = req.user.email ? req.user.email.trim().toLowerCase() : null;
      if (cleanEmail) {
        const { data: retryProfile } = await supabase
          .from("profiles")
          .select("referral_code, referred_by, id")
          .ilike("email", cleanEmail)
          .maybeSingle();
        if (retryProfile) {
          await supabase.from("profiles").update({ id: userId }).eq("email", cleanEmail);
          const { data: healed } = await supabase
            .from("profiles")
            .select("referral_code, referred_by")
            .eq("id", userId)
            .single();
          profile = healed;
        }
      }
      if (!profile) {
        return res.status(404).json({ error: "User profile not found. Please log out and log in again." });
      }
    }

    const { count: refereeCount } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("referred_by", userId);

    const { data: completedRefs } = await supabase
      .from("referrals")
      .select("reward_amount")
      .eq("referrer_id", userId)
      .eq("status", "completed");

    const totalEarned = (completedRefs || []).reduce((acc, curr) => acc + Number(curr.reward_amount || 0), 0);

    const { data: withdrawals } = await supabase
      .from("withdrawals")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    const totalWithdrawn = (withdrawals || [])
      .filter((w) => w.status === "approved")
      .reduce((acc, curr) => acc + Number(curr.amount || 0), 0);

    const pendingWithdrawn = (withdrawals || [])
      .filter((w) => w.status === "pending")
      .reduce((acc, curr) => acc + Number(curr.amount || 0), 0);

    const balance = Math.max(0, totalEarned - totalWithdrawn - pendingWithdrawn);

    res.json({
      referral_code: profile.referral_code,
      referee_count: refereeCount || 0,
      balance,
      total_withdrawn: totalWithdrawn,
      withdrawals: withdrawals || [],
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load referral statistics." });
  }
});

// ── SUBMIT WITHDRAWAL REQUEST ─────────────────────────────────
router.post("/referrals/withdraw", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, bankName, accountName, accountNumber } = req.body;
    const withdrawAmt = parseInt(amount, 10);

    if (!withdrawAmt || withdrawAmt < 1500) {
      return res.status(400).json({ error: "Minimum payout request is ₦1,500." });
    }
    if (!bankName || !accountNumber || !accountName) {
      return res.status(400).json({ error: "Bank details (Bank Name, Account Number, Account Name) are required." });
    }

    const { data: completedRefs } = await supabase
      .from("referrals")
      .select("reward_amount")
      .eq("referrer_id", userId)
      .eq("status", "completed");

    const totalEarned = (completedRefs || []).reduce((acc, curr) => acc + Number(curr.reward_amount || 0), 0);

    const { data: withdrawals } = await supabase.from("withdrawals").select("*").eq("user_id", userId);

    const totalWithdrawn = (withdrawals || [])
      .filter((w) => w.status === "approved")
      .reduce((acc, curr) => acc + Number(curr.amount || 0), 0);

    const pendingWithdrawn = (withdrawals || [])
      .filter((w) => w.status === "pending")
      .reduce((acc, curr) => acc + Number(curr.amount || 0), 0);

    const balance = Math.max(0, totalEarned - totalWithdrawn - pendingWithdrawn);

    if (withdrawAmt > balance) {
      return res.status(400).json({ error: "Insufficient wallet balance." });
    }

    const { data, error } = await supabase
      .from("withdrawals")
      .insert({
        user_id: userId,
        amount: withdrawAmt,
        status: "pending",
        bank_name: bankName,
        account_number: accountNumber,
        account_name: accountName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Failed to submit withdrawal request." });
    }

    res.json({ message: "Withdrawal request submitted successfully.", withdrawal: data });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit withdrawal request." });
  }
});

module.exports = router;
module.exports.parseOfficeToText = parseOfficeToText;
