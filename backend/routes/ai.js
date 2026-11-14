// ============================================================
// routes/ai.js — CampusTutor AI-Powered Study & Academic Tools
// ============================================================

const express = require("express");
const router = express.Router();
const multer = require("multer");
const pdfParse = require("pdf-parse");
const officeParser = require("officeparser");
const { askGemini, ocrScannedPDF, extractTextFromImage } = require("../utils/gemini");
const supabase = require("../utils/supabase");
const authMiddleware = require("../middleware/authMiddleware");
const subscriptionMiddleware = require("../middleware/subscriptionMiddleware");
const { awardXP, updateStreak } = require("../utils/xp");
const { deductCoins, addCoins } = require("../utils/coins");
const { evaluateToolAccess, recordToolUsage, withUserLock } = require("../utils/usageService");

const fileExtractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// Helper: fetch document text from Supabase and verify ownership
async function getDocumentText(documentId, userId) {
  const { data, error } = await supabase
    .from("documents")
    .select("extracted_text, file_name, page_count, file_type")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("Document not found or access denied.");
  }

  return data;
}

async function saveAIResult(documentId, userId, resultType, content) {
  await supabase.from("ai_results").upsert(
    {
      document_id: documentId,
      user_id: userId,
      result_type: resultType,
      content,
      created_at: new Date().toISOString(),
    },
    { onConflict: "document_id,result_type" }
  );
}

function normalizeSummaryLevel(summarySize) {
  if (summarySize === undefined || summarySize === null || summarySize === "") return 1;
  const s = String(summarySize).trim().toLowerCase();
  if (s === "1" || s === "standard") return 1;
  if (s === "2" || s === "detailed") return 2;
  if (s === "3" || s === "comprehensive") return 3;
  const num = Number(summarySize);
  if (Number.isFinite(num) && num >= 1 && num <= 3) return Math.round(num);
  return 1;
}

function buildSummaryPrompt(doc, level = 1) {
  const depthConfig = {
    1: {
      label: "Standard Overview",
      instructions:
        "Generate a clean, concise, high-yield textbook overview highlighting the core topic, key definitions, and essential takeaways. Keep sections focused and easy to scan quickly.",
    },
    2: {
      label: "Detailed Study Summary",
      instructions:
        "Generate a thorough, multi-section academic breakdown covering every major topic, supporting explanations, examples, formulas, and conceptual links. Include a dedicated Exam Revision Checklist.",
    },
    3: {
      label: "Comprehensive Textbook Master Summary",
      instructions:
        "Generate an exhaustive, university-textbook-grade master dossier covering every concept, sub-topic, technical nuance, formula derivation, worked example, edge case, and cross-topic synthesis.",
    },
  };
  const depth = depthConfig[level] || depthConfig[1];

  return `
You are CampusTutor AI, a premium academic assistant.

Lecture notes from "${doc.file_name}":
---
${doc.extracted_text}
---
Requested Depth: ${depth.label}
Requirement: ${depth.instructions}

IMPORTANT: Format ALL mathematical expressions using LaTeX ($...$ for inline, $$...$$ for display).

Format your response like this:
## 📋 Summary of "${doc.file_name}"

**Main Topic:** [1-sentence overview]

### 📖 Core Technical Overview
[Use clear markdown headings (###, ####) and bullet points to break down the material.]

${level >= 2 ? "### 🔗 Key Concepts & Relationships\n[Explain how major ideas connect and contrast.]\n" : ""}
${level >= 3 ? "### 🧪 Worked Examples & Exam Traps\n[Include key applications, derivations, and common exam pitfalls.]\n" : ""}

**Core Takeaway:** [2-3 sentences on what this is really about]

Use clear, student-friendly academic English.
  `.trim();
}

function estimateDocumentPages(doc) {
  const explicitPages = Number(doc.page_count || 0);
  if (explicitPages > 0) return explicitPages;
  const textLength = (doc.extracted_text || "").length;
  return Math.max(1, Math.ceil(textLength / 3500));
}

function splitDocumentIntoChunks(doc, chunkPageSpan = 5) {
  const text = (doc.extracted_text || "").trim();
  if (!text) {
    return [{ index: 0, rangeLabel: "Pages 1-1", text: "" }];
  }

  const estimatedPages = estimateDocumentPages(doc);
  const markerRegex = /(\n|^)(?:\s*page\s+)(\d+)(?::|-)?/gi;
  const markerMatches = [...text.matchAll(markerRegex)];

  if (markerMatches.length >= 3) {
    const pageSections = [];
    for (let i = 0; i < markerMatches.length; i++) {
      const currentMatch = markerMatches[i];
      const nextMatch = markerMatches[i + 1];
      const pageNumber = Number(currentMatch[2]);
      const sectionStart = currentMatch.index || 0;
      const sectionEnd = nextMatch ? nextMatch.index || text.length : text.length;
      pageSections.push({
        pageNumber,
        text: text.substring(sectionStart, sectionEnd).trim(),
      });
    }

    const grouped = [];
    for (let i = 0; i < pageSections.length; i += chunkPageSpan) {
      const subset = pageSections.slice(i, i + chunkPageSpan);
      const firstPage = subset[0]?.pageNumber || 1;
      const lastPage = subset[subset.length - 1]?.pageNumber || firstPage;
      grouped.push({
        index: grouped.length,
        rangeLabel: `Pages ${firstPage}-${lastPage}`,
        text: subset.map((s) => s.text).join("\n\n").trim(),
      });
    }

    return grouped.filter((chunk) => chunk.text.length > 0);
  }

  const maxCharsPerPage = 3200;
  const estimatedTotalCharsPerChunk = Math.max(7000, chunkPageSpan * maxCharsPerPage);
  const chunks = [];

  for (let cursor = 0; cursor < text.length; cursor += estimatedTotalCharsPerChunk) {
    const rawSlice = text.substring(cursor, cursor + estimatedTotalCharsPerChunk);
    const pageStart = Math.floor(cursor / maxCharsPerPage) + 1;
    const pageEnd = Math.min(
      estimatedPages,
      Math.max(pageStart, Math.ceil((cursor + rawSlice.length) / maxCharsPerPage))
    );
    chunks.push({
      index: chunks.length,
      rangeLabel: `Pages ${pageStart}-${pageEnd}`,
      text: rawSlice.trim(),
    });
  }

  return chunks.filter((chunk) => chunk.text.length > 0);
}

function calculateQuestionTargetsWithSize(quizSize) {
  const total = Math.max(5, Math.min(50, Math.round(Number(quizSize) || 10)));
  if (total === 10) return { mcqCount: 8, shortCount: 0, essayCount: 2 };
  if (total === 15) return { mcqCount: 10, shortCount: 3, essayCount: 2 };
  if (total === 20) return { mcqCount: 14, shortCount: 4, essayCount: 2 };
  if (total === 30) return { mcqCount: 20, shortCount: 8, essayCount: 2 };
  if (total === 40) return { mcqCount: 25, shortCount: 11, essayCount: 4 };
  if (total === 50) return { mcqCount: 30, shortCount: 15, essayCount: 5 };

  const mcqCount = Math.max(3, Math.round(total * 0.65));
  const essayCount = Math.max(1, Math.round(total * 0.1));
  const shortCount = Math.max(0, total - mcqCount - essayCount);
  return { mcqCount, shortCount, essayCount };
}

