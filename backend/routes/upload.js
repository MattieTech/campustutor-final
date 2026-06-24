// ============================================================
// routes/upload.js — PDF & Image Upload & Storage
// ============================================================

const express = require("express");
const router = express.Router();
const multer = require("multer");
const pdfParse = require("pdf-parse");
const supabase = require("../utils/supabase");
const authMiddleware = require("../middleware/authMiddleware");
const { awardXP, updateStreak } = require("../utils/xp");
const { warmDocumentStudyAssets } = require("./ai");
const { ocrScannedPDF } = require("../utils/gemini");

const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only PDF, PowerPoint (.pptx) and image files (JPG, PNG, WEBP) are allowed!"
        ),
        false
      );
    }
  },
});

async function uploadFileToStorage(userId, file, fileType) {
  const fileName = `${userId}/${Date.now()}-${file.originalname}`;
  const bucketName = (fileType === "pdf" || fileType === "pptx") ? "documents" : "images";

  try {
    const { data, error } = await supabase.storage
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
    console.error(`❌ Storage upload error:`, err.message);
    return null;
  }
}

// ── UPLOAD PDF & PPTX ──────────────────────────────────────────
router.post("/pdf", authMiddleware, upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No document file was uploaded." });
    }

    const isPdf = req.file.mimetype === "application/pdf";
    const isPptx = req.file.mimetype === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || 
                   req.file.mimetype === "application/vnd.ms-powerpoint";

    if (!isPdf && !isPptx) {
      return res.status(400).json({ error: "Only PDF and PowerPoint files are allowed!" });
    }

    const userId = req.user.id;
    
    // Enforce Plan Boundaries
    const { data: profile } = await supabase
      .from("profiles")
      .select("plan")
      .eq("id", userId)
      .single();
    const userPlan = profile?.plan || 'free';

    if (userPlan === 'free') {
      const { count: totalDocs } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (totalDocs >= 2) {
        return res.status(403).json({ error: "Free Trial tier limits reached (maximum 2 documents total). Please upgrade your plan." });
      }
    } else if (userPlan === 'plus') {
      const startOfMonth = new Date();
      startOfMonth.setUTCDate(1);
      startOfMonth.setUTCHours(0, 0, 0, 0);

      const { count: monthlyDocs } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", startOfMonth.toISOString());
      
      if (monthlyDocs >= 15) {
        return res.status(403).json({ error: "Plus Plan tier limits reached (maximum 15 documents per month). Please upgrade to Pro." });
      }
    }

    const fileName = req.file.originalname;
    const fileBuffer = req.file.buffer;
    const fileType = isPdf ? "pdf" : "pptx";

    console.log(`📄 Processing ${fileType.toUpperCase()}: ${fileName} for user ${userId}`);

    let extractedText = "";
    let pageCount = 0;

    if (isPdf) {
      try {
        const pdfData = await pdfParse(fileBuffer);
        extractedText = pdfData.text;
        pageCount = pdfData.numpages || 0;
      } catch (pdfErr) {
        console.warn("⚠️ PDF parsing failed:", pdfErr.message);
        return res.status(400).json({
          error: "Could not read this PDF. It may be encrypted, scanned, or corrupted. Please try another PDF.",
        });
      }

      if (!extractedText || extractedText.trim().length < 50) {
        try {
          extractedText = await ocrScannedPDF(fileBuffer);
        } catch (ocrErr) {
          console.error("❌ Scanned PDF OCR fallback failed:", ocrErr.message);
          return res.status(400).json({
            error: "This PDF appears to be a scanned image and OCR processing failed. Please use a text-based PDF.",
          });
        }
      }
    } else {
      try {
        const officeParser = require("officeparser");
        extractedText = await officeParser.parseOffice(fileBuffer);
        pageCount = 1;
      } catch (pptxErr) {
        console.error("❌ PPTX parsing failed:", pptxErr.message);
        return res.status(400).json({
          error: "Could not read this PowerPoint file. It may be corrupted. Please try another file.",
        });
      }
    }

    const truncatedText =
      extractedText.length > 15000
        ? extractedText.substring(0, 15000) + "\n\n[Document truncated...]"
        : extractedText;

    const fileStorageData = await uploadFileToStorage(userId, req.file, fileType);

    const { data: document, error: dbError } = await supabase
      .from("documents")
      .insert({
        user_id: userId,
        file_name: fileName,
        file_type: fileType,
        file_path: fileStorageData?.path || null,
        extracted_text: truncatedText,
        page_count: pageCount,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (dbError) {
      console.error("Database error:", dbError.message);
      return res.status(500).json({ error: "Failed to save document to database." });
    }

    res.json({
      success: true,
      documentId: document.id,
      message: "PDF uploaded and processed successfully!",
      document: {
        id: document.id,
        fileName: document.file_name,
        fileType: "pdf",
        fileUrl: fileStorageData?.url,
        pageCount: document.page_count,
        textLength: truncatedText.length,
        extractedText: truncatedText,
      },
    });

    setImmediate(() => {
      supabase.from("user_activity").insert({
        user_id: userId,
        action: "upload_document",
        details: `Uploaded PDF "${fileName}" (${pageCount} pages)`,
        created_at: new Date().toISOString(),
      }).catch((activityErr) => {
        console.log("Note: Could not log activity:", activityErr.message);
      });

      Promise.allSettled([
        awardXP(userId, "upload_pdf", { fileName, pageCount }),
        updateStreak(userId),
      ]).catch((xpErr) => {
        console.log("Note: Could not award XP:", xpErr.message);
      });

      warmDocumentStudyAssets(document.id, userId).catch((err) => {
        console.log("Note: Background study asset warmup failed:", err.message);
      });
    });
  } catch (err) {
    console.error("Upload error:", err.message);
    if (err.message.includes("allowed")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Upload failed. Please try again." });
  }
});

