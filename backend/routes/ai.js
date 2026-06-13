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
    .select("extracted_text, file_name")
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

    const prompt = `
You are MattieTech AI, a helpful study assistant for university students.

Here are lecture notes from a student's PDF:
---
${doc.extracted_text}
---

Please provide a clear, well-structured SUMMARY of these notes.

IMPORTANT: Format ALL mathematical expressions using LaTeX.
Use \\( ... \\) for inline math and \\[ ... \\] for display equations.

Format your response like this:
## 📋 Summary of "${doc.file_name}"

**Main Topic:** [1-sentence overview]

**Key Points:**
- [Point 1]
- [Point 2]
- [Point 3]
(continue for all major points; use LaTeX for any maths)

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
You are MattieTech AI, a patient university lecturer who explains things simply.

${docContext}The student wants you to explain this concept in beginner-friendly terms: "${concept}"

IMPORTANT: Format ALL mathematical expressions using LaTeX.
Use \\( ... \\) for inline math and \\[ ... \\] for display equations.
Never write math as plain text (no "sqrt(x)", no "x^2" — always use LaTeX).

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

    const prompt = `
You are MattieTech AI, a university exam setter creating revision questions.

Based on these lecture notes:
---
${doc.extracted_text}
---

Generate 10 revision questions to help a student prepare for exams.

IMPORTANT: Format ALL mathematical expressions using LaTeX.
Use \\( ... \\) for inline math and \\[ ... \\] for display equations.
For example, write \\( x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\) not (-b +/- sqrt(b^2-4ac))/2a.

Mix these question types:
- 3 multiple choice questions (4 options each, mark the correct answer)
- 4 short answer questions (1-3 sentences expected)
- 3 essay/long answer questions (paragraph expected)

Format:
## 📝 Revision Questions

### Multiple Choice

**Q1.** [Question — use LaTeX for any maths]
A) [Option]
B) [Option]
C) [Option]
D) [Option]
✅ **Answer: [Letter]** — [Brief reason]

(repeat for Q2, Q3)

### Short Answer Questions

**Q4.** [Question]
💬 *Model Answer:* [Answer — use LaTeX for maths]

(repeat for Q5–Q7)

### Essay Questions

**Q8.** [Question]
💬 *Key Points to Cover:* [Bullet points]

(repeat for Q9–Q10)

Make questions progressively harder. Focus on understanding, not memorization.
    `.trim();

    const questions = await askGemini(prompt);
    await saveAIResult(documentId, req.user.id, "questions", questions);
    
    // Log the activity with detailed info
    await logUserActivity(req.user.id, "ai_questions", `Generated revision questions | Document: "${doc.file_name}"`);
    
    // Award XP
    try {
      await awardXP(req.user.id, "ai_questions", { document: doc.file_name });
      await updateStreak(req.user.id);
    } catch (xpErr) {
      console.log("Note: Could not award XP:", xpErr.message);
    }
    
    res.json({ questions });
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

    const prompt = `Create 10 study flashcards from this text. Return ONLY a JSON array - no markdown, no code blocks, no explanation.

Text to extract from:
---
${doc.extracted_text.substring(0, 3000)}
---

Return valid JSON array ONLY (start with [ end with ]):
[{"id":1,"front":"Question?","back":"Answer","category":"Topic"},{"id":2,"front":"Question?","back":"Answer","category":"Topic"}]

Rules:
- 10 flashcards with id (1-10), front (question/term), back (answer), category (topic name)
- IMPORTANT: Format ALL mathematical expressions using LaTeX delimiters
  * Use \\( ... \\) for inline math (e.g., the derivative is \\( \\frac{dy}{dx} \\))
  * Use \\[ ... \\] for display/standalone equations
  * Examples: \\( x^2 \\), \\( \\sin(x) \\), \\( \\sqrt{a} \\), \\( \\frac{a}{b} \\)
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
        r.result_type === "flashcards" ? JSON.parse(r.content) : r.content;
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
      .replace(/\\\(/g, "[MATH: ")
      .replace(/\\\)/g, "]")
      .replace(/\\\[/g, "\n[EQUATION]\n")
      .replace(/\\\]/g, "\n[/EQUATION]\n")
      .replace(/<[^>]*>/g, "");

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

    // Convert LaTeX to text-friendly format
    const content = result.content
      .replace(/\\\(/g, "[MATH: ")
      .replace(/\\\)/g, "]")
      .replace(/\\\[/g, "\n[EQUATION]\n")
      .replace(/\\\]/g, "\n[/EQUATION]\n")
      .replace(/<[^>]*>/g, "");

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
