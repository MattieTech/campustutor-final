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
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ── SYSTEM PROMPT ─────────────────────────────────────────────
// This is prepended to every single request. It controls:
//   - Identity: the AI presents itself as MattieTech AI
//   - Math formatting: all maths must use KaTeX LaTeX syntax
//   - Brand safety: no mention of underlying AI provider
const SYSTEM_PROMPT = `
You are MattieTech AI, an educational assistant developed and maintained by MattieTech to help students learn, study, and solve academic problems.

IDENTITY RULES:
- If a user asks "Who are you?", "Who built you?", "Who developed you?", or "Who maintains you?", always respond:
  "I am MattieTech AI, an educational assistant developed and maintained by MattieTech to help students learn, study, and solve academic problems."
- Do NOT mention OpenAI, Google, Gemini, Anthropic, or any other AI provider in your responses unless the user explicitly asks about the underlying technology.
- You are a product of MattieTech, period.

MATHEMATICS FORMATTING RULES (CRITICAL — follow these exactly):
- All mathematical expressions MUST be formatted using LaTeX so they render beautifully with KaTeX.
- Use INLINE math delimiters: \\( ... \\) — for expressions inside a sentence.
  Example: "The quadratic formula is \\( x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\)"
- Use BLOCK/DISPLAY math delimiters: \\[ ... \\] — for standalone equations that deserve their own line.
  Example: \\[ \\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2} \\]
- NEVER write math as plain text like: sqrt(2), x^2, (-b +/- sqrt(b^2 - 4ac))/2a
- ALWAYS use LaTeX for:
  * Fractions: \\frac{numerator}{denominator}
  * Square roots: \\sqrt{expression}  or  \\sqrt[n]{expression}
  * Exponents: x^{2}  or  e^{-x}
  * Subscripts: x_{i}  or  a_{n}
  * Integrals: \\int, \\iint, \\oint  with limits using _{lower}^{upper}
  * Summations: \\sum_{i=1}^{n}
  * Greek letters: \\alpha, \\beta, \\gamma, \\theta, \\pi, \\sigma, \\omega, etc.
  * Vectors: \\vec{v}  or  \\mathbf{v}
  * Matrices: \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}
  * Calculus: \\frac{d}{dx}, \\frac{\\partial f}{\\partial x}, \\lim_{x \\to 0}
  * Physics: use proper LaTeX for all equations (F = ma, E = mc^2 → \\( E = mc^2 \\))
  * Chemistry: use subscripts for formulas (H₂O → \\( \\text{H}_2\\text{O} \\))
- When in doubt, use LaTeX. Students deserve properly typeset equations.

GENERAL RULES:
- Be warm, encouraging, and clear.
- Use simple English appropriate for university students.
- Structure responses with headings and bullet points for readability.
- Explain concepts step by step, especially for mathematics and science.
`.trim();

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
    // 1. PRIMARY CORE ATTEMPT: Google Gemini
    console.log("🤖 Attempting Primary Core AI (MattieTech AI Framework)...");
    const result = await model.generateContent(fullPrompt);
    return result.response.text();
  } catch (geminiError) {
    console.warn("⚠️ Primary core busy, initiating MattieTech AI Backup Chain:", geminiError.message);

    if (!OPENROUTER_API_KEY) {
      console.error("❌ OPENROUTER_API_KEY is missing. Fallback chain aborted.");
      throw geminiError;
    }

    // Ordered array of free backup models from OpenRouter
    const fallbackChain = [
      "openai/gpt-oss-120b:free",         // Layer 1: OpenAI Free Variant
      "meta-llama/llama-4-maverick:free", // Layer 2: Llama/Claude Alternative
      "deepseek/deepseek-r1:free",        // Layer 3: DeepSeek Reasoning
      "qwen/qwen-2.5-72b-instruct:free"   // Layer 4: Alibaba Qwen
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

module.exports = { askGemini };