// ── UPLOAD IMAGE ──────────────────────────────────────────────
router.post(
  "/image",
  authMiddleware,
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

      // Enforce Plan Boundaries (Rejects free & plus)
      const { data: profile } = await supabase
        .from("profiles")
        .select("plan")
        .eq("id", userId)
        .single();
      const userPlan = profile?.plan || 'free';

      if (userPlan === 'free' || userPlan === 'plus') {
        return res.status(403).json({ error: "Image uploads and photo scans are only available on the Pro Plan. Please upgrade." });
      }

      const fileName = req.file.originalname;
      const fileBuffer = req.file.buffer;

      console.log(`📸 Processing image: ${fileName} for user ${userId}`);

      const base64Image = fileBuffer.toString("base64");
      const fileStorageData = await uploadFileToStorage(userId, req.file, "image");

      const { data: document, error: dbError } = await supabase
        .from("documents")
        .insert({
          user_id: userId,
          file_name: fileName,
          file_type: "image",
          file_path: fileStorageData?.path || null,
          extracted_text: `[Image: ${fileName}]\n\nBase64 encoded for AI analysis.\n\nMIME Type: ${req.file.mimetype}`,
          page_count: 1,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (dbError) {
        console.error("Database error:", dbError.message);
        return res.status(500).json({ error: "Failed to save image to database." });
      }

      res.json({
        success: true,
        documentId: document.id,
        message: "Image uploaded successfully!",
        document: {
          id: document.id,
          fileName: document.file_name,
          fileType: "image",
          fileUrl: fileStorageData?.url,
          mimeType: req.file.mimetype,
          size: req.file.size,
          base64: base64Image,
        },
      });

      setImmediate(() => {
        supabase.from("user_activity").insert({
          user_id: userId,
          action: "upload_image",
          details: `Uploaded image "${fileName}" (${req.file.mimetype})`,
          created_at: new Date().toISOString(),
        }).catch((activityErr) => {
          console.log("Note: Could not log activity:", activityErr.message);
        });

        Promise.allSettled([
          awardXP(userId, "upload_image", { fileName }),
          updateStreak(userId),
        ]).catch((xpErr) => {
          console.log("Note: Could not award XP:", xpErr.message);
        });

        warmDocumentStudyAssets(document.id, userId).catch((err) => {
          console.log("Note: Background study asset warmup failed:", err.message);
        });
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
      .select("id, file_name, page_count, created_at")
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

// ── GET USER'S ACTIVITY LOG ────────────────────────────────────
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
      activities: activities || []
    });
  } catch (err) {
    console.log("Note: Could not fetch user activity:", err.message);
    res.json({ activities: [], total: 0 });
  }
});

