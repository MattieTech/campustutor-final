// ============================================================
// routes/upload.js — PDF & Image Upload & Storage
//
// This route handles file uploads (PDF and images) with storage.
// Here's what happens step-by-step:
//
// 1. Frontend sends a file via multipart/form-data (FormData)
// 2. Multer receives and temporarily stores the file in memory
// 3. File is validated (type, size)
// 4. For PDFs: extract text using pdf-parse
// 5. For Images: prepare for AI analysis (base64 encode)
// 6. Store file in Supabase Storage bucket
// 7. Save document record to Supabase database
// 8. Return success response with file metadata
//
// Routes defined here:
//   POST /api/upload/pdf     → Upload a PDF
//   POST /api/upload/image   → Upload an image (JPG, PNG, WEBP)
//   GET  /api/upload/my-docs → List user's uploaded documents
//   GET  /api/upload/my-activity → Get user's activity log
//   GET  /api/upload/:id     → Get single document (with content)
//   DELETE /api/upload/:id   → Delete a document
// ============================================================

const express = require("express");
const router = express.Router();
const multer = require("multer"); // Handles file uploads
const pdfParse = require("pdf-parse"); // Extracts text from PDFs
const supabase = require("../utils/supabase");
const authMiddleware = require("../middleware/authMiddleware");
const { awardXP, updateStreak } = require("../utils/xp");
const { warmDocumentStudyAssets } = require("./ai");

// ── MULTER CONFIGURATION ──────────────────────────────────────
// Multer handles multipart/form-data (the format used for file uploads)
// We use memoryStorage so the file stays in RAM (not saved to disk)
// This is perfect for serverless platforms like Vercel
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // Max 50MB per file
  },
  fileFilter: (req, file, cb) => {
    // Allow both PDF and image files
    const allowedMimes = [
      "application/pdf",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true); // Accept the file
    } else {
      cb(
        new Error(
          "Only PDF and image files (JPG, PNG, WEBP) are allowed!"
        ),
        false
      ); // Reject
    }
  },
});

// ── HELPER: Upload file to Supabase Storage ────────────────────
async function uploadFileToStorage(userId, file, fileType) {
  const fileName = `${userId}/${Date.now()}-${file.originalname}`;
  const bucketName = fileType === "pdf" ? "documents" : "images";

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

    // Get the public URL
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
    // Return null if storage fails — we'll still save metadata
    return null;
  }
}

