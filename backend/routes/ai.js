// ============================================================
// routes/ai.js — MattieTech AI-powered study features
//
// Every prompt now includes explicit LaTeX math formatting
// instructions so that the AI output can be rendered by KaTeX
// on the frontend.
//
// Routes:
//   POST /api/ai/summarize     → Summarize the notes
//   POST /api/ai/explain       → Explain a specific concept
//   POST /api/ai/questions     → Generate revision questions
//   POST /api/ai/flashcards    → Generate flashcards
//   GET  /api/ai/results/:docId → Get saved AI results
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
    const { documentId } = req.body;
    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    const doc = await getDocumentText(documentId, req.user.id);
    const pageCount = doc.page_count || 1;

    const prompt = `
You are CampusTutor AI, a premium academic assistant.

Lecture notes from "${doc.file_name}":
---
${doc.extracted_text}
---
Requirement: Generate a tightly packed, core textbook-style overview using high-density markdown headings. Focus on structural hierarchy and conceptual density. Avoid long-form rambling; use precise, technical language and subsection headers to categorize information.

IMPORTANT: Format ALL mathematical expressions using LaTeX ($ for inline, $$ for block).

Format your response like this:
## 📋 Summary of "${doc.file_name}"

**Main Topic:** [1-sentence overview]

### 📖 Core Technical Overview
[Use high-density headings (###, ####) and bullet points to break down the material textbook-style. Cover every key technical nuance briefly.]

**Core Takeaway:** [2-3 sentences on what this is really about]

Use simple English. Assume the reader is a first-year university student.
    `.trim();

    const summary = await askGemini(prompt);
    await saveAIResult(documentId, req.user.id, "summary", summary);
    
    // Log the activity with detailed info
    await logUserActivity(req.user.id, "ai_summarize", `Generated summary | Document: "${doc.file_name}"`);
    
    // Award XP
    try {
      await awardXP(req.user.id, "ai_summarize", { document: doc.file_name });
      await updateStreak(req.user.id);
    } catch (xpErr) {
      console.log("Note: Could not award XP:", xpErr.message);
    }
    
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
Use $ for inline math and $$ for display equations.

Please explain it like this:
## 💡 Explaining: "${concept}"

**Simple Definition:** [Explain it like the student is 16 years old. Use LaTeX for any maths.]

**Real-World Example:** [A relatable analogy or everyday example]

