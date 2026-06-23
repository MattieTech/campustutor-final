// ============================================================
// routes/ai.js — MattieTech AI-powered study features
// ============================================================

const express = require("express");
const router = express.Router();
const { askGemini } = require("../utils/gemini");
const supabase = require("../utils/supabase");
const authMiddleware = require("../middleware/authMiddleware");
const { awardXP, updateStreak } = require("../utils/xp");

// Helper: fetch document text from Supabase and verify ownership
async function getDocumentText(documentId, userId) {
  const { data, error } = await supabase
    .from("documents")
    .select("extracted_text, file_name, page_count")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("Document not found or access denied.");
  }

  return data;
}

// Helper: save AI result to Supabase
async function saveAIResult(documentId, userId, resultType, content) {
  await supabase.from("ai_results").upsert(
    {
      document_id: documentId,
      user_id: userId,
      result_type: resultType,
      content: content,
      created_at: new Date().toISOString(),
    },
    { onConflict: "document_id,result_type" }
  );
}

function buildSummaryPrompt(doc) {
  return `
You are CampusTutor AI, a premium academic assistant.

Lecture notes from "${doc.file_name}":
---
${doc.extracted_text}
---
Requirement: Generate a tightly packed, core textbook-style overview using high-density markdown headings. Focus on structural hierarchy and conceptual density. Avoid long-form rambling; use precise, technical language and subsection headers to categorize information.

IMPORTANT: Format ALL mathematical expressions using LaTeX (\( ... \) for inline, \[ ... \] for display).

Format your response like this:
## 📋 Summary of "${doc.file_name}"

**Main Topic:** [1-sentence overview]

### 📖 Core Technical Overview
[Use high-density headings (###, ####) and bullet points to break down the material textbook-style. Cover every key technical nuance briefly.]

**Core Takeaway:** [2-3 sentences on what this is really about]

Use simple English. Assume the reader is a first-year university student.
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
      const sectionEnd = nextMatch ? (nextMatch.index || text.length) : text.length;
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

function calculateQuestionTargets(doc) {
  const pages = estimateDocumentPages(doc);
  const textLength = (doc.extracted_text || "").length;

  if (pages >= 25 || textLength >= 90000) {
    return { mcqCount: 40, shortCount: 20, essayCount: 8 };
  }
  if (pages >= 14 || textLength >= 50000) {
    return { mcqCount: 32, shortCount: 16, essayCount: 6 };
  }
  if (pages >= 7 || textLength >= 23000) {
    return { mcqCount: 24, shortCount: 12, essayCount: 4 };
  }

  return { mcqCount: 16, shortCount: 8, essayCount: 2 };
}

function calculateQuestionTargetsWithSize(quizSize) {
  switch (quizSize) {
    case 10:
      return { mcqCount: 8, shortCount: 0, essayCount: 2 };
    case 20:
      return { mcqCount: 14, shortCount: 4, essayCount: 2 };
    case 30:
      return { mcqCount: 20, shortCount: 8, essayCount: 2 };
    case 40:
      return { mcqCount: 25, shortCount: 11, essayCount: 4 };
    case 50:
    default:
      return { mcqCount: 30, shortCount: 15, essayCount: 5 };
  }
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

  if (canUseObject && (!canUseArray || objectStart < arrayStart)) {
    return JSON.parse(cleaned.substring(objectStart, objectEnd + 1));
  }

  return JSON.parse(cleaned.substring(arrayStart, arrayEnd + 1));
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
IMPORTANT: Format all mathematical expressions using LaTeX (\( ... \) for inline, \[ ... \] for display).

Output markdown only.
  `.trim();
}

