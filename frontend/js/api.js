// ============================================================
// js/api.js — CampusTutor AI Frontend API Helper
// ============================================================

const API_BASE = "https://campustutor-backend.onrender.com";

// ── AUTH HELPERS ──────────────────────────────────────────────
function getToken()    { return localStorage.getItem("ct_token"); }
function getUser()     { const r = localStorage.getItem("ct_user"); return r ? JSON.parse(r) : null; }
function isLoggedIn()  { return !!getToken(); }

function logout() {
  localStorage.removeItem("ct_token");
  localStorage.removeItem("ct_user");
  window.location.href = "/pages/login.html";
}

// ── CORE FETCH WRAPPER ────────────────────────────────────────
async function apiRequest(endpoint, method = "GET", body = null) {
  try {
    const headers = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const options = { method, headers };
    if (body && method !== "GET") options.body = JSON.stringify(body);

    const fullUrl = `${API_BASE}${endpoint}`;
    console.log(`API: ${method} ${fullUrl}`);
    const response = await fetch(fullUrl, options);
    
    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      console.error("Failed to parse JSON response:", parseErr);
      data = { error: "Server returned invalid response" };
    }

    if (!response.ok) {
      console.warn(`API Error ${response.status}:`, data);
      // Check if session expired (401 Unauthorized)
      if (response.status === 401) {
        console.warn("⏰ Session expired. Logging out...");
        localStorage.removeItem("ct_token");
        localStorage.removeItem("ct_user");
        window.location.href = "/pages/login.html?status=expired";
        return { 
          data: null, 
          error: "Your session has expired. Please log in again.",
          status: response.status,
          expired: true
        };
      }
      
      // Check if user was banned (403 with banned flag)
      if (response.status === 403 && data.banned) {
        console.warn("⛔ User account has been banned!");
        logout(); // Force logout
        return { 
          data: null, 
          error: "Your account has been banned.",
          status: response.status,
          banned: true
        };
      }
      
      // Pass along the status code for better error handling (especially 429)
      return { 
        data: null, 
        error: data.error || `Server error (${response.status})`,
        status: response.status
      };
    }
    return { data, error: null, status: response.status };
  } catch (err) {
    console.error("API request network error:", err);
    return { data: null, error: err.message || "Network error. Is the server running?", status: 0 };
  }
}

// ── AUTH ──────────────────────────────────────────────────────
async function apiSignup(fullName, email, password) {
  return apiRequest("/api/auth/signup", "POST", { fullName, email, password });
}

async function apiLogin(email, password) {
  const result = await apiRequest("/api/auth/login", "POST", { email, password });
  if (result.data) {
    localStorage.setItem("ct_token", result.data.token);
    localStorage.setItem("ct_user", JSON.stringify(result.data.user));
    
    // DEBUG: Log what we got back from the server
    console.log("🔐 Login successful. User data:", result.data.user);
    console.log("📦 app_metadata:", result.data.user.app_metadata);
    console.log("👤 role:", result.data.user.role);
    console.log("✅ Is admin?", result.data.user.app_metadata?.role === "admin" || result.data.user.role === "admin");
  }
  return result;
}

// ── UPLOAD ────────────────────────────────────────────────────
async function apiUploadPDF(file) {
  try {
    const formData = new FormData();
    formData.append("pdf", file);
    const response = await fetch(`${API_BASE}/api/upload/pdf`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) return { data: null, error: data.error || "Upload failed." };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: "Upload failed. Check your connection." };
  }
}

async function apiGetMyDocs()           { return apiRequest("/api/upload/my-docs"); }
async function apiDeleteDoc(id)         { return apiRequest(`/api/upload/${id}`, "DELETE"); }

// ── ACTIVITY ──────────────────────────────────────────────────
// Get user's activity log
async function apiGetActivity()         { return apiRequest("/api/upload/my-activity"); }
// Get user's AI results (summaries, flashcards, etc.)
async function apiGetMyAIResults()      { return apiRequest("/api/upload/my-results"); }