**Mathematical Expression (if applicable):**
[Show the key equation(s) as a LaTeX display equation using \\[ ... \\]]

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
    
    // Award XP
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
    const { documentId } = req.body;
    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    const doc = await getDocumentText(documentId, req.user.id);
    const pageCount = doc.page_count || 1;

    let mcqCount = "15";
    let shortCount = "3";
    let essayCount = "0";

    if (pageCount > 5 && pageCount <= 15) {
      mcqCount = "30";
      shortCount = "5";
      essayCount = "0";
    } else if (pageCount > 15) {
      mcqCount = "40";
      shortCount = "8";
      essayCount = "2";
    }

    const prompt = `
You are CampusTutor AI, a university exam setter creating a revision quiz pool.

Based on these lecture notes (${pageCount} pages):
---
${doc.extracted_text}
---

Generate a high-yield interactive revision quiz.
Ensure your questions are selected randomly from different sections of the text context so that subsequent attempts yield fresh variations.
Required Volumes:
- Multiple Choice Questions (MCQs): ${mcqCount} (Include 4 distinct options A, B, C, D)
- Short Answer Questions: ${shortCount} (Include detailed grading criteria)
- Essay Questions: ${essayCount} (Broad synthesis questions)

IMPORTANT: Format ALL mathematical expressions using LaTeX ($ for inline, $$ for block).

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
      "gradingCriteria": "..."
    }
  ],
  "essays": [
    {
      "question": "...",
      "keyPoints": ["Point 1", "Point 2"]
    }
  ]
}`.trim();

    const rawResponse = await askGemini(prompt);
    let questionsData;

    try {
      let cleaned = rawResponse.replace(/```[\s\S]*?```/g, "").replace(/^```/gm, "").trim();
      const startIdx = cleaned.indexOf('{');
      const endIdx = cleaned.lastIndexOf('}');
      
      if (startIdx === -1 || endIdx === -1) throw new Error("No JSON found");
      questionsData = JSON.parse(cleaned.substring(startIdx, endIdx + 1));
    } catch (parseErr) {
      console.error("❌ Questions parsing error:", parseErr.message);
      return res.status(500).json({ error: "Failed to generate structured quiz data." });
    }

    await saveAIResult(documentId, req.user.id, "questions", JSON.stringify(questionsData));
    
    // Log the activity with detailed info
    await logUserActivity(req.user.id, "ai_questions", `Generated ${mcqCount} MCQs and ${shortCount} Short Answer questions | Document: "${doc.file_name}"`);
    
    // Award XP
    try {
      const totalQ = (questionsData.mcqs?.length || 0) + (questionsData.shortAnswer?.length || 0) + (questionsData.essays?.length || 0);
      await awardXP(req.user.id, "ai_questions", { document: doc.file_name, count: totalQ });
      await updateStreak(req.user.id);
    } catch (xpErr) {
      console.log("Note: Could not award XP:", xpErr.message);
    }
    
    res.json({ questions: questionsData });
  } catch (err) {
    console.error("Questions error:", err.message);
    handleAIError(err, res);
  }
});

// ── FLASHCARDS ────────────────────────────────────────────────
router.post("/flashcards", authMiddleware, async (req, res) => {
  try {
    const { documentId } = req.body;
    if (!documentId) {
      return res.status(400).json({ error: "documentId is required." });
    }

    const doc = await getDocumentText(documentId, req.user.id);
    const targetCount = "20"; // Capped for high-yield speed

    const prompt = `Create exactly ${targetCount} high-yield, conceptually dense study flashcards from this text covering all complex terminologies. Return ONLY a JSON array - no markdown, no code blocks.

Text to extract from:
---
${doc.extracted_text}
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

    const rawResponse = await askGemini(prompt);

    let flashcards;
    try {
      // Remove markdown and extract JSON
      let cleaned = rawResponse
        .replace(/```[\s\S]*?```/g, "")  // Remove code blocks
        .replace(/^```/gm, "")            // Remove stray backticks
        .trim();

      const startIdx = cleaned.indexOf('[');
      const endIdx = cleaned.lastIndexOf(']');
      
      if (startIdx === -1 || endIdx === -1) {
        throw new Error("No JSON array found");
      }

      const jsonString = cleaned.substring(startIdx, endIdx + 1);
      flashcards = JSON.parse(jsonString);

      if (!Array.isArray(flashcards) || flashcards.length === 0) {
        throw new Error("Empty or invalid array");
      }

      // Normalize flashcard data
      flashcards = flashcards.map((card, idx) => ({
        id: card.id || idx + 1,
        front: String(card.front || "").trim().substring(0, 200),
        back: String(card.back || "").trim().substring(0, 500),
        category: String(card.category || "General").trim(),
      }));

    } catch (parseErr) {
      console.error("❌ Flashcards error:", parseErr.message);
      console.error("Response preview:", rawResponse.substring(0, 400));
      return res.status(500).json({
        error: "Could not parse flashcards. Please try again with a different document.",
      });
    }

    await saveAIResult(documentId, req.user.id, "flashcards", JSON.stringify(flashcards));
    
    // Log the activity with detailed info
    await logUserActivity(req.user.id, "ai_flashcards", `Generated ${flashcards.length} flashcards | Document: "${doc.file_name}"`);
    
    // Award XP
    try {
      await awardXP(req.user.id, "ai_flashcards", { document: doc.file_name, count: flashcards.length });
      await updateStreak(req.user.id);
    } catch (xpErr) {
      console.log("Note: Could not award XP:", xpErr.message);
    }
    
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
// These generate downloadable versions of AI-generated content

// Download Summary as TXT
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

    // Convert LaTeX to text-friendly format
    const content = result.content
      .replace(/\$/g, "[MATH]")
      .replace(/\$\$/g, "\n[EQUATION]\n");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=summary.txt");
    res.send(content);

    // Log activity
    await logUserActivity(req.user.id, "download_summary", `Downloaded summary (TXT)`);
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

// Download Flashcards as CSV
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
    
    // Generate CSV
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

    // Log activity
    await logUserActivity(req.user.id, "download_flashcards", `Downloaded ${flashcards.length} flashcards (CSV)`);
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

// Download Questions as TXT
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

    // Convert LaTeX to text-friendly format
    const content = textOutput
      .replace(/\$/g, "[MATH]")
      .replace(/\$\$/g, "\n[EQUATION]\n");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=questions.txt");
    res.send(content);

    // Log activity
    await logUserActivity(req.user.id, "download_questions", `Downloaded questions (TXT)`);
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

// Download Explanation as TXT
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

    // Convert LaTeX to text-friendly format
    const content = result.content
      .replace(/\\\(/g, "[MATH: ")
      .replace(/\\\)/g, "]")
      .replace(/\\\[/g, "\n[EQUATION]\n")
      .replace(/\\\]/g, "\n[/EQUATION]\n")
      .replace(/<[^>]*>/g, "");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=explanation.txt");
    res.send(content);

    // Log activity
    await logUserActivity(req.user.id, "download_explanation", `Downloaded explanation (TXT)`);
  } catch (err) {
    res.status(500).json({ error: "Failed to download file." });
  }
});

module.exports = router;