// ── GET LEADERBOARD DATA ──────────────────────────────────────
router.get("/leaderboard", authMiddleware, async (req, res) => {
  try {
    const { data: leaderboard, error } = await supabase
      .from("profiles")
      .select("id, full_name, xp, level")
      .order("xp", { ascending: false })
      .limit(5);

    if (error) {
      console.error("Leaderboard query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch leaderboard data." });
    }

    res.json({ leaderboard: leaderboard || [] });
  } catch (err) {
    console.error("Leaderboard error:", err.message);
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
});// Auto-heals missing profiles in the database
async function ensureProfile(userId, email) {
  try {
    const cleanEmail = email ? email.trim().toLowerCase() : null;
    let query = supabase.from("profiles").select("*");
    if (userId) {
      query = query.eq("id", userId);
    } else if (cleanEmail) {
      query = query.ilike("email", cleanEmail);
    }

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
      console.log(`✅ Auto-healed profile row for user ${userId}`);
    } else if (!profile.referral_code) {
      const refCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      await supabase
        .from("profiles")
        .update({ referral_code: refCode })
        .eq("id", profile.id);
      console.log(`✅ Added referral code to existing profile for user ${profile.id}`);
    }
  } catch (err) {
    console.error("Failed to ensure profile:", err.message);
  }
}


router.get("/stats/:userId", authMiddleware, async (req, res) => {
  try {
    const { getUserStats, updateStreak } = require("../utils/xp");
    const userId = req.params.userId;
    
    if (userId !== req.user.id) {
      return res.status(403).json({ error: "Cannot view other users' stats." });
    }

    // Auto-heal profile if it is missing
    await ensureProfile(userId, req.user.email);

    try {
      await updateStreak(userId);
    } catch (streakErr) {
      console.error("Failed to automatically update streak on stats load:", streakErr.message);
    }

    let stats = null;
    try {
      stats = await getUserStats(userId);
    } catch (xpErr) {
      console.error("XP utility fetch error:", xpErr.message);
    }

    if (!stats) {
      // Return a basic mock stats response as a safe fallback to prevent page crashing
      const cleanEmail = req.user.email ? req.user.email.trim().toLowerCase() : "";
      const { data: fallbackProfile } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();

      stats = {
        level: fallbackProfile?.level || 1,
        xp: fallbackProfile?.xp || 0,
        xpInLevel: (fallbackProfile?.xp || 0) % 100,
        xpForNextLevel: 100,
        xpProgressPercent: (fallbackProfile?.xp || 0) % 100,
        streak: fallbackProfile?.streak || 0,
        documentsCount: 0,
        activityCount: 0,
        plan: fallbackProfile?.plan || 'free',
        is_verified: fallbackProfile?.is_verified || true
      };
    }

    res.json(stats);
  } catch (err) {
    console.error("Stats fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch stats." });
  }
});

// ── GET USER'S AI RESULTS ──────────────────────────────────────
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
    (results || []).forEach(result => {
      const docId = result.document_id;
      if (!groupedResults[docId]) {
        groupedResults[docId] = {
          document_id: docId,
          document_name: result.documents?.[0]?.file_name || 'Unknown Document',
          document_created_at: result.documents?.[0]?.created_at || null,
          results: []
        };
      }
      groupedResults[docId].results.push({
        id: result.id,
        type: result.result_type,
        content: result.content,
        created_at: result.created_at
      });
    });

    res.json({
      total: (results || []).length,
      results: Object.values(groupedResults)
    });
  } catch (err) {
    console.log("Error fetching AI results:", err.message);
    res.json({ results: [], total: 0 });
  }
});