function buildFinalSummaryPrompt(doc, partialSummaries) {
  return `
You are CampusTutor AI, a premium academic assistant.

You are given chunk-level summaries for "${doc.file_name}".
Combine them into one comprehensive textbook-grade summary.

Chunk summaries:
---
${partialSummaries.join("\n\n---\n\n")}
---

Output format:
## 📋 Summary of "${doc.file_name}"

**Main Topic:** [1-sentence overview]

### 📖 Core Technical Overview
[Use compact technical sections and bullets. Preserve full conceptual coverage.]

### 🧠 Concept Relationships
[Show how major ideas connect across the document.]

### 🎯 Exam-Focused Takeaways
[High-yield revision points likely to be tested.]

**Core Takeaway:** [2-3 sentences]

IMPORTANT: Format all mathematical expressions using LaTeX (\( ... \) for inline, \[ ... \] for display).
Keep language clear for first-year students.
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
Ensure your questions are selected randomly from different sections of the text context so that subsequent attempts yield fresh variations.
Required Volumes:
- Multiple Choice Questions (MCQs): ${allocation.mcqCount} (Include 4 distinct options A, B, C, D)
- Short Answer Questions: ${allocation.shortCount} (Include detailed grading criteria)
- Essay Questions: ${allocation.essayCount} (Broad synthesis questions)

IMPORTANT: Format ALL mathematical expressions using LaTeX (\( ... \) for inline, \[ ... \] for display).

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
  const prompt = `Create exactly ${targetCount} high-yield, conceptually dense study flashcards from this text covering all complex terminologies. Return ONLY a JSON array - no markdown, no code blocks.

Document context: "${contextMeta.fileName}" | ${chunk.rangeLabel} | chunk ${contextMeta.chunkIndex + 1} of ${contextMeta.totalChunks}

Text to extract from:
---
${chunk.text}
---

Return valid JSON array ONLY (start with [ end with ]):
[{"id":1,"front":"Question?","back":"Answer","category":"Topic"},{"id":2,"front":"Question?","back":"Answer","category":"Topic"}]

Rules:
- Generate exactly ${targetCount} flashcards with id, front, back, category
- IMPORTANT: Format ALL mathematical expressions using LaTeX delimiters
  * Use $ for inline math
  * Use $$ for display/standalone equations
- Never write math as plain text: always use LaTeX notation
- Keep answers concise and clear
- Valid JSON format only

Generate:`.trim();

  return { prompt, targetCount };
}

async function generateSummaryForDocument(documentId, userId, options = {}) {
  const { persist = true, log = true, award = true } = options;
  const doc = await getDocumentText(documentId, userId);
  const chunks = splitDocumentIntoChunks(doc, 5);

  const partialSummaryPromises = chunks.map(async (chunk, i) => {
    const chunkPrompt = buildChunkSummaryPrompt(doc, chunk, i, chunks.length);
    const partial = await askGemini(chunkPrompt);
    return `### ${chunk.rangeLabel}\n${partial}`;
  });
  const partialSummaries = await Promise.all(partialSummaryPromises);

  const finalPrompt =
    partialSummaries.length > 1
      ? buildFinalSummaryPrompt(doc, partialSummaries)
      : buildSummaryPrompt({ ...doc, extracted_text: chunks[0]?.text || doc.extracted_text });
  const summary = await askGemini(finalPrompt);

  if (persist) {
    await saveAIResult(documentId, userId, "summary", summary);
  }

  if (log) {
    await logUserActivity(userId, "ai_summarize", `Generated summary | Document: "${doc.file_name}"`);
  }

  if (award) {
    try {
      await awardXP(userId, "ai_summarize", { document: doc.file_name, documentId });
      await updateStreak(userId);
    } catch (xpErr) {
      console.log("Note: Could not award XP:", xpErr.message);
    }
  }

  return { summary, doc };
}