function calculateFlashcardTarget(doc) {
  const pages = estimateDocumentPages(doc);
  const textLength = (doc.extracted_text || "").length;

  if (pages >= 25 || textLength >= 90000) return 60;
  if (pages >= 14 || textLength >= 50000) return 50;
  if (pages >= 7 || textLength >= 23000) return 40;
  return 25;
}

function safeExtractJSON(rawResponse) {
  const cleaned = String(rawResponse || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");

  const canUseObject = objectStart !== -1 && objectEnd > objectStart;
  const canUseArray = arrayStart !== -1 && arrayEnd > arrayStart;

  if (!canUseObject && !canUseArray) {
    throw new Error("No JSON object or array found in model response.");
  }

  const jsonStr = canUseObject && (!canUseArray || objectStart < arrayStart)
    ? cleaned.substring(objectStart, objectEnd + 1)
    : cleaned.substring(arrayStart, arrayEnd + 1);

  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    // Sanitize trailing commas and unescaped LaTeX backslashes inside JSON strings
    const sanitized = jsonStr
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/\\(?=(?:frac|theta|tau|times|text|right|rho|beta|bar|binom|nabla|nu|neq|leq|geq|approx|sqrt|int|sum|prod|lim|infty|alpha|gamma|delta|Delta|lambda|sigma|omega|Omega|pi|mu|phi|psi))/g, "\\\\")
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    return JSON.parse(sanitized);
  }
}