// ── GET REFERRAL DASHBOARD STATS ──────────────────────────────────────
router.get("/referrals/stats", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Auto-heal profile if missing
    await ensureProfile(userId, req.user.email);

    // 1. Get profile referral code
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("referral_code, referred_by")
      .eq("id", userId)
      .maybeSingle();

    if (profileErr || !profile) {
      // Retry lookup using clean email as backup
      const cleanEmail = req.user.email ? req.user.email.trim().toLowerCase() : null;
      if (cleanEmail) {
        const { data: retryProfile } = await supabase
          .from("profiles")
          .select("referral_code, referred_by, id")
          .ilike("email", cleanEmail)
          .maybeSingle();
        if (retryProfile) {
          // If we found it by email but ID didn't match, heal it
          await supabase
            .from("profiles")
            .update({ id: userId })
            .eq("email", cleanEmail);
          
          // Re-query to get updated model
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

    // 2. Count total referees (people referred by user)
    const { count: refereeCount, error: countErr } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("referred_by", userId);

    if (countErr) {
      console.error("Referee count error:", countErr.message);
    }

    // 3. Get completed referral rewards
    const { data: completedRefs, error: refsErr } = await supabase
      .from("referrals")
      .select("reward_amount")
      .eq("referrer_id", userId)
      .eq("status", "completed");

    if (refsErr) {
      console.error("Referrals rewards select error:", refsErr.message);
    }

    const totalEarned = (completedRefs || []).reduce((acc, curr) => acc + Number(curr.reward_amount || 0), 0);

    // 4. Get withdrawals history
    const { data: withdrawals, error: wErr } = await supabase
      .from("withdrawals")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (wErr) {
      console.error("Withdrawals select error:", wErr.message);
    }

    const totalWithdrawn = (withdrawals || [])
      .filter(w => w.status === "approved")
      .reduce((acc, curr) => acc + Number(curr.amount || 0), 0);

    const pendingWithdrawn = (withdrawals || [])
      .filter(w => w.status === "pending")
      .reduce((acc, curr) => acc + Number(curr.amount || 0), 0);

    // Balance is total earned minus both approved and pending withdrawals
    const balance = Math.max(0, totalEarned - totalWithdrawn - pendingWithdrawn);

    res.json({
      referral_code: profile.referral_code,
      referee_count: refereeCount || 0,
      balance: balance,
      total_withdrawn: totalWithdrawn,
      withdrawals: withdrawals || [],
    });
  } catch (err) {
    console.error("Referral stats error:", err.message);
    res.status(500).json({ error: "Failed to load referral statistics." });
  }
});

// ── SUBMIT WITHDRAWAL REQUEST ────────────────────────────────────────
router.post("/referrals/withdraw", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, bankName, accountName, accountNumber } = req.body;
    const withdrawAmt = parseInt(amount);

    if (!withdrawAmt || withdrawAmt < 1500) {
      return res.status(400).json({ error: "Minimum payout request is ₦1,500." });
    }

    if (!bankName || !accountNumber || !accountName) {
      return res.status(400).json({ error: "Bank details (Bank Name, Account Number, Account Name) are required." });
    }

    // Calculate current balance
    const { data: completedRefs } = await supabase
      .from("referrals")
      .select("reward_amount")
      .eq("referrer_id", userId)
      .eq("status", "completed");

    const totalEarned = (completedRefs || []).reduce((acc, curr) => acc + Number(curr.reward_amount || 0), 0);

    const { data: withdrawals } = await supabase
      .from("withdrawals")
      .select("*")
      .eq("user_id", userId);

    const totalWithdrawn = (withdrawals || [])
      .filter(w => w.status === "approved")
      .reduce((acc, curr) => acc + Number(curr.amount || 0), 0);

    const pendingWithdrawn = (withdrawals || [])
      .filter(w => w.status === "pending")
      .reduce((acc, curr) => acc + Number(curr.amount || 0), 0);

    const balance = Math.max(0, totalEarned - totalWithdrawn - pendingWithdrawn);

    if (withdrawAmt > balance) {
      return res.status(400).json({ error: "Insufficient wallet balance." });
    }

    // Insert new pending withdrawal
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
      console.error("Insertion error:", error.message);
      return res.status(500).json({ error: "Failed to submit withdrawal request." });
    }

    res.json({ message: "Withdrawal request submitted successfully.", withdrawal: data });
  } catch (err) {
    console.error("Submit withdrawal error:", err.message);
    res.status(500).json({ error: "Failed to submit withdrawal request." });
  }
});

module.exports = router;