async function generateQuestionsForDocument(documentId, userId, options = {}) {
  const { persist = true, log = true, award = true, quizSize = 10 } = options;
  const doc = await getDocumentText(documentId, userId);
  const targets = calculateQuestionTargetsWithSize(quizSize);
  const chunks = splitDocumentIntoChunks(doc, 5);

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

  const promises = chunks.map(async (chunk, i) => {
    const allocation = perChunkAllocation[i];
    if (allocation.mcqCount + allocation.shortCount + allocation.essayCount <= 0) return null;

    const { prompt } = buildQuestionsPrompt(chunk, allocation, {
      fileName: doc.file_name,
      chunkIndex: i,
      totalChunks: chunks.length,
    });

    try {
      const rawResponse = await askGemini(prompt);
      return safeExtractJSON(rawResponse);
    } catch (parseErr) {
      console.error("❌ Questions parsing error for chunk", i + 1, parseErr.message);
      return null;
    }
  });

  const results = await Promise.all(promises);
  results.forEach((chunkData) => {
    if (!chunkData) return;
    merged.mcqs.push(...(Array.isArray(chunkData.mcqs) ? chunkData.mcqs : []));
    merged.shortAnswer.push(...(Array.isArray(chunkData.shortAnswer) ? chunkData.shortAnswer : []));
    merged.essays.push(...(Array.isArray(chunkData.essays) ? chunkData.essays : []));
  });

  const questionsData = {
    mcqs: dedupeByQuestion(merged.mcqs).slice(0, targets.mcqCount),
    shortAnswer: dedupeByQuestion(merged.shortAnswer).slice(0, targets.shortCount),
    essays: dedupeByQuestion(merged.essays).slice(0, targets.essayCount),
  };

  if (!questionsData.mcqs.length && !questionsData.shortAnswer.length && !questionsData.essays.length) {
    throw new Error("Failed to generate structured quiz data.");
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
    } catch (xpErr) {
      console.log("Note: Could not award XP:", xpErr.message);
    }
  }

  return { questionsData, doc };
}