function dedupeByQuestion(items = []) {
  const seen = new Set();
  return items.filter((entry) => {
    const key = String(entry?.question || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeByFront(items = []) {
  const seen = new Set();
  return items.filter((entry) => {
    const key = String(entry?.front || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildChunkSummaryPrompt(doc, chunk, index, totalChunks) {
  return `
You are CampusTutor AI, a premium academic assistant.

You are processing chunk ${index + 1} of ${totalChunks} from "${doc.file_name}".
Source range: ${chunk.rangeLabel}

Lecture chunk:
---
${chunk.text}
---

Generate a precise technical summary for this chunk only.
Use compact structure with headings and bullet points.
IMPORTANT: Format all mathematical expressions using LaTeX ($...$ for inline, $$...$$ for display).

Output markdown only.
  `.trim();
}

function buildFinalSummaryPrompt(doc, partialSummaries, level = 1) {
  const extraSections =
    level >= 3
      ? "### 🧪 Worked Applications & Deep Nuances\n[Provide detailed derivations, examples, and exam traps.]\n\n"
      : "";
  return `
You are CampusTutor AI, a premium academic assistant.

You are given chunk-level summaries for "${doc.file_name}".
Combine them into one ${level === 3 ? "comprehensive textbook-grade" : level === 2 ? "detailed" : "concise, high-yield"} summary.

Chunk summaries:
---
${partialSummaries.join("\n\n---\n\n")}
---

Output format:
## 📋 Summary of "${doc.file_name}"

**Main Topic:** [1-sentence overview]

### 📖 Core Technical Overview
[Use clean technical sections and bullets. Preserve full conceptual coverage.]

### 🧠 Concept Relationships
[Show how major ideas connect across the document.]

${extraSections}### 🎯 Exam-Focused Takeaways
[High-yield revision points likely to be tested.]

**Core Takeaway:** [2-3 sentences]

IMPORTANT: Format all mathematical expressions using LaTeX ($...$ for inline, $$...$$ for display).
Keep language clear for university students.
  `.trim();
}

function buildQuestionsPrompt(chunk, allocation, contextMeta) {
  const prompt = `
You are CampusTutor AI, a university exam setter creating a revision quiz pool.

Document context: "${contextMeta.fileName}" | ${chunk.rangeLabel} | chunk ${contextMeta.chunkIndex + 1} of ${contextMeta.totalChunks}

Based on these lecture notes:
---
${chunk.text}
---

Generate a high-yield interactive revision quiz.
Required Volumes:
- Multiple Choice Questions (MCQs): ${allocation.mcqCount} (Include 4 distinct options A, B, C, D)
- Short Answer Questions: ${allocation.shortCount} (Include modelAnswer and detailed gradingCriteria)
- Essay Questions: ${allocation.essayCount} (Broad synthesis questions with keyPoints)

IMPORTANT: Format ALL mathematical expressions using LaTeX ($...$ for inline, $$...$$ for display).
Escape all backslashes properly inside JSON strings (e.g., "\\\\frac{a}{b}").

You MUST return the output as a valid JSON object only. No markdown code blocks.
JSON Structure:
{
  "mcqs": [
    {
      "question": "...",
      "options": {"A": "...", "B": "...", "C": "...", "D": "..."},
      "correctAnswer": "A",
      "explanation": "..."
    }
  ],
  "shortAnswer": [
    {
      "question": "...",
      "modelAnswer": "...",
      "gradingCriteria": "...",
      "explanation": "..."
    }
  ],
  "essays": [
    {
      "question": "...",
      "keyPoints": ["Point 1", "Point 2"]
    }
  ]
}`.trim();

  return { prompt };
}

function buildFlashcardsPrompt(chunk, targetCount, contextMeta) {
  const prompt = `Create exactly ${targetCount} high-yield, conceptually dense study flashcards from this text covering key terminologies and concepts. Return ONLY a JSON array - no markdown, no code blocks.

Document context: "${contextMeta.fileName}" | ${chunk.rangeLabel} | chunk ${contextMeta.chunkIndex + 1} of ${contextMeta.totalChunks}

Text to extract from:
---
${chunk.text}
---

Return valid JSON array ONLY (start with [ end with ]):
[{"id":1,"front":"Question?","back":"Answer","category":"Topic"},{"id":2,"front":"Question?","back":"Answer","category":"Topic"}]

Rules:
- Generate exactly ${targetCount} flashcards with id, front, back, category
- Format ALL mathematical expressions using LaTeX delimiters ($...$ inline, $$...$$ display) and escape backslashes properly in JSON
- Keep answers concise and clear
- Valid JSON format only

Generate:`.trim();

  return { prompt, targetCount };
}

async function generateSummaryForDocument(documentId, userId, options = {}) {
  const { persist = true, log = true, award = true, summarySize = 1 } = options;
  const level = normalizeSummaryLevel(summarySize);
  const doc = await getDocumentText(documentId, userId);
  const chunks = splitDocumentIntoChunks(doc, 5).slice(0, 6);

  const partialSummaryPromises = chunks.map(async (chunk, i) => {
    const chunkPrompt = buildChunkSummaryPrompt(doc, chunk, i, chunks.length);
    const partial = await askGemini(chunkPrompt);
    return `### ${chunk.rangeLabel}\n${partial}`;
  });
  const partialSummaries = await Promise.all(partialSummaryPromises);

  const finalPrompt =
    partialSummaries.length > 1
      ? buildFinalSummaryPrompt(doc, partialSummaries, level)
      : buildSummaryPrompt({ ...doc, extracted_text: chunks[0]?.text || doc.extracted_text }, level);
  const summary = await askGemini(finalPrompt);

  if (persist) {
    await saveAIResult(documentId, userId, "summary", summary);
  }

  if (log) {
    await logUserActivity(userId, "ai_summarize", `Generated summary (depth ${level}) | Document: "${doc.file_name}"`);
  }

  if (award) {
    try {
      await awardXP(userId, "ai_summarize", { document: doc.file_name, documentId });
      await updateStreak(userId);
    } catch (_) {}
  }

  return { summary, doc, level };
}

async function generateQuestionsForDocument(documentId, userId, options = {}) {
  const { persist = true, log = true, award = true, quizSize = 10 } = options;
  const doc = await getDocumentText(documentId, userId);
  const targets = calculateQuestionTargetsWithSize(quizSize);
  const chunks = splitDocumentIntoChunks(doc, 5).slice(0, 5);

  const perChunkAllocation = chunks.map((_, index) => {
    const chunkCount = chunks.length;
    const alloc = {
      mcqCount: Math.floor(targets.mcqCount / chunkCount),
      shortCount: Math.floor(targets.shortCount / chunkCount),
      essayCount: Math.floor(targets.essayCount / chunkCount),
    };

    if (index < targets.mcqCount % chunkCount) alloc.mcqCount += 1;
    if (index < targets.shortCount % chunkCount) alloc.shortCount += 1;
    if (index < targets.essayCount % chunkCount) alloc.essayCount += 1;

    return alloc;
  });

  const merged = { mcqs: [], shortAnswer: [], essays: [] };

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const allocation = perChunkAllocation[i];
    if (!allocation || allocation.mcqCount + allocation.shortCount + allocation.essayCount <= 0) continue;

    const { prompt } = buildQuestionsPrompt(chunk, allocation, {
      fileName: doc.file_name,
      chunkIndex: i,
      totalChunks: chunks.length,
    });

    try {
      const rawResponse = await askGemini(prompt);
      const chunkData = safeExtractJSON(rawResponse);
      if (chunkData) {
        merged.mcqs.push(...(Array.isArray(chunkData.mcqs) ? chunkData.mcqs : []));
        merged.shortAnswer.push(...(Array.isArray(chunkData.shortAnswer) ? chunkData.shortAnswer : []));
        merged.essays.push(...(Array.isArray(chunkData.essays) ? chunkData.essays : []));
      }
    } catch (parseErr) {
      console.error("❌ Questions parsing error for chunk", i + 1, parseErr.message);
    }
  }

  const questionsData = {
    mcqs: dedupeByQuestion(merged.mcqs).slice(0, targets.mcqCount),
    shortAnswer: dedupeByQuestion(merged.shortAnswer).slice(0, targets.shortCount),
    essays: dedupeByQuestion(merged.essays).slice(0, targets.essayCount),
  };

  if (!questionsData.mcqs.length && !questionsData.shortAnswer.length && !questionsData.essays.length) {
    try {
      const retryPrompt = `Return ONLY valid JSON with keys "mcqs" (array of {question, options:{A,B,C,D}, correctAnswer, explanation}) and "shortAnswer" (array of {question, modelAnswer, gradingCriteria}) based on:\n${doc.extracted_text.slice(0, 12000)}`;
      const retryRaw = await askGemini(retryPrompt);
      const retryData = safeExtractJSON(retryRaw);
      questionsData.mcqs = dedupeByQuestion(Array.isArray(retryData?.mcqs) ? retryData.mcqs : []).slice(0, targets.mcqCount);
      questionsData.shortAnswer = dedupeByQuestion(Array.isArray(retryData?.shortAnswer) ? retryData.shortAnswer : []).slice(0, targets.shortCount);
      questionsData.essays = dedupeByQuestion(Array.isArray(retryData?.essays) ? retryData.essays : []).slice(0, targets.essayCount);
    } catch (_) {}
  }

  if (!questionsData.mcqs.length && !questionsData.shortAnswer.length && !questionsData.essays.length) {
    throw new Error("Failed to generate structured quiz data. Please try again.");
  }

  if (persist) {
    await saveAIResult(documentId, userId, "questions", JSON.stringify(questionsData));
  }

  if (log) {
    await logUserActivity(
      userId,
      "ai_questions",
      `Generated ${questionsData.mcqs.length} MCQs, ${questionsData.shortAnswer.length} short answers, ${questionsData.essays.length} essays | Document: "${doc.file_name}"`
    );
  }

  if (award) {
    try {
      const totalQ = (questionsData.mcqs?.length || 0) + (questionsData.shortAnswer?.length || 0) + (questionsData.essays?.length || 0);
      await awardXP(userId, "ai_questions", { document: doc.file_name, count: totalQ, documentId });
      await updateStreak(userId);
    } catch (_) {}
  }

  return { questionsData, doc };
}

async function generateFlashcardsForDocument(documentId, userId, options = {}) {
  const { persist = true, log = true, award = true, flashcardSize } = options;
  const doc = await getDocumentText(documentId, userId);
  const targetCount = flashcardSize ? Number(flashcardSize) : calculateFlashcardTarget(doc);
  const chunks = splitDocumentIntoChunks(doc, 5).slice(0, 5);
  const perChunkTargets = chunks.map((_, index) => {
    const base = Math.floor(targetCount / chunks.length);
    return base + (index < targetCount % chunks.length ? 1 : 0);
  });

  const mergedCards = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkTarget = perChunkTargets[i];
    if (!chunkTarget) continue;

    const { prompt } = buildFlashcardsPrompt(chunk, chunkTarget, {
      fileName: doc.file_name,
      chunkIndex: i,
      totalChunks: chunks.length,
    });

    try {
      const rawResponse = await askGemini(prompt);
      const parsed = safeExtractJSON(rawResponse);
      if (Array.isArray(parsed)) {
        mergedCards.push(...parsed);
      }
    } catch (parseErr) {
      console.error("❌ Flashcards parsing error for chunk", i + 1, parseErr.message);
    }
  }

  const flashcards = dedupeByFront(mergedCards)
    .slice(0, targetCount)
    .map((card, idx) => ({
      id: idx + 1,
      front: String(card.front || "").trim().substring(0, 260),
      back: String(card.back || "").trim().substring(0, 600),
      category: String(card.category || "General").trim(),
    }));

  if (!flashcards.length) {
    throw new Error("Could not parse flashcards. Please try again with a different document.");
  }

  if (persist) {
    await saveAIResult(documentId, userId, "flashcards", JSON.stringify(flashcards));
  }

  if (log) {
    await logUserActivity(userId, "ai_flashcards", `Generated ${flashcards.length} flashcards | Document: "${doc.file_name}"`);
  }

  if (award) {
    try {
      await awardXP(userId, "ai_flashcards", { document: doc.file_name, count: flashcards.length, documentId });
      await updateStreak(userId);
    } catch (_) {}
  }

  return { flashcards, doc };
}

async function warmDocumentStudyAssets(documentId, userId) {
  return Promise.allSettled([
    generateSummaryForDocument(documentId, userId, { persist: true, log: false, award: false }),
    generateFlashcardsForDocument(documentId, userId, { persist: true, log: false, award: false }),
    generateQuestionsForDocument(documentId, userId, { persist: true, log: false, award: false }),
  ]);
}

async function logUserActivity(userId, action, details) {
  try {
    await supabase.from("user_activity").insert({
      user_id: userId,
      action,
      details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.log("Note: Could not log activity:", err.message);
  }
}

function handleAIError(err, res) {
  if (err.message?.includes("busy") || err.message?.includes("routes")) {
    return res.status(503).json({
      error: "CampusTutor AI is experiencing high traffic right now. Please wait a few seconds and retry.",
    });
  }
  if (err.status === 429 || err.message?.includes("quota")) {
    return res.status(429).json({
      error: "CampusTutor AI rate limit reached temporarily. Please wait a moment and try again.",
    });
  }
  if (err.status === 404 || err.message?.includes("not found")) {
    return res.status(404).json({
      error: err.message || "Requested document or resource was not found.",
    });
  }
  res.status(500).json({ error: err.message || "Failed to process your request." });
}

// Require authentication + subscription/plan resolution for all AI routes
router.use(authMiddleware);
router.use(subscriptionMiddleware);

// Helper: execute any usage-managed & optionally coin-gated AI tool safely
async function executeManagedTool(req, res, {
  toolKey,
  actionType,
  description,
  activityDetails,
  prompt,
  buildResponse,
}) {
  const userId = req.user.id;
  const useCoins = Boolean(req.body?.useCoins);

  const access = await withUserLock(userId, () =>
    evaluateToolAccess({
      userId,
      plan: req.effectivePlan,
      coins: req.userCoins,
      isAdmin: req.isAdmin,
      toolKey,
      useCoins,
    })
  );

  if (!access.allowed) {
    return res.status(access.statusCode || 403).json(access.errorPayload);
  }

  let deductedCoins = 0;
  let updatedBalance = req.userCoins;

  if (access.chargeCoins > 0) {
    const coinRes = await deductCoins(userId, access.chargeCoins, actionType, description, req.user);
    if (!coinRes.success) {
      return res.status(403).json({
        error: coinRes.error || `${access.chargeCoins} CampusCoins required.`,
        insufficientCoins: true,
        needCoins: true,
        needed: access.chargeCoins,
        currentCoins: coinRes.currentCoins ?? req.userCoins ?? 0,
      });
    }
    deductedCoins = access.chargeCoins;
    updatedBalance = coinRes.coins;
  }

  let output;
  try {
    output = await askGemini(prompt);
  } catch (aiErr) {
    if (deductedCoins > 0) {
      await addCoins(
        userId,
        deductedCoins,
        "coin_refund",
        `Automatic refund for failed ${actionType}`,
        req.user,
        { transactionType: "refund", reason: aiErr.message }
      ).catch(() => {});
    }
    throw aiErr;
  }

  await Promise.allSettled([
    recordToolUsage(userId, toolKey),
    logUserActivity(userId, actionType, activityDetails),
    awardXP(userId, actionType, { description }),
    updateStreak(userId),
  ]);

  return res.json({
    success: true,
    ...buildResponse(output),
    coinsCharged: deductedCoins,
    coinsRemaining: deductedCoins > 0 ? updatedBalance : req.userCoins,
    plan: req.effectivePlan,
  });
}

// ── EXTRACT TEXT FROM ATTACHED FILE (For Academic Tools Page) ─
router.post("/extract-file-text", fileExtractUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }
    const ext = (req.file.originalname || "").split(".").pop().toLowerCase();
    const mime = req.file.mimetype || "";
    let extractedText = "";

    if (ext === "doc" && mime === "application/msword") {
      return res.status(400).json({
        error: "Legacy binary .doc files are not supported. Please save as .docx, .pdf, or .txt and upload again.",
      });
    }

    if (mime === "application/pdf" || ext === "pdf") {
      try {
        const pdfData = await pdfParse(req.file.buffer);
        extractedText = pdfData.text || "";
      } catch (_) {}
      if (!extractedText || extractedText.trim().length < 40) {
        extractedText = await ocrScannedPDF(req.file.buffer);
      }
    } else if (mime === "text/plain" || ext === "txt") {
      extractedText = req.file.buffer.toString("utf-8");
    } else if (["docx", "pptx", "ppt"].includes(ext) || mime.includes("officedocument")) {
      const ast = await officeParser.parseOffice(req.file.buffer);
      extractedText = typeof ast === "string" ? ast : typeof ast?.toText === "function" ? ast.toText() : String(ast || "");
    } else if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "webp"].includes(ext)) {
      extractedText = await extractTextFromImage(req.file.buffer, mime || "image/jpeg");
    } else {
      return res.status(400).json({ error: "Unsupported file format. Please upload PDF, DOCX, PPTX, TXT, or an image." });
    }

    if (!extractedText || !extractedText.trim()) {
      return res.status(400).json({ error: "No readable text could be extracted from the attached file." });
    }

    const finalText = extractedText.trim().slice(0, 60000);
    res.json({
      success: true,
      fileName: req.file.originalname,
      text: finalText,
      extractedText: finalText,
      charCount: finalText.length,
    });
  } catch (err) {
    console.error("Extract file text error:", err.message);
    res.status(400).json({ error: err.message || "Failed to read attached file." });
  }
});

// ── EXPLAIN CONCEPT ───────────────────────────────────────────
router.post("/explain", async (req, res) => {
  try {
    const { documentId, concept } = req.body;
    const userId = req.user.id;

    if (!concept || !String(concept).trim()) {
      return res.status(400).json({ error: "Concept or question is required." });
    }

    const cleanConcept = String(concept).trim();
    if (cleanConcept.length > 4000) {
      return res.status(400).json({ error: "Concept query is too long (maximum 4,000 characters)." });
    }

    const access = await withUserLock(userId, () =>
      evaluateToolAccess({
        userId,
        plan: req.effectivePlan,
        coins: req.userCoins,
        isAdmin: req.isAdmin,
        toolKey: "explain",
        useCoins: Boolean(req.body?.useCoins),
      })
    );

    if (!access.allowed) {
      return res.status(access.statusCode || 403).json(access.errorPayload);
    }

    let deductedCoins = 0;
    let updatedBalance = req.userCoins;
    if (access.chargeCoins > 0) {
      const coinRes = await deductCoins(userId, access.chargeCoins, "ai_explain", `Explained: "${cleanConcept.slice(0, 30)}"`, req.user);
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
      updatedBalance = coinRes.coins;
    }

    let doc = null;
    let docContext = "";
    if (documentId) {
      try {
        doc = await getDocumentText(documentId, userId);
        docContext = `A student is studying the following lecture notes:\n---\n${doc.extracted_text.slice(0, 25000)}\n---\n\n`;
      } catch (_) {}
    }

    const prompt = `
You are CampusTutor AI, a patient university lecturer who explains things clearly.

${docContext}The student wants you to explain this concept: "${cleanConcept}"

IMPORTANT: Format ALL mathematical expressions using LaTeX ($...$ for inline, $$...$$ for display). Never write math as plain text without delimiters.

Please structure your explanation cleanly:
## 💡 Explaining: "${cleanConcept}"

**Simple Definition:** [Clear, beginner-friendly explanation.]

**Real-World Example:** [A relatable analogy or everyday example]

**Mathematical Expression / Core Formula (if applicable):**
[Provide key equations in $$...$$ if the topic involves math or science; omit if purely non-mathematical.]

**How it relates to the notes:** ${docContext ? "[Connect it back to the uploaded lecture notes]" : "[General academic context and key applications]"}

**Quick Memory Trick:** [A practical tip to remember this concept]
    `.trim();

    let explanation;
    try {
      explanation = await askGemini(prompt);
    } catch (aiErr) {
      if (deductedCoins > 0) {
        await addCoins(userId, deductedCoins, "coin_refund", "Refund for failed explain request", req.user, {
          transactionType: "refund",
        }).catch(() => {});
      }
      throw aiErr;
    }

    await recordToolUsage(userId, "explain");

    if (doc && documentId) {
      await saveAIResult(documentId, userId, "explanation", explanation);
      await logUserActivity(userId, "ai_explain", `Asked: "${cleanConcept.slice(0, 60)}" | Document: "${doc.file_name}"`);
    } else {
      await logUserActivity(userId, "ai_explain", `Asked: "${cleanConcept.slice(0, 60)}" | General Concept`);
    }

    Promise.allSettled([
      awardXP(userId, "ai_explain", { concept: cleanConcept }),
      updateStreak(userId),
    ]).catch(() => {});

    res.json({
      success: true,
      explanation,
      content: explanation,
      coinsCharged: deductedCoins,
      coinsRemaining: deductedCoins > 0 ? updatedBalance : req.userCoins,
    });
  } catch (err) {
    console.error("Explain error:", err.message);
    handleAIError(err, res);
  }
});

// ── SUMMARIZE ─────────────────────────────────────────────────
router.post("/summarize", async (req, res) => {
  try {
    const { documentId, summarySize } = req.body;
    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    const userId = req.user.id;
    const requestedDepth = normalizeSummaryLevel(summarySize);

    const access = await withUserLock(userId, () =>
      evaluateToolAccess({
        userId,
        plan: req.effectivePlan,
        coins: req.userCoins,
        isAdmin: req.isAdmin,
        toolKey: "summarize",
        useCoins: Boolean(req.body?.useCoins),
      })
    );

    if (!access.allowed) {
      return res.status(access.statusCode || 403).json(access.errorPayload);
    }

    const maxDepth = req.isAdmin
      ? 3
      : Number(access.cfg?.extraConfig?.maxDepth?.[req.effectivePlan] ?? (req.effectivePlan === "pro" ? 3 : req.effectivePlan === "plus" ? 2 : 1));

    if (requestedDepth > maxDepth) {
      const neededPlan = requestedDepth >= 3 ? "PRO" : "PLUS";
      return res.status(403).json({
        error: `Summary depth level ${requestedDepth} requires ${neededPlan} Plan. Your ${req.effectivePlan.toUpperCase()} Plan supports up to depth ${maxDepth}.`,
        planRestricted: true,
        recommendedUpgrade: neededPlan.toLowerCase(),
      });
    }

    let deductedCoins = 0;
    if (access.chargeCoins > 0) {
      const coinRes = await deductCoins(userId, access.chargeCoins, "ai_summarize", `Generated summary`, req.user);
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

    let result;
    try {
      result = await generateSummaryForDocument(documentId, userId, { summarySize: requestedDepth });
    } catch (aiErr) {
      if (deductedCoins > 0) {
        await addCoins(userId, deductedCoins, "coin_refund", "Refund for failed summary", req.user, {
          transactionType: "refund",
        }).catch(() => {});
      }
      throw aiErr;
    }

    await recordToolUsage(userId, "summarize");
    res.json({ success: true, summary: result.summary, level: result.level });
  } catch (err) {
    console.error("Summarize error:", err.message);
    handleAIError(err, res);
  }
});

// ── REVISION QUESTIONS ────────────────────────────────────────
router.post("/questions", async (req, res) => {
  try {
    const documentId = req.body.documentId;
    const quizSize = req.body.quizSize ?? req.body.count;
    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    const userId = req.user.id;
    const requestedSize = Math.max(5, Math.min(50, Math.round(Number(quizSize) || 10)));

    const access = await withUserLock(userId, () =>
      evaluateToolAccess({
        userId,
        plan: req.effectivePlan,
        coins: req.userCoins,
        isAdmin: req.isAdmin,
        toolKey: "questions",
        useCoins: Boolean(req.body?.useCoins),
      })
    );

    if (!access.allowed) {
      return res.status(access.statusCode || 403).json(access.errorPayload);
    }

    const maxQuestions = req.isAdmin
      ? 50
      : Number(access.cfg?.extraConfig?.maxQuestions?.[req.effectivePlan] ?? (req.effectivePlan === "pro" ? 50 : req.effectivePlan === "plus" ? 40 : 15));

    if (requestedSize > maxQuestions) {
      const neededPlan = requestedSize > 40 ? "PRO" : "PLUS";
      return res.status(403).json({
        error: `Your ${req.effectivePlan.toUpperCase()} Plan supports up to ${maxQuestions} questions per quiz. Upgrade to ${neededPlan} for up to ${requestedSize} questions.`,
        planRestricted: true,
        recommendedUpgrade: neededPlan.toLowerCase(),
      });
    }

    let deductedCoins = 0;
    if (access.chargeCoins > 0) {
      const coinRes = await deductCoins(userId, access.chargeCoins, "ai_questions", `Generated ${requestedSize} quiz questions`, req.user);
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

    let result;
    try {
      result = await generateQuestionsForDocument(documentId, userId, { quizSize: requestedSize });
    } catch (aiErr) {
      if (deductedCoins > 0) {
        await addCoins(userId, deductedCoins, "coin_refund", "Refund for failed quiz generation", req.user, {
          transactionType: "refund",
        }).catch(() => {});
      }
      throw aiErr;
    }

    await recordToolUsage(userId, "questions");
    res.json({ success: true, questions: result.questionsData });
  } catch (err) {
    console.error("Questions error:", err.message);
    handleAIError(err, res);
  }
});

// ── FLASHCARDS ────────────────────────────────────────────────
router.post("/flashcards", async (req, res) => {
  try {
    const documentId = req.body.documentId;
    const flashcardSize = req.body.flashcardSize ?? req.body.count;
    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    const userId = req.user.id;
    const requestedCards = Math.max(5, Math.min(50, Math.round(Number(flashcardSize) || 10)));

    const access = await withUserLock(userId, () =>
      evaluateToolAccess({
        userId,
        plan: req.effectivePlan,
        coins: req.userCoins,
        isAdmin: req.isAdmin,
        toolKey: "flashcards",
        useCoins: Boolean(req.body?.useCoins),
      })
    );

    if (!access.allowed) {
      return res.status(access.statusCode || 403).json(access.errorPayload);
    }

    const maxCards = req.isAdmin
      ? 50
      : Number(access.cfg?.extraConfig?.maxCards?.[req.effectivePlan] ?? (req.effectivePlan === "pro" ? 50 : req.effectivePlan === "plus" ? 25 : 10));

    if (requestedCards > maxCards) {
      const neededPlan = requestedCards > 25 ? "PRO" : "PLUS";
      return res.status(403).json({
        error: `Your ${req.effectivePlan.toUpperCase()} Plan allows up to ${maxCards} flashcards per deck. Upgrade to ${neededPlan} for up to ${requestedCards} flashcards.`,
        planRestricted: true,
        recommendedUpgrade: neededPlan.toLowerCase(),
      });
    }

    let deductedCoins = 0;
    if (access.chargeCoins > 0) {
      const coinRes = await deductCoins(userId, access.chargeCoins, "ai_flashcards", `Generated ${requestedCards} flashcards`, req.user);
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

    let result;
    try {
      result = await generateFlashcardsForDocument(documentId, userId, { flashcardSize: requestedCards });
    } catch (aiErr) {
      if (deductedCoins > 0) {
        await addCoins(userId, deductedCoins, "coin_refund", "Refund for failed flashcards", req.user, {
          transactionType: "refund",
        }).catch(() => {});
      }
      throw aiErr;
    }

    await recordToolUsage(userId, "flashcards");
    res.json({ success: true, flashcards: result.flashcards });
  } catch (err) {
    console.error("Flashcards error:", err.message);
    handleAIError(err, res);
  }
});

// ── AI ASSIGNMENT & PROBLEM SOLVER ────────────────────────────
router.post("/solve-problem", async (req, res) => {
  try {
    const question = req.body.problemText || req.body.question || req.body.problem || req.body.text;
    const subject = req.body.subject || req.body.tone || "General Academic Problem";
    const detailLevel = req.body.focus || req.body.detailLevel || "Step-by-Step Working";
    const outputFormat = req.body.outputFormat || "Full Textbook Solution";

    if (!question || !String(question).trim() || String(question).trim().length < 5) {
      return res.status(400).json({ error: "Please provide a complete question or problem (at least 5 characters) to solve." });
    }

    const cleanQ = String(question).trim().slice(0, 20000);
    const prompt = `
You are CampusTutor AI Master Problem Solver.
Subject / Discipline: ${subject}
Detail Preference: ${detailLevel}
Output Style: ${outputFormat}

Problem to Solve:
"""
${cleanQ}
"""

Provide an exhaustive, crystal-clear, step-by-step academic solution.
Rules:
1. State the underlying concepts, theorems, laws, or formulas first.
2. Provide complete step-by-step mathematical working or conceptual derivation.
3. Box the final answer clearly: **Final Answer: ...**
4. Include an "Examiner Tip" explaining how university markers award points for this type of question.
5. Format ALL mathematical expressions in LaTeX ($...$ for inline, $$...$$ for display blocks).
6. If it is a coding problem, use properly fenced markdown code blocks.
`.trim();

    await executeManagedTool(req, res, {
      toolKey: "solve_problem",
      actionType: "solve_problem",
      description: `Solved: "${cleanQ.substring(0, 35)}..."`,
      activityDetails: `Problem Solver (${subject}): "${cleanQ.substring(0, 50)}"`,
      prompt,
      buildResponse: (solution) => ({ solution, content: solution }),
    });
  } catch (err) {
    console.error("Problem solver error:", err.message);
    handleAIError(err, res);
  }
});

// ── AI ESSAY & COURSEWORK POLISHER (Polisher / Paraphraser / Summarizer / Grammar) ─
router.post("/polish-essay", async (req, res) => {
  try {
    const text = req.body.draftText || req.body.text || req.body.draft;
    const citationStyle = req.body.style || req.body.citationStyle || "APA 7th Edition";
    const subMode = String(req.body.subMode || "polisher").toLowerCase();
    const tone = req.body.tone || req.body.lang || "Academic";
    const focus = req.body.focus || "Overall Quality";

    if (!text || String(text).trim().length < 30) {
      return res.status(400).json({ error: "Please provide an essay or draft with at least 30 characters." });
    }

    const cleanText = String(text).trim().slice(0, 40000);

    let modeInstruction = "";
    if (subMode === "paraphraser") {
      modeInstruction = `Paraphrase the entire excerpt into fresh, plagiarism-free ${tone} academic phrasing while preserving 100% of the factual meaning and technical terms.`;
    } else if (subMode === "summarizer") {
      modeInstruction = `Distill the excerpt into a high-density executive academic summary with key thesis points, supporting evidence, and core conclusions.`;
    } else if (subMode === "grammar") {
      modeInstruction = `Perform a strict line-by-line grammar, punctuation, syntax, and academic style audit, listing exact corrections and providing the clean corrected manuscript.`;
    } else {
      modeInstruction = `Conduct a rigorous academic polish focusing on **${focus}** in a **${tone}** voice:
1. **Academic Tone & Vocabulary Elevation**
2. **Structural Coherence & Thesis Strength**
3. **Originality & Citation Guidance**
4. **Polished Exemplar Version**
5. **Sample Citations (${citationStyle})**`;
    }

    const prompt = `
You are CampusTutor AI Academic Editor and University Professor.
Mode: ${subMode.toUpperCase()}
Preferred Tone: ${tone}
Focus Area: ${focus}
Citation Format: ${citationStyle}

Student Text:
"""
${cleanText}
"""

Task:
${modeInstruction}

Format cleanly in structured markdown with clear headings.
`.trim();

    await executeManagedTool(req, res, {
      toolKey: "polish_essay",
      actionType: "polish_essay",
      description: `Coursework ${subMode} (${citationStyle})`,
      activityDetails: `Coursework ${subMode} (${tone}, ${citationStyle})`,
      prompt,
      buildResponse: (review) => ({ review, polished: review, content: review }),
    });
  } catch (err) {
    console.error("Essay polish error:", err.message);
    handleAIError(err, res);
  }
});

// ── FINAL YEAR PROJECT & PROPOSAL ARCHITECT ───────────────────
router.post("/project-proposals", async (req, res) => {
  try {
    const field = req.body.field || req.body.department || "Computer Science / Engineering";
    const interests = req.body.interests || "Modern applied systems and AI";
    const level = req.body.level || "Undergraduate / BSc";
    const outputFormat = req.body.outputFormat || "Detailed Proposal Pack";

    if (!String(field).trim()) {
      return res.status(400).json({ error: "Please specify your department or field of study." });
    }

    const prompt = `
You are CampusTutor AI University Thesis Committee Chair and Academic Research Supervisor.
Degree Level: ${level}
Department / Field / Topic Input: ${String(field).trim().slice(0, 10000)}
Methodology Focus: ${interests}
Requested Format: ${outputFormat}

Generate 3 high-impact, committee-approvable, original thesis/final year project proposals.
For each project topic provide:
1. **Official Project Title**
2. **Background & Problem Statement**
3. **Research Objectives (Aim + 3 Specific Objectives)**
4. **Proposed Methodology & Tools/Tech Stack**
5. **Expected Deliverables & Academic Contribution**
6. **Supervisor Approval Probability & Feasibility Rating** (out of 10 with justification)

Format in rich markdown with clean section headers and dividers.
`.trim();

    await executeManagedTool(req, res, {
      toolKey: "project_proposals",
      actionType: "project_proposals",
      description: `Project proposals in ${String(field).slice(0, 35)}`,
      activityDetails: `Project Architect: ${String(field).slice(0, 40)} (${level})`,
      prompt,
      buildResponse: (proposals) => ({ proposals, content: proposals }),
    });
  } catch (err) {
    console.error("Project proposals error:", err.message);
    handleAIError(err, res);
  }
});

// ── VIVA & THESIS ORAL DEFENSE DRILL SIMULATOR ────────────────
router.post("/viva-defense", async (req, res) => {
  try {
    const projectTitle = req.body.projectTitle || req.body.title;
    const abstractText = req.body.abstract || req.body.text || "";
    const rigor = req.body.rigor || "Rigorous / Standard";
    const studyLevel = req.body.studyLevel || "Undergraduate Final Year";
    const outputFormat = req.body.outputFormat || "Full Defense Dossier";

    if (!projectTitle || String(projectTitle).trim().length < 5) {
      return res.status(400).json({ error: "Please provide your project/thesis title (at least 5 characters)." });
    }

    const prompt = `
You are a formidable, seasoned External University Examiner conducting a Project/Thesis Oral Defense (Viva Voce).
Project Title: "${String(projectTitle).trim()}"
Panel Rigor: ${rigor}
Study Level: ${studyLevel}
Requested Output: ${outputFormat}
${abstractText ? `Project Abstract / Scope:\n"""\n${String(abstractText).trim().slice(0, 20000)}\n"""` : ""}

Generate a high-stakes Oral Defense Preparation Dossier:
1. **The 5 Toughest Technical Questions** the panel will ask about methodology, limitations, and design trade-offs.
2. **Model High-Scoring Defense Responses** showing how to answer each tough question calmly and authoritatively.
3. **Trap Warning: 3 Things NEVER to say** during this defense.
4. **Confidence Checklist & 2-Minute Opening Pitch Script**.

Format in rich, highly structured markdown.
`.trim();

    await executeManagedTool(req, res, {
      toolKey: "viva_defense",
      actionType: "viva_defense",
      description: `Viva defense prep: "${String(projectTitle).substring(0, 30)}..."`,
      activityDetails: `Viva Defense (${studyLevel}): "${String(projectTitle).trim().substring(0, 50)}"`,
      prompt,
      buildResponse: (defenseDossier) => ({ defenseDossier, content: defenseDossier }),
    });
  } catch (err) {
    console.error("Viva defense error:", err.message);
    handleAIError(err, res);
  }
});

// ── EXAM PAST QUESTIONS & HIGH-PROBABILITY PREDICTOR ──────────
router.post("/predict-past-questions", async (req, res) => {
  try {
    const courseCode = req.body.courseCode || req.body.course || "";
    const syllabusOrTopics = req.body.syllabus || req.body.topics || "";
    const examStyle = req.body.examStyle || "Standard University Exam";
    const level = req.body.level || "University Undergraduate";
    const focus = req.body.outputFormat || "Comprehensive Exam Pack";

    if (!courseCode || String(courseCode).trim().length < 2) {
      return res.status(400).json({ error: "Please provide the course code or title (e.g. MTH101, CSC302)." });
    }

    const prompt = `
You are CampusTutor AI Chief University Examination Board Predictor.
Course Code / Title: "${String(courseCode).trim()}"
Exam Style: ${examStyle} | Level: ${level} | Focus: ${focus}
${syllabusOrTopics ? `Lecture Topics / Key Themes:\n"""\n${String(syllabusOrTopics).trim().slice(0, 25000)}\n"""` : ""}

Generate a high-probability "Exam Master Dossier" based on standard university examination patterns:
1. **Top 5 High-Probability Theoretical / Essay Questions** with detailed marking guide points.
2. **Top 5 Critical Calculation / Problem Questions** with full step-by-step model workings and standard formulas in LaTeX ($...$ or $$...$$).
3. **10 CBT Rapid-Fire Practice MCQs** with correct options and brief explanations.
4. **"Lecturer's Trap Alert":** 3 areas where students commonly lose marks in this course.

Format in clean, high-density markdown.
`.trim();

    await executeManagedTool(req, res, {
      toolKey: "exam_predict",
      actionType: "exam_predict",
      description: `Exam predictions: ${String(courseCode).slice(0, 35)}`,
      activityDetails: `Exam Predictor (${examStyle}): ${String(courseCode).trim().substring(0, 40)}`,
      prompt,
      buildResponse: (predictionDossier) => ({ predictionDossier, content: predictionDossier }),
    });
  } catch (err) {
    console.error("Exam predictor error:", err.message);
    handleAIError(err, res);
  }
});

// ── AI TURNITIN PLAGIARISM BYPASSER & HUMANIZER ────────────────
router.post("/humanize-rewrite", async (req, res) => {
  try {
    const rawText = req.body.text || req.body.draftText || "";
    const voice = req.body.voice || "Undergraduate Natural";
    const originalityGoal = req.body.originalityGoal || "Turnitin Zero Detection";
    const languageStyle = req.body.languageStyle || "Global Academic English";

    if (!rawText || String(rawText).trim().length < 40) {
      return res.status(400).json({ error: "Please provide at least 40 characters of text to humanize." });
    }

    const cleanText = String(rawText).trim().slice(0, 40000);
    const prompt = `
You are CampusTutor AI Academic Writing Stylist and Originality Specialist.
Voice Profile: ${voice}
Originality Target: ${originalityGoal}
Language Variant: ${languageStyle}

Text to Humanize & De-Cliché:
"""
${cleanText}
"""

Task:
1. Rewrite this excerpt completely to sound authentic, deeply human, and academically credible.
2. Remove robotic AI clichés (e.g. "delve", "testament to", "it is crucial to note", "tapestry", "in conclusion").
3. Vary sentence cadence and structure naturally while preserving all technical meanings, data points, and citations faithfully.
4. Provide:
   - **Originality & Natural Cadence Assessment**
   - **The Fully Humanized, Submission-Ready Rewrite**
   - **Key Stylistic Transformations Applied**

Format cleanly in markdown.
`.trim();

    await executeManagedTool(req, res, {
      toolKey: "humanize_rewrite",
      actionType: "humanize_rewrite",
      description: "Turnitin humanizer & originality rewrite",
      activityDetails: `Academic Humanizer (${cleanText.split(/\s+/).length} words, ${voice})`,
      prompt,
      buildResponse: (humanizedResult) => ({ humanizedResult, content: humanizedResult }),
    });
  } catch (err) {
    console.error("Humanize rewrite error:", err.message);
    handleAIError(err, res);
  }
});

// ── GET SAVED RESULTS ─────────────────────────────────────────
router.get("/results/:documentId", async (req, res) => {
  try {
    const { data: results, error } = await supabase
      .from("ai_results")
      .select("result_type, content, created_at")
      .eq("document_id", req.params.documentId)
      .eq("user_id", req.user.id);

    if (error) {
      return res.status(500).json({ error: "Failed to fetch results." });
    }

    const resultsMap = {};
    (results || []).forEach((r) => {
      if (["flashcards", "questions"].includes(r.result_type)) {
        try {
          resultsMap[r.result_type] = JSON.parse(r.content);
        } catch (_) {
          resultsMap[r.result_type] = r.content;
        }
      } else {
        resultsMap[r.result_type] = r.content;
      }
    });

    res.json({ results: resultsMap });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch results." });
  }
});

// ── DOWNLOAD ENDPOINTS ────────────────────────────────────────
router.get("/download/summary/:documentId/txt", async (req, res) => {
  try {
    const { data: result, error } = await supabase
      .from("ai_results")
      .select("content")
      .eq("document_id", req.params.documentId)
      .eq("user_id", req.user.id)
      .eq("result_type", "summary")
      .single();

    if (error || !result) {
      return res.status(404).json({ error: "Summary not found." });
    }

    const content = result.content
      .replace(/\$\$([\s\S]*?)\$\$/g, "\n[EQUATION: $1]\n")
      .replace(/\$([^\$\n]+)\$/g, "[MATH: $1]");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=summary.txt");
    res.send(content);

    await logUserActivity(req.user.id, "download_summary", "Downloaded summary (TXT)");
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

router.get("/download/flashcards/:documentId/csv", async (req, res) => {
  try {
    const { data: result, error } = await supabase
      .from("ai_results")
      .select("content")
      .eq("document_id", req.params.documentId)
      .eq("user_id", req.user.id)
      .eq("result_type", "flashcards")
      .single();

    if (error || !result) {
      return res.status(404).json({ error: "Flashcards not found." });
    }

    const flashcards = JSON.parse(result.content);
    let csv = "Question,Answer,Category\n";
    flashcards.forEach((card) => {
      const front = (card.front || "").replace(/"/g, '""');
      const back = (card.back || "").replace(/"/g, '""');
      const category = (card.category || "General").replace(/"/g, '""');
      csv += `"${front}","${back}","${category}"\n`;
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=flashcards.csv");
    res.send(csv);

    await logUserActivity(req.user.id, "download_flashcards", `Downloaded ${flashcards.length} flashcards (CSV)`);
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

router.get("/download/questions/:documentId/txt", async (req, res) => {
  try {
    const { data: result, error } = await supabase
      .from("ai_results")
      .select("content")
      .eq("document_id", req.params.documentId)
      .eq("user_id", req.user.id)
      .eq("result_type", "questions")
      .single();

    if (error || !result) {
      return res.status(404).json({ error: "Questions not found." });
    }

    let textOutput = "";
    try {
      const quiz = JSON.parse(result.content);
      textOutput = "## 📝 REVISION QUIZ POOL\n\n";

      if (quiz.mcqs) {
        textOutput += "### MULTIPLE CHOICE QUESTIONS\n";
        quiz.mcqs.forEach((q, i) => {
          textOutput += `Q${i + 1}: ${q.question}\n`;
          Object.entries(q.options || {}).forEach(([k, v]) => (textOutput += `   ${k}) ${v}\n`));
          textOutput += `Correct Answer: ${q.correctAnswer}\n\n`;
        });
      }

      if (quiz.shortAnswer) {
        textOutput += "\n### SHORT ANSWER QUESTIONS\n";
        quiz.shortAnswer.forEach((q, i) => {
          textOutput += `Q${i + 1}: ${q.question}\nModel Answer: ${q.modelAnswer}\nGrading Criteria: ${q.gradingCriteria}\n\n`;
        });
      }

      if (quiz.essays) {
        textOutput += "\n### ESSAY QUESTIONS\n";
        quiz.essays.forEach((q, i) => {
          textOutput += `Q${i + 1}: ${q.question}\nKey Points: ${(q.keyPoints || []).join("; ")}\n\n`;
        });
      }
    } catch (e) {
      textOutput = result.content;
    }

    const content = textOutput
      .replace(/\$\$([\s\S]*?)\$\$/g, "\n[EQUATION: $1]\n")
      .replace(/\$([^\$\n]+)\$/g, "[MATH: $1]");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=questions.txt");
    res.send(content);

    await logUserActivity(req.user.id, "download_questions", "Downloaded questions (TXT)");
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

router.get("/download/explanation/:documentId/txt", async (req, res) => {
  try {
    const { data: result, error } = await supabase
      .from("ai_results")
      .select("content")
      .eq("document_id", req.params.documentId)
      .eq("user_id", req.user.id)
      .eq("result_type", "explanation")
      .single();

    if (error || !result) {
      return res.status(404).json({ error: "Explanation not found." });
    }

    const content = result.content
      .replace(/\\\(/g, "[MATH: ")
      .replace(/\\\)/g, "]")
      .replace(/\\\[/g, "\n[EQUATION]\n")
      .replace(/\\\]/g, "\n[/EQUATION]\n")
      .replace(/\$\$([\s\S]*?)\$\$/g, "\n[EQUATION: $1]\n")
      .replace(/\$([^\$\n]+)\$/g, "[MATH: $1]")
      .replace(/<[^>]*>/g, "");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=explanation.txt");
    res.send(content);

    await logUserActivity(req.user.id, "download_explanation", "Downloaded explanation (TXT)");
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

module.exports = router;
module.exports.generateSummaryForDocument = generateSummaryForDocument;
module.exports.generateQuestionsForDocument = generateQuestionsForDocument;
module.exports.generateFlashcardsForDocument = generateFlashcardsForDocument;
module.exports.warmDocumentStudyAssets = warmDocumentStudyAssets;