// ── UPLOAD PDF ────────────────────────────────────────────────
// POST /api/upload/pdf
// Protected route — user must be logged in
// Frontend sends: FormData with a "pdf" field containing the file
router.post("/pdf", authMiddleware, upload.single("pdf"), async (req, res) => {
  try {
    // upload.single("pdf") puts the file into req.file
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file was uploaded." });
    }

    // Validate file type once more
    if (req.file.mimetype !== "application/pdf") {
      return res.status(400).json({ error: "Only PDF files are allowed!" });
    }

    const userId = req.user.id;
    const fileName = req.file.originalname;
    const fileBuffer = req.file.buffer; // The PDF as a Buffer (raw bytes)

    console.log(`📄 Processing PDF: ${fileName} for user ${userId}`);

    // ── STEP 1: Extract text from the PDF ────────────────────
    // pdf-parse reads the binary PDF data and gives us the text content
    let extractedText = "";
    let pageCount = 0;

    try {
      const pdfData = await pdfParse(fileBuffer);
      extractedText = pdfData.text;
      pageCount = pdfData.numpages || 0;
    } catch (pdfErr) {
      console.warn("⚠️  PDF parsing failed:", pdfErr.message);
      return res.status(400).json({
        error:
          "Could not read this PDF. It may be encrypted, scanned, or corrupted. Please try another PDF.",
      });
    }

    // Check if the PDF had any readable text
    if (!extractedText || extractedText.trim().length < 50) {
      return res.status(400).json({
        error:
          "This PDF appears to be a scanned image or has no readable text. Please use a text-based PDF.",
      });
    }

    // Limit text to ~15,000 characters to avoid Gemini token limits
    const truncatedText =
      extractedText.length > 15000
        ? extractedText.substring(0, 15000) + "\n\n[Document truncated...]"
        : extractedText;

    // ── STEP 2: Upload file to Supabase Storage ──────────────
    const fileStorageData = await uploadFileToStorage(userId, req.file, "pdf");

    // ── STEP 3: Save document record to Supabase ─────────────
    const { data: document, error: dbError } = await supabase
      .from("documents")
      .insert({
        user_id: userId,
        file_name: fileName,
        file_type: "pdf",
        file_path: fileStorageData?.path || null,
        extracted_text: truncatedText,
        page_count: pageCount,
        created_at: new Date().toISOString(),
      })
      .select() // Return the inserted row
      .single();

    if (dbError) {
      console.error("Database error:", dbError.message);
      return res
        .status(500)
        .json({ error: "Failed to save document to database." });
    }

    // ── STEP 4: Return success immediately ────────────────────
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
        extractedText: truncatedText, // Send text back so frontend can display it
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
// POST /api/upload/image
// Protected route — user must be logged in
// Frontend sends: FormData with an "image" field containing the file
// Supported: JPG, JPEG, PNG, WEBP
router.post(
  "/image",
  authMiddleware,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file was uploaded." });
      }

      // Validate file type
      const allowedImageTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
      if (!allowedImageTypes.includes(req.file.mimetype)) {
        return res
          .status(400)
          .json({
            error:
              "Only JPG, JPEG, PNG, and WEBP images are allowed!",
          });
      }

      const userId = req.user.id;
      const fileName = req.file.originalname;
      const fileBuffer = req.file.buffer;

      console.log(`📸 Processing image: ${fileName} for user ${userId}`);

      // ── STEP 1: Prepare image for AI analysis (base64 encode) ─
      const base64Image = fileBuffer.toString("base64");

      // ── STEP 2: Upload image to Supabase Storage ─────────────
      const fileStorageData = await uploadFileToStorage(userId, req.file, "image");

      // ── STEP 3: Save document record to Supabase ─────────────
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
        return res
          .status(500)
          .json({ error: "Failed to save image to database." });
      }

      // ── STEP 4: Return success immediately ────────────────────
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
          base64: base64Image, // Include base64 for AI analysis if needed
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
// GET /api/upload/my-docs
// Returns all documents uploaded by the logged-in user
router.get("/my-docs", authMiddleware, async (req, res) => {
  try {
    const { data: documents, error } = await supabase
      .from("documents")
      .select("id, file_name, page_count, created_at") // Don't send full text (too large)
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false }); // Newest first

    if (error) {
      return res.status(500).json({ error: "Failed to fetch documents." });
    }

    res.json({ documents: documents || [] });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch documents." });
  }
});

// ── GET USER'S ACTIVITY LOG ────────────────────────────────────
// GET /api/upload/my-activity
// Returns the user's activity history (uploads, AI generations, etc.)
router.get("/my-activity", authMiddleware, async (req, res) => {
  try {
    const { data: activities, error } = await supabase
      .from("user_activity")
      .select("id, action, details, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50); // Last 50 activities

    if (error) {
      if (error.message.includes("does not exist")) {
        // user_activity table doesn't exist yet — return empty list
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
    res.json({ activities: [], total: 0 }); // Return empty instead of error
  }
});

// ── GET SINGLE DOCUMENT ───────────────────────────────────────
// GET /api/upload/:id
// Returns a single document (including text) for re-processing
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { data: document, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id) // Security: only fetch OWN documents
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
// DELETE /api/upload/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.id); // Security: only delete OWN documents

    if (error) {
      return res.status(500).json({ error: "Failed to delete document." });
    }

    res.json({ message: "Document deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete document." });
  }
});

// ── GET USER STATS ────────────────────────────────────────────
// GET /api/upload/stats
// Returns user's XP, level, streak, and achievements
router.get("/stats/:userId", authMiddleware, async (req, res) => {
  try {
    const { getUserStats } = require("../utils/xp");
    const userId = req.params.userId;
    
    // Security: users can only fetch their own stats
    if (userId !== req.user.id) {
      return res.status(403).json({ error: "Cannot view other users' stats." });
    }

    const stats = await getUserStats(userId);
    if (!stats) {
      return res.status(500).json({ error: "Failed to fetch stats." });
    }

    res.json(stats);
  } catch (err) {
    console.error("Stats fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch stats." });
  }
});

// ── GET USER'S AI RESULTS (for history page) ──────────────────────
// GET /api/upload/my-results
// Returns all AI-generated results (summaries, flashcards, etc.)
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
      .limit(100); // Last 100 results

    if (error) {
      if (error.message.includes("does not exist")) {
        // ai_results table doesn't exist yet — return empty list
        return res.json({ results: [], total: 0 });
      }
      console.log("AI results fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch AI results." });
    }

    // Group results by document for easier frontend processing
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
    res.json({ results: [], total: 0 }); // Return empty instead of error
  }
});

module.exports = router;