async function generateFlashcardsForDocument(documentId, userId, options = {}) {
  const { persist = true, log = true, award = true, flashcardSize } = options;
  const doc = await getDocumentText(documentId, userId);
  const targetCount = flashcardSize ? Number(flashcardSize) : calculateFlashcardTarget(doc);
  const chunks = splitDocumentIntoChunks(doc, 5);
  const perChunkTargets = chunks.map((_, index) => {
    const base = Math.floor(targetCount / chunks.length);
    return base + (index < targetCount % chunks.length ? 1 : 0);
  });

  const mergedCards = [];

  const promises = chunks.map(async (chunk, i) => {
    const chunkTarget = perChunkTargets[i];
    if (!chunkTarget) return null;

    const { prompt } = buildFlashcardsPrompt(chunk, chunkTarget, {
      fileName: doc.file_name,
      chunkIndex: i,
      totalChunks: chunks.length,
    });

    try {
      const rawResponse = await askGemini(prompt);
      return safeExtractJSON(rawResponse);
    } catch (parseErr) {
      console.error("❌ Flashcards parsing error for chunk", i + 1, parseErr.message);
      return null;
    }
  });

  const results = await Promise.all(promises);
  results.forEach((parsed) => {
    if (Array.isArray(parsed)) {
      mergedCards.push(...parsed);
    }
  });

  let flashcards = dedupeByFront(mergedCards)
    .slice(0, targetCount)
    .map((card, idx) => ({
      id: idx + 1,
      front: String(card.front || "").trim().substring(0, 220),
      back: String(card.back || "").trim().substring(0, 520),
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
    } catch (xpErr) {
      console.log("Note: Could not award XP:", xpErr.message);
    }
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

// Helper: Log user activity
async function logUserActivity(userId, action, details) {
  try {
    await supabase.from("user_activity").insert({
      user_id: userId,
      action: action,
      details: details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.log("Note: Could not log activity:", err.message);
  }
}

// Helper: Handle API errors with user-friendly messages
function handleAIError(err, res) {
  if (err.message?.includes("busy") || err.message?.includes("routes")) {
    return res.status(503).json({
      error: "📚 CampusTutor AI is grading a rush of papers right now! Please wait a few seconds and try generating your questions again.",
    });
  }
  if (err.status === 429 || err.message?.includes("quota")) {
    return res.status(429).json({
      error: "🤔 CampusTutor AI is thinking a bit too hard right now! Please wait a moment before trying your next question.",
    });
  }
  if (err.status === 404 || err.message?.includes("not found")) {
    return res.status(500).json({
      error: "❌ The AI model is temporarily unavailable. Please try again in a moment.",
    });
  }
  res.status(500).json({ error: err.message || "Failed to process your request." });
}

// ── SUMMARIZE ─────────────────────────────────────────────────
router.post("/summarize", authMiddleware, async (req, res) => {
  try {
    const { documentId, summarySize } = req.body;
    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("plan")
      .eq("id", req.user.id)
      .single();
    const userPlan = profile?.plan || 'free';

    const size = Number(summarySize || 1);

    if (userPlan === 'free') {
      if (size > 1) {
        return res.status(403).json({ error: "Summary options 2 and 3 are only available on Plus and Pro plans. Please upgrade." });
      }
    } else if (userPlan === 'plus') {
      if (size > 2) {
        return res.status(403).json({ error: "Summary option 3 is only available on the Pro Plan. Please upgrade." });
      }
    }

    const { summary } = await generateSummaryForDocument(documentId, req.user.id, { summarySize: size });
    res.json({ summary });
  } catch (err) {
    console.error("Summarize error:", err.message);
    handleAIError(err, res);
  }
});

// ── EXPLAIN CONCEPT ───────────────────────────────────────────
router.post("/explain", authMiddleware, async (req, res) => {
  try {
    const { documentId, concept } = req.body;

    if (!concept) {
      return res.status(400).json({ error: "concept is required." });
    }

    let doc = null;
    let docContext = "";
    
    if (documentId) {
      try {
        doc = await getDocumentText(documentId, req.user.id);
        docContext = `A student is studying the following lecture notes:\n---\n${doc.extracted_text}\n---\n\n`;
      } catch (docErr) {
        console.log("Document not found, proceeding without document context:", docErr.message);
      }
    }

    const prompt = `
You are CampusTutor AI, a patient university lecturer who explains things simply.

${docContext}The student wants you to explain this concept in beginner-friendly terms: "${concept}"

IMPORTANT: Format ALL mathematical expressions using LaTeX.
Use $ for inline math (e.g., $f(x) = x^2$) and $$ for display equations (e.g., $$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$).
Never write math as plain text.

Please explain it like this:
## 💡 Explaining: "${concept}"

**Simple Definition:** [Explain it like the student is 16 years old. Use LaTeX for any maths.]

**Real-World Example:** [A relatable analogy or everyday example]

**Mathematical Expression (if applicable):**
$$
\text{Key equation(s) here}
$$

**How it relates to the notes:** ${docContext ? "[Connect it back to what's in the lecture]" : "[General explanation without specific notes]"}

**Quick Memory Trick:** [A tip to remember this concept]

Keep the language simple, warm, and encouraging.
    `.trim();

    const explanation = await askGemini(prompt);
    
    if (doc && documentId) {
      await saveAIResult(documentId, req.user.id, "explanation", explanation);
      await logUserActivity(req.user.id, "ai_explain", `Asked: "${concept}" | Document: "${doc.file_name}"`);
    } else {
      await logUserActivity(req.user.id, "ai_explain", `Asked: "${concept}" | No document`);
    }
    
    try {
      await awardXP(req.user.id, "ai_explain", { concept });
      await updateStreak(req.user.id);
    } catch (xpErr) {
      console.log("Note: Could not award XP:", xpErr.message);
    }
    
    res.json({ explanation });
  } catch (err) {
    console.error("Explain error:", err.message);
    handleAIError(err, res);
  }
});

// ── REVISION QUESTIONS ────────────────────────────────────────
router.post("/questions", authMiddleware, async (req, res) => {
  try {
    const { documentId, quizSize } = req.body;
    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("plan")
      .eq("id", req.user.id)
      .single();
    const userPlan = profile?.plan || 'free';

    const size = Number(quizSize || 10);

    if (userPlan === 'free') {
      if (size < 10 || size > 20) {
        return res.status(403).json({ error: "Free Plan allows 10-20 quiz questions. Please upgrade your plan." });
      }
    } else if (userPlan === 'plus') {
      if (size > 40) {
        return res.status(403).json({ error: "Plus Plan is limited to up to 40 quiz questions. Please upgrade to Pro." });
      }
    } else if (userPlan === 'pro') {
      if (size > 50) {
        return res.status(403).json({ error: "Pro Plan is limited to up to 50 quiz questions." });
      }
    }

    const { questionsData } = await generateQuestionsForDocument(documentId, req.user.id, { quizSize: size });
    res.json({ questions: questionsData });
  } catch (err) {
    console.error("Questions error:", err.message);
    handleAIError(err, res);
  }
});

// ── FLASHCARDS ────────────────────────────────────────────────
router.post("/flashcards", authMiddleware, async (req, res) => {
  try {
    const { documentId, flashcardSize } = req.body;
    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    const { flashcards } = await generateFlashcardsForDocument(documentId, req.user.id, { flashcardSize: Number(flashcardSize || 25) });
    res.json({ flashcards });
  } catch (err) {
    console.error("Flashcards error:", err.message);
    handleAIError(err, res);
  }
});

// ── GET SAVED RESULTS ─────────────────────────────────────────
router.get("/results/:documentId", authMiddleware, async (req, res) => {
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
      resultsMap[r.result_type] =
        ["flashcards", "questions"].includes(r.result_type) ? JSON.parse(r.content) : r.content;
    });

    res.json({ results: resultsMap });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch results." });
  }
});

// ── DOWNLOAD ENDPOINTS ────────────────────────────────────────
router.get("/download/summary/:documentId/txt", authMiddleware, async (req, res) => {
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
      .replace(/\$/g, "[MATH]")
      .replace(/\$\$/g, "\n[EQUATION]\n");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=summary.txt");
    res.send(content);

    await logUserActivity(req.user.id, "download_summary", `Downloaded summary (TXT)`);
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

router.get("/download/flashcards/:documentId/csv", authMiddleware, async (req, res) => {
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

router.get("/download/questions/:documentId/txt", authMiddleware, async (req, res) => {
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
          textOutput += `Q${i+1}: ${q.question}\n`;
          Object.entries(q.options).forEach(([k, v]) => textOutput += `   ${k}) ${v}\n`);
          textOutput += `Correct Answer: ${q.correctAnswer}\n\n`;
        });
      }
      
      if (quiz.shortAnswer) {
        textOutput += "\n### SHORT ANSWER QUESTIONS\n";
        quiz.shortAnswer.forEach((q, i) => {
          textOutput += `Q${i+1}: ${q.question}\nModel Answer: ${q.modelAnswer}\nGrading Criteria: ${q.gradingCriteria}\n\n`;
        });
      }
    } catch (e) {
      textOutput = result.content;
    }

    const content = textOutput
      .replace(/\$/g, "[MATH]")
      .replace(/\$\$/g, "\n[EQUATION]\n");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=questions.txt");
    res.send(content);

    await logUserActivity(req.user.id, "download_questions", `Downloaded questions (TXT)`);
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

router.get("/download/explanation/:documentId/txt", authMiddleware, async (req, res) => {
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
      .replace(/<[^>]*>/g, "");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=explanation.txt");
    res.send(content);

    await logUserActivity(req.user.id, "download_explanation", `Downloaded explanation (TXT)`);
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

module.exports = router;
module.exports.generateSummaryForDocument = generateSummaryForDocument;
module.exports.generateQuestionsForDocument = generateQuestionsForDocument;
module.exports.generateFlashcardsForDocument = generateFlashcardsForDocument;
module.exports.warmDocumentStudyAssets = warmDocumentStudyAssets;
