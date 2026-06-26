// ============================================================
// utils/gemini.js — MattieTech AI client
//
// Sets up the Gemini connection. The SYSTEM_PROMPT is injected
// into every request so the AI always:
//   1. Identifies itself as "MattieTech AI"
//   2. Formats mathematics using LaTeX delimiters for KaTeX
//   3. Stays focused on its role as an educational assistant
// ============================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in your .env file!");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ── SYSTEM PROMPT ─────────────────────────────────────────────
// This is prepended to every single request. It controls:
//   - Identity: the AI presents itself as MattieTech AI
//   - Math formatting: all maths must use KaTeX LaTeX syntax
//   - Brand safety: no mention of underlying AI provider
const SYSTEM_PROMPT = `
You are CampusTutor AI, a premium academic assistant engineered by MattieTech for university students worldwide. 

You must strictly adapt your response behavior depending on the user's specific query context:

1. NON-CALCULATING COURSES (History, Arts, Languages, General GST, Essays, Law, etc.):
- Absolutely FORBIDDEN from using any mathematical formats, formulas, equations, or scientific operators. 
- Answer purely in structured, conversational, plain English paragraphs.
- Use simple, clean bullet points and bold headers for readability. 

2. MATHEMATICAL & CALCULATING COURSES (Calculus, Algebra, Physics, Chemistry, Statistics):
- When a calculation, formula, step-by-step math breakdown, or equation is required, you must ONLY use standard LaTeX formatting.
- Absolutely FORBIDDEN from outputting raw code symbols like carets (^), text slashes (/), or raw unparsed bracket formulas.
- Use a SINGLE dollar sign ($) for brief inline formulas (e.g., $f(x) = x^2$).
- Use DOUBLE dollar signs ($$) on a new line for standalone textbook-grade display formulas.

Example of how you must format a textbook quadratic equation block:
$$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$

Always output pristine markdown structures so that our frontend's Marked.js and MathJax/KaTeX processing scripts can render your equations identically to a physical university textbook.
`;

// ── askOpenRouter ─────────────────────────────────────────────
// Helper function to call OpenRouter free models as backup
async function askOpenRouter(modelId, prompt) {
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
        model: modelId,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || `OpenRouter error: ${response.status}`);
    }
    return data.choices[0].message.content;
  } catch (error) {
    throw error;
  }
}

// ── askGemini ─────────────────────────────────────────────────
// Sends a prompt to Gemini with the system prompt prepended.
// Implements a Multi-AI Fallback Chain using OpenRouter free models.
async function askGemini(prompt) {
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${prompt}`;

  try {
    // 1. PRIMARY CORE ATTEMPT: Google Gemini stream mode for large outputs
    console.log("🤖 Attempting Primary Core AI (MattieTech AI Framework)...");
    const streamResult = await model.generateContentStream(fullPrompt);
    let output = "";

    for await (const chunk of streamResult.stream) {
      const text = chunk?.text ? chunk.text() : "";
      if (text) output += text;
    }

    if (!output.trim()) {
      const fallbackSync = await model.generateContent(fullPrompt);
      return fallbackSync.response.text();
    }

    return output;
  } catch (geminiError) {
    console.warn("⚠️ Primary core busy, initiating MattieTech AI Backup Chain:", geminiError.message);

    if (!OPENROUTER_API_KEY) {
      console.error("❌ OPENROUTER_API_KEY is missing. Fallback chain aborted.");
      throw geminiError;
    }

    // Ordered array of free backup models from OpenRouter
    const fallbackChain = [
      "google/gemma-2-9b-it:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "qwen/qwen-2.5-coder-32b:free",
      "openrouter/free"
    ];

    for (let i = 0; i < fallbackChain.length; i++) {
      const modelId = fallbackChain[i];
      try {
        console.log(`🔄 Attempting Route Layer ${i + 1}: ${modelId}...`);
        const text = await askOpenRouter(modelId, fullPrompt);
        
        console.log(`✅ Server routing successful using layer ${i + 1}`);
        return text;
      } catch (fallbackError) {
        console.warn(`⚠️ Backup Layer ${i + 1} (${modelId}) structural retry:`, fallbackError.message);
        
        // If all models fail, we throw a final error for the route handler
        if (i === fallbackChain.length - 1) {
          throw new Error("All system routes are currently busy. Please try again in a few seconds.");
        }
      }
    }
  }
}

// ── ocrScannedPDF ─────────────────────────────────────────────
// Multimodal inline data request to transcribe scanned PDFs using Gemini
async function ocrScannedPDF(fileBuffer) {
  try {
    console.log("👁️ Scanned PDF detected, initiating multimodal OCR transcription using OpenRouter...");
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
              {
                type: "text",
                text: "Extract and transcribe all text from this scanned document. Return ONLY the transcribed text. Do not include any summary, intro, outro, explanation, or notes. Keep formatting, headers, paragraphs, lists, and equations exactly as they appear."
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:application/pdf;base64,${fileBuffer.toString("base64")}`
                }
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || `OpenRouter error: ${response.status}`);
    }

    return data.choices[0].message.content;
  } catch (error) {
    console.error("❌ Multimodal OCR failed:", error.message);
    throw new Error("This PDF appears to be a scanned image and OCR processing failed. Please use a text-based PDF.");
  }
}

module.exports = { askGemini, ocrScannedPDF };