// ── STATS ─────────────────────────────────────────────────────
// Get user's XP, level, streak, and achievements
async function apiGetUserStats(userId) { return apiRequest(`/api/upload/stats/${userId}`); }

// ── AI ────────────────────────────────────────────────────────
async function apiSummarize(documentId)           { return apiRequest("/api/ai/summarize", "POST", { documentId }); }
async function apiExplain(documentId, concept)    { return apiRequest("/api/ai/explain", "POST", { documentId, concept }); }
async function apiGenerateQuestions(documentId)   { return apiRequest("/api/ai/questions", "POST", { documentId }); }
async function apiGenerateFlashcards(documentId)  { return apiRequest("/api/ai/flashcards", "POST", { documentId }); }
async function apiGetResults(documentId)          { return apiRequest(`/api/ai/results/${documentId}`); }
// ── DOWNLOADS ──────────────────────────────────────────────
// Download generated content as files (TXT, CSV)
function downloadFile(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function downloadSummaryTXT(documentId) {
  const url = `/api/ai/download/summary/${documentId}/txt`;
  downloadFile(url, "summary.txt");
  showToast("Summary downloaded! 📥", "success");
}

async function downloadFlashcardsCSV(documentId) {
  const url = `/api/ai/download/flashcards/${documentId}/csv`;
  downloadFile(url, "flashcards.csv");
  showToast("Flashcards downloaded! 📥", "success");
}

async function downloadQuestionsTXT(documentId) {
  const url = `/api/ai/download/questions/${documentId}/txt`;
  downloadFile(url, "questions.txt");
  showToast("Questions downloaded! 📥", "success");
}

async function downloadExplanationTXT(documentId) {
  const url = `/api/ai/download/explanation/${documentId}/txt`;
  downloadFile(url, "explanation.txt");
  showToast("Explanation downloaded! 📥", "success");
}
// ── CONTACT ───────────────────────────────────────────────────
async function apiSendContactMessage(name, email, message) {
  return apiRequest("/api/contact", "POST", { name, email, message });
}

// ── ADMIN ─────────────────────────────────────────────────────
async function apiAdminGetStats()                         { return apiRequest("/api/admin/stats"); }
async function apiAdminGetRecentActivities(limit = 50)    { return apiRequest(`/api/admin/recent-activities?limit=${limit}`); }
async function apiAdminGetUsers(search = "", status = "") {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  const qs = params.toString() ? `?${params}` : "";
  return apiRequest(`/api/admin/users${qs}`);
}
async function apiAdminGetActivity(userId)                { return apiRequest(`/api/admin/users/${userId}/activity`); }
async function apiAdminGetUserFiles(userId)               { return apiRequest(`/api/admin/users/${userId}/files`); }
async function apiAdminGetAIInteractions(userId)          { return apiRequest(`/api/admin/users/${userId}/ai-interactions`); }
async function apiAdminBanUser(userId, reason)            { return apiRequest(`/api/admin/users/${userId}/ban`, "POST", { reason }); }
async function apiAdminUnbanUser(userId)                  { return apiRequest(`/api/admin/users/${userId}/unban`, "POST"); }
async function apiAdminDeleteUser(userId)                 { return apiRequest(`/api/admin/users/${userId}`, "DELETE"); }
async function apiAdminSetRole(userId, role)              { return apiRequest(`/api/admin/users/${userId}/set-role`, "POST", { role }); }
async function apiAdminResetPassword(userId, newPassword) { return apiRequest(`/api/admin/users/${userId}/reset-password`, "POST", { newPassword }); }

// ── UTILITIES ─────────────────────────────────────────────────

function showToast(message, type = "info") {
  const existing = document.getElementById("toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "toast";
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function requireAuth() {
  if (!isLoggedIn()) window.location.href = "/pages/login.html";
}

function requireAdmin() {
  console.log("🔐 Checking admin access...");
  
  if (!isLoggedIn()) { 
    console.warn("❌ Not logged in");
    window.location.href = "/pages/login.html"; 
    return; 
  }
  
  const user = getUser();
  console.log("👤 User object from localStorage:", user);
  console.log("📦 app_metadata:", user?.app_metadata);
  console.log("👤 role property:", user?.role);
  
  // Check admin role in app_metadata (where Supabase stores it)
  const userRole = user?.app_metadata?.role || user?.role;
  console.log("🔍 Checking role: userRole =", userRole);
  
  if (!user || userRole !== "admin") {
    console.warn("❌ Access denied: Not an admin user. Role:", userRole);
    window.location.href = "/pages/dashboard.html";
    return;
  }
  
  console.log("✅ Access granted: User is admin");
}

function redirectIfLoggedIn() {
  if (isLoggedIn()) window.location.href = "/pages/dashboard.html";
}

function formatDate(isoString) {
  if (!isoString) return "Never";
  return new Date(isoString).toLocaleDateString("en-NG", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function formatDateTime(isoString) {
  if (!isoString) return "Never";
  return new Date(isoString).toLocaleString("en-NG", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── CONTENT DISPATCHER ────────────────────────────────────────
// Routes AI content to the correct renderer based on data type.
// Use this in study.html instead of calling markdownToHTML directly.
function resolveQuizTargetContainer(preferredContainer = null) {
  return preferredContainer
    || window.quizTargetContainer
    || document.getElementById('tabContent')
    || document.getElementById('quizWorkspace')
    || document.getElementById('study-output')
    || document.getElementById('resultsArea');
}

if (typeof window.renderMattieQuiz !== "function") {
  window.renderMattieQuiz = async function(quizData, preferredContainer = null) {
    const container = resolveQuizTargetContainer(preferredContainer);
    if (!quizData || !container) return;

    let html = `<div class="quiz-engine-workspace result-anim">`;
    html += `<h2 style="font-size:1.2rem;font-weight:800;margin-bottom:8px;">📝 Academic Performance Evaluation</h2>`;
    html += `<p style="font-size:0.85rem;color:var(--label3);margin-bottom:24px;">Complete the following synthesis assessment based on your study material.</p>`;

    if (quizData.mcqs && quizData.mcqs.length > 0) {
      html += `<div class="quiz-section"><h3>Multiple Choice Section</h3>`;
      quizData.mcqs.forEach((q, idx) => {
        html += `
          <div class="quiz-question-card card mb-3">
            <div class="card-body">
              <p class="quiz-prompt">Q${idx + 1}: ${q.question}</p>
              <div class="quiz-options-grid">
                ${Object.entries(q.options).map(([key, text]) => `
                  <label class="quiz-option-label">
                    <input type="radio" name="mcq-${idx}" value="${key}" data-correct="${q.correctAnswer}">
                    <span class="option-indicator">${key}</span> ${text}
                  </label>
                `).join('')}
              </div>
            </div>
          </div>`;
      });
      html += `</div>`;
    }

    const writtenPool = [...(quizData.shortAnswer || []), ...(quizData.essays || [])];
    if (writtenPool.length > 0) {
      html += `<div class="quiz-section"><h3>Deep Conceptual Breakdown</h3>`;
      writtenPool.forEach((q, idx) => {
        html += `
          <div class="quiz-question-card card mb-3">
            <div class="card-body">
              <p class="quiz-prompt">Analytical Q${idx + 1}: ${q.question}</p>
              <textarea class="quiz-text-input form-control" placeholder="Type your academic response here..."></textarea>
            </div>
          </div>`;
      });
      html += `</div>`;
    }

    html += `<button id="submit-mattie-quiz" class="btn btn-primary w-100 mt-4 btn-lg">Submit Assessment</button>`;
    html += `</div>`;

    container.innerHTML = html;
    container.style.display = 'block';
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });

    document.getElementById('submit-mattie-quiz').addEventListener('click', () => {
      let score = 0;
      const totalMCQs = quizData.mcqs ? quizData.mcqs.length : 0;

      if (totalMCQs > 0) {
        quizData.mcqs.forEach((q, idx) => {
          const selected = document.querySelector(`input[name="mcq-${idx}"]:checked`);
          if (selected && selected.value === selected.getAttribute('data-correct')) score++;
        });
      }

      const percentage = totalMCQs > 0 ? Math.round((score / totalMCQs) * 100) : 100;
      const feedback = percentage >= 70 ? "Outstanding Academic Performance! 🔥 — Engineered by MattieTech" :
                       percentage >= 50 ? "Good Core Comprehension — Keep reviewing! 📚 — Engineered by MattieTech" :
                       "Needs Improvement. Let's re-study the source material together! 💪 — Engineered by MattieTech";

      showPerformanceBanner(percentage, feedback);
    });

    if (window.MathJax) window.MathJax.typesetPromise([container]);
  };
}

function renderStudyContent(data, container) {
  if (!data || !container) return;

  // Ensure the target container is active and visible
  container.style.display = 'block';

  // Check if data.questions exists (nested structure from backend)
  if (data && typeof data === "object" && data.questions) {
    console.log("Rendering nested quiz payload...");
    const quizPayload = data.questions;
    if (typeof renderMattieQuiz === "function") {
      container.innerHTML = ""; // Clear loader text
      // Force the quiz to render inside the ACTIVE page container passed from study.html
      window.quizTargetContainer = container; 
      renderMattieQuiz(quizPayload, container);
      return;
    }
    container.innerHTML = `<div class="error">Quiz renderer not available.</div>`;
    return;
  }

  // Handle direct structured objects or flashcards
  if (typeof data === "object" && (data.mcqs || data.shortAnswer || data.flashcards)) {
    console.log("Rendering structured quiz/flashcard data...");
    if (typeof renderMattieQuiz === "function") {
      container.innerHTML = ""; // Clear loader text
      // Force the quiz to render inside the ACTIVE page container passed from study.html
      window.quizTargetContainer = container; 
      renderMattieQuiz(data, container);
    } else {
      container.innerHTML = `<div class="error">Quiz renderer not found.</div>`;
    }
  } else {
    // It's a standard text string (Summary or Explanation)
    container.innerHTML = markdownToHTML(data);
    renderMath(container);
  }
}

// ── MARKDOWN → HTML ───────────────────────────────────────────
function markdownToHTML(text) {
  if (!text || typeof text !== "string") return "";

  // Protect LaTeX math blocks from being mangled by markdown parsing.
  // We replace them with placeholders, process markdown, then restore.
  const mathBlocks = [];
  let idx = 0;

  // Protect display math \[ ... \]
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (match) => {
    const key = `__MATHBLOCK${idx++}__`;
    mathBlocks.push({ key, val: match });
    return key;
  });

  // Protect inline math \( ... \)
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (match) => {
    const key = `__MATHINLINE${idx++}__`;
    mathBlocks.push({ key, val: match });
    return key;
  });

  // Process markdown
  let html = text
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(?!<[hul])(.+)$/gm, "<p>$1</p>")
    .replace(/<p><\/p>/g, "");

  // Restore math blocks
  mathBlocks.forEach(({ key, val }) => {
    html = html.replace(key, val);
  });

  return html;
}

// ── KaTeX MATH RENDERER ───────────────────────────────────────
// Call this after injecting AI output into the DOM.
// It scans the element for \( \) inline and \[ \] display math
// and renders them with KaTeX.
// KaTeX must be loaded on the page (via CDN link in HTML).
function renderMath(element) {
  if (typeof renderMathInElement === "undefined" || !element) return;
  try {
    renderMathInElement(element, {
      delimiters: [
        { left: "\\[",  right: "\\]",  display: true  },
        { left: "\\(",  right: "\\)",  display: false },
        { left: "$$",   right: "$$",   display: true  },
        { left: "$",    right: "$",    display: false },
      ],
      throwOnError: false, // Degrade gracefully if expression is malformed
      errorColor: "#cc0000",
    });
  } catch (e) {
    // KaTeX auto-render failed silently — not a critical error
  }
}
