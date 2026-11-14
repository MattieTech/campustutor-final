// ============================================================
// utils/gemini.js — MattieTech AI Client (Gemini 2.5 + Fallbacks)
// ============================================================

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const modelGemini3Flash = genAI ? genAI.getGenerativeModel({ model: "gemini-3-flash-preview" }) : null;
const modelGemini31Lite = genAI ? genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" }) : null;
const modelFlashLite = genAI ? genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" }) : null;
const modelGemini25Flash = genAI ? genAI.getGenerativeModel({ model: "gemini-2.5-flash" }) : null;

const SYSTEM_PROMPT = `
You are CampusTutor AI, a premium academic assistant engineered by MattieTech for university students worldwide.

You must strictly adapt your response behavior depending on the user's specific query context:

1. NON-CALCULATING COURSES (History, Arts, Languages, General GST, Essays, Law, etc.):
- Do not invent mathematical formulas, equations, or scientific operators when none are needed.
- Answer in structured, clear, academic English paragraphs with clean bullet points and bold headers.

2. MATHEMATICAL, SCIENTIFIC & CODING COURSES (Calculus, Algebra, Physics, Chemistry, Statistics, Computer Science):
- Format ALL mathematical expressions using standard LaTeX delimiters:
  * Single dollar signs ($ ... $) for inline formulas (e.g., $f(x) = x^2$).
  * Double dollar signs ($$ ... $$) on their own line for standalone display equations.
- Never output raw unformatted math like raw bracketed formulas without dollar delimiters.
- Put code snippets in proper fenced markdown code blocks (\`\`\`language ... \`\`\`).

Example of a display equation:
$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$

Always output clean, complete, well-structured markdown.
`.trim();

function withTimeout(promise, ms, label = "AI request") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    ),
  ]);
}

async function callGeminiModel(modelInstance, contents, timeoutMs = 45000) {
  if (!modelInstance) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  // Use generateContent for clean, reliable completion with timeout
  const result = await withTimeout(
    modelInstance.generateContent(contents),
    timeoutMs,
    "Primary AI core"
  );
  const text = result?.response?.text?.() || "";
  if (!text.trim()) {
    throw new Error("Primary AI returned an empty response.");
  }
  return text;
}

// ── askOpenRouter ─────────────────────────────────────────────
async function askOpenRouter(modelId, prompt, timeoutMs = 25000) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:3000",
      "X-Title": "CampusTutor AI",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenRouter error: ${response.status}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) {
    throw new Error(`OpenRouter model ${modelId} returned empty content.`);
  }
  return content;
}

// ── askGemini ─────────────────────────────────────────────────
async function askGemini(prompt, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 45000);
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${prompt}`;

  const errors = [];
  const modelPool = [
    { name: "gemini-3-flash-preview", model: modelGemini3Flash },
    { name: "gemini-3.1-flash-lite", model: modelGemini31Lite },
    { name: "gemini-flash-lite-latest", model: modelFlashLite },
    { name: "gemini-2.5-flash", model: modelGemini25Flash },
  ];

  for (const item of modelPool) {
    if (!item.model) continue;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await callGeminiModel(item.model, fullPrompt, timeoutMs);
        return text;
      } catch (err) {
        errors.push(`${item.name}#${attempt}: ${err.message}`);
        const isRate = /429|quota|rate|resource_exhausted|high demand|503/i.test(err.message || "");
        if (isRate && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        break;
      }
    }
  }

  // Fallback to OpenRouter if configured
  if (OPENROUTER_API_KEY) {
    const fallbackChain = [
      "google/gemma-4-26b-a4b-it:free",
      "liquid/lfm-3-1.7b:free",
    ];

    for (const modelId of fallbackChain) {
      try {
        console.log(`🔄 Attempting OpenRouter fallback: ${modelId}`);
        const text = await askOpenRouter(modelId, fullPrompt, 25000);
        return text;
      } catch (err) {
        errors.push(`${modelId}: ${err.message}`);
      }
    }
  }

  console.error("❌ All AI routes failed:", errors.join(" | "));
  throw new Error("All AI routes are currently busy. Please try again in a few seconds.");
}

// ── Multimodal Image OCR & Study Text Extraction ──────────────
async function extractTextFromImage(fileBuffer, mimeType = "image/jpeg") {
  const base64Data = fileBuffer.toString("base64");
  const promptText =
    "Examine this uploaded study image carefully. Transcribe ALL visible text, handwritten notes, diagrams, labels, tables, and mathematical equations verbatim and accurately. Format mathematical equations using LaTeX ($...$ inline, $$...$$ display). If the image contains a problem, question, or slide diagram, describe all visual elements and labels clearly so study summaries, quizzes, and explanations can be generated from it.";

  const visionModels = [modelGemini3Flash, modelGemini31Lite, modelFlashLite, modelGemini25Flash].filter(Boolean);
  for (const m of visionModels) {
    try {
      const text = await callGeminiModel(
        m,
        [
          { text: promptText },
          { inlineData: { mimeType, data: base64Data } },
        ],
        45000
      );
      if (text && text.trim().length > 0) return text.trim();
    } catch (err) {
      console.warn("⚠️ Vision model attempt failed:", err.message);
    }
  }

  if (OPENROUTER_API_KEY) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:3000",
        "X-Title": "CampusTutor AI",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Data}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(40000),
    });

    const data = await response.json();
    if (response.ok && data?.choices?.[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
    throw new Error(data?.error?.message || `Image OCR error: ${response.status}`);
  }

  throw new Error("Image OCR service is currently unavailable.");
}

// ── Scanned PDF OCR ───────────────────────────────────────────
async function ocrScannedPDF(fileBuffer) {
  const base64Pdf = fileBuffer.toString("base64");
  const ocrInstruction =
    "Extract and transcribe all text from this scanned PDF document. Return ONLY the transcribed text. Keep formatting, headers, paragraphs, lists, and equations (using LaTeX $...$ / $$...$$) accurately.";

  // 1. Primary: Native Gemini 2.5 Flash PDF understanding
  if (primaryModel) {
    try {
      console.log("👁️ Scanned PDF detected, transcribing with Gemini 2.5 Flash...");
      const text = await callGeminiModel(
        primaryModel,
        [
          { text: ocrInstruction },
          { inlineData: { mimeType: "application/pdf", data: base64Pdf } },
        ],
        60000
      );
      if (text && text.trim().length >= 20) {
        return text.trim();
      }
    } catch (err) {
      console.warn("⚠️ Gemini PDF OCR failed, trying OpenRouter:", err.message);
    }
  }

  // 2. Fallback: OpenRouter
  if (OPENROUTER_API_KEY) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:3000",
          "X-Title": "CampusTutor AI",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          max_tokens: 8000,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: ocrInstruction },
                {
                  type: "image_url",
                  image_url: { url: `data:application/pdf;base64,${base64Pdf}` },
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(55000),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || `OpenRouter error: ${response.status}`);
      }
      return data.choices[0].message.content;
    } catch (error) {
      console.error("❌ Multimodal PDF OCR failed:", error.message);
    }
  }

  throw new Error("This PDF appears to be a scanned image and OCR processing failed. Please use a text-based PDF.");
}

module.exports = { askGemini, ocrScannedPDF, extractTextFromImage };
