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
window.studyAssetCache = window.studyAssetCache || {};

function setStudyAssetCache(documentId, results) {
  if (!documentId || !results) return;
  window.studyAssetCache[documentId] = {
    ...(window.studyAssetCache[documentId] || {}),
    ...(results || {}),
  };
}

function getStudyAssetCache(documentId) {
  return documentId ? (window.studyAssetCache[documentId] || null) : null;
}

async function fetchAndCacheAIResults(documentId, options = {}) {
  if (!options.forceRefresh) {
    const cachedResults = getStudyAssetCache(documentId);
    if (cachedResults) {
      return { data: { results: cachedResults }, error: null, status: 200, cached: true };
    }
  }

  const result = await apiRequest(`/api/ai/results/${documentId}`);
  if (result.data?.results) {
    setStudyAssetCache(documentId, result.data.results);
  }
  return result;
}

function buildPolishingLoaderHTML(message) {
  return `
    <div class="quiz-engine-workspace result-anim" style="display:flex; align-items:center; justify-content:center; min-height:220px;">
      <div class="card liquid-glass-card" style="max-width:520px; width:100%; padding:28px; text-align:center; border-radius:24px;">
        <div style="width:44px; height:44px; margin:0 auto 16px; border-radius:50%; border:4px solid rgba(0,0,0,0.08); border-top-color:#5b8cff; animation:ctSpin 0.8s linear infinite;"></div>
        <p style="font-weight:700; margin:0 0 8px;">CampusTutor AI is polishing your study assets in the background. Ready in just a few seconds...</p>
        <p style="margin:0; color:var(--label3);">${message || "Please keep this tab open..."}</p>
      </div>
    </div>`;
}

function buildQuizGenerationLoaderHTML() {
  return `
    <div class="quiz-engine-workspace result-anim" style="display:flex; align-items:center; justify-content:center; min-height:260px;">
      <div class="card liquid-glass-card" style="max-width:620px; width:100%; padding:30px; text-align:center; border-radius:24px;">
        <div style="width:48px; height:48px; margin:0 auto 18px; border-radius:50%; border:4px solid rgba(0,0,0,0.08); border-top-color:#ff9f43; animation:ctSpin 0.8s linear infinite;"></div>
        <p style="font-weight:800; margin:0 0 10px;">🔄 Generating Questions... Please wait 1-2 minutes.</p>
        <p style="margin:0; color:var(--label3);">CampusTutor AI is crafting a high-yield interactive exam pool. Deep analysis extraction takes about 1-2 minutes. Please keep this tab open...</p>
      </div>
    </div>`;
}

window.getCachedAIResults = getStudyAssetCache;
window.setCachedAIResults = setStudyAssetCache;
window.fetchAndCacheAIResults = fetchAndCacheAIResults;
window.buildPolishingLoaderHTML = buildPolishingLoaderHTML;
window.buildQuizGenerationLoaderHTML = buildQuizGenerationLoaderHTML;

async function apiGetResults(documentId, options = {}) {
  return fetchAndCacheAIResults(documentId, options);
}

function renderQuizCorrections(reviewData) {
  if (!reviewData || !Array.isArray(reviewData.quizItems) || !reviewData.quizItems.length) {
    return '<div style="padding:16px 0;color:#666;">No correction data is available for this quiz yet.</div>';
  }

  const escapeHTML = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const renderAnswerLine = (label, value, tone = 'neutral') => {
    const background = tone === 'good' ? 'rgba(46,213,115,0.14)' : tone === 'bad' ? 'rgba(255,77,77,0.14)' : 'rgba(0,0,0,0.04)';
    const color = tone === 'good' ? '#2ed573' : tone === 'bad' ? '#ff4d4d' : '#444';
    return `<div style="padding:10px 12px;border-radius:14px;background:${background};color:${color};margin-top:8px;"><strong>${label}:</strong> ${value}</div>`;
  };

  return reviewData.quizItems.map((item, index) => {
    const storedValue = reviewData.answerStore?.[index];
    const isMcq = item.type === 'mcq';
    const correctAnswer = isMcq ? item.question.correctAnswer : (item.question.modelAnswer || (Array.isArray(item.question.keyPoints) ? item.question.keyPoints.join('; ') : item.question.gradingCriteria || ''));
    const explanation = isMcq
      ? (item.question.explanation || item.question.gradingCriteria || 'Review this answer against the lecture notes.')
      : (item.question.gradingCriteria || item.question.modelAnswer || item.question.keyPoints?.join('; ') || 'Review this answer against the lecture notes.');
    const selectedTone = isMcq && storedValue !== correctAnswer ? 'bad' : 'good';

    return `
      <section style="padding:18px;border:1px solid rgba(0,0,0,0.08);border-radius:18px;background:rgba(255,255,255,0.72);box-shadow:0 8px 24px rgba(0,0,0,0.04);display:grid;gap:10px;">
        <div style="font-weight:800;font-size:0.98rem;line-height:1.5;">Question ${index + 1}: ${item.prompt || `Question ${index + 1}`}</div>
        <div style="font-size:0.82rem;color:#666;">${isMcq ? 'Multiple Choice' : 'Written Response'}</div>
        ${isMcq ? renderAnswerLine('Your Answer', escapeHTML(storedValue || 'No answer selected'), selectedTone) : renderAnswerLine('Your Response', escapeHTML(storedValue || 'No response submitted'), storedValue ? 'neutral' : 'bad')}
        ${renderAnswerLine('Correct Answer', escapeHTML(correctAnswer || 'N/A'), 'good')}
        <div style="padding:12px 14px;border-radius:14px;background:rgba(0,0,0,0.03);color:#333;line-height:1.6;">
          <strong>Step-by-step Explanation:</strong> ${escapeHTML(explanation)}
        </div>
      </section>
    `;
  }).join('');
}
window.renderQuizCorrections = renderQuizCorrections;
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

async function regenerateFreshQuiz() {
  const documentId = window.currentQuizDocumentId;
  const targetContainer = resolveQuizTargetContainer();

  if (!documentId) {
    showToast('No active document is available for quiz regeneration.', 'error');
    return;
  }

  if (targetContainer) {
    targetContainer.innerHTML = '';
    targetContainer.style.display = 'block';
  }

  window.mattieQuizState = null;

  const response = await apiGenerateQuestions(documentId);
  if (response.error) {
    showToast(response.error, 'error');
    return;
  }

  if (!targetContainer) {
    showToast('Quiz container not available for regeneration.', 'error');
    return;
  }

  window.quizTargetContainer = targetContainer;
  renderStudyContent(response.data, targetContainer, documentId);
}

window.showPerformanceBanner = function(score, message) {
  const badge = score >= 70 ? "perf-high" : score >= 40 ? "perf-mid" : "perf-low";
  const scoreColor = score >= 70 ? "#2ed573" : score >= 40 ? "#ff9f43" : "#ff4d4d";
  const modalHTML = `
    <div class="performance-modal-overlay result-anim" style="position:fixed; top:0; left:0; width:100vw; height:100vh; display:flex; align-items:center; justify-content:center; z-index:10000; background:rgba(15,23,42,0.4); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); padding:24px; box-sizing:border-box;">
      <div class="performance-card card liquid-glass-card" style="background:rgba(255,255,255,0.7); backdrop-filter:blur(25px); -webkit-backdrop-filter:blur(25px); border:1px solid rgba(255,255,255,0.4); box-shadow:0 20px 50px rgba(0,0,0,0.1); color:#1e293b; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; padding:48px 32px; max-width:620px; width:100%; border-radius:28px; box-sizing:border-box;">
        <div class="card-body" style="width:100%; text-align:center; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; padding:0; box-sizing:border-box;">
          <div class="score-circle" style="background:rgba(255,255,255,0.8); color:${scoreColor}; box-shadow:0 10px 30px rgba(0,0,0,0.05); border:4px solid ${scoreColor}; display:flex; align-items:center; justify-content:center; width:120px; height:120px; border-radius:50%; font-size:2.2rem; font-weight:900; backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px);">${score}%</div>
          <h2 style="font-weight:900; font-size:1.8rem; margin:0; color:${scoreColor};">Evaluation Complete</h2>
          <p style="font-size:1.1rem; line-height:1.7; color:#1e293b; margin:0; max-width:500px; font-weight:600;">${message}</p>
          <div style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center; margin-top:8px; width:100%;">
            <button type="button" onclick="this.closest('.performance-modal-overlay').remove()" class="btn btn-primary btn-lg" style="padding:12px 24px; border-radius:14px; font-weight:700;">Continue Learning</button>
            <button type="button" id="mattie-review-answers-btn" class="btn btn-info" style="padding:12px 20px; border-radius:14px; font-weight:700; background:#0ea5e9; border:none; color:white; cursor:pointer;">🔍 Review Corrections</button>
            <button type="button" id="mattie-refresh-quiz-btn" class="btn btn-secondary" style="padding:12px 20px; border-radius:14px; font-weight:700; background:#64748b; border:none; color:white; cursor:pointer;">🔄 Generate Fresh Quiz</button>
          </div>
          <div id="mattie-review-panel" style="width:100%; max-height:0; opacity:0; overflow:hidden; transition:max-height .45s ease, opacity .35s ease; margin-top:8px;">
            <div id="mattie-review-content" style="display:grid; gap:14px; padding-top:16px; text-align:left; max-height:400px; overflow-y:auto; padding-right:8px;"></div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  const reviewButton = document.getElementById('mattie-review-answers-btn');
  const refreshButton = document.getElementById('mattie-refresh-quiz-btn');
  const reviewPanel = document.getElementById('mattie-review-panel');
  const reviewContent = document.getElementById('mattie-review-content');

  if (reviewButton && reviewPanel && reviewContent) {
    reviewButton.addEventListener('click', () => {
      const reviewData = window.mattieLatestReview;
      reviewContent.innerHTML = renderQuizCorrections(reviewData);
      reviewPanel.style.maxHeight = `${Math.max(720, reviewContent.scrollHeight + 48)}px`;
      reviewPanel.style.opacity = '1';
      if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
        window.MathJax.typesetPromise([reviewContent]).catch(() => {});
      }
    });
  }

  if (refreshButton) {
    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      refreshButton.textContent = '🔄 Generating Questions... Please wait 1-2 minutes.';
      window.mattieQuizState = null;
      await regenerateFreshQuiz();
      const overlay = refreshButton.closest('.performance-modal-overlay');
      if (overlay) {
        overlay.remove();
      }
    });
  }
};

if (typeof window.renderMattieQuiz !== "function") {
  window.renderMattieQuiz = async function(quizData, preferredContainer = null, documentId = null) {
    const container = resolveQuizTargetContainer(preferredContainer);
    if (!quizData || !container) return;

    if (documentId) {
      window.currentQuizDocumentId = documentId;
    }

    const quizItems = [];
    (quizData.mcqs || []).forEach((question, index) => {
      quizItems.push({
        type: "mcq",
        prompt: `Q${index + 1}: ${question.question}`,
        question,
      });
    });

    const writtenPool = [...(quizData.shortAnswer || []), ...(quizData.essays || [])];
    writtenPool.forEach((question, index) => {
      quizItems.push({
        type: "written",
        prompt: `Analytical Q${index + 1}: ${question.question}`,
        question,
      });
    });

    if (quizItems.length === 0) {
      container.innerHTML = `<div class="quiz-engine-workspace result-anim"><div class="card"><div class="card-body">No quiz questions were provided.</div></div></div>`;
      return;
    }

    const quizState = window.mattieQuizState = {
      currentQuestionIndex: 0,
      answerStore: {},
    };

    const syncCurrentAnswer = () => {
      const currentItem = quizItems[quizState.currentQuestionIndex];
      if (!currentItem) return;

      if (currentItem.type === "mcq") {
        const selected = container.querySelector('input[name="quiz-answer"]:checked');
        if (selected) {
          quizState.answerStore[quizState.currentQuestionIndex] = selected.value;
        }
      } else {
        const responseField = container.querySelector(".quiz-text-input");
        quizState.answerStore[quizState.currentQuestionIndex] = responseField ? responseField.value : "";
      }
    };

    const typesetQuizMath = () => {
      if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
        window.MathJax.typesetPromise();
      }
    };

    const submitCurrentQuiz = () => {
      syncCurrentAnswer();

      let correctAnswers = 0;
      let scoredQuestions = 0;
      let completedAnswers = 0;

      quizItems.forEach((item, index) => {
        const storedValue = quizState.answerStore[index];
        const hasAnswer = typeof storedValue === 'string' && storedValue.trim().length > 0;

        if (item.type === 'mcq') {
          scoredQuestions++;
          if (hasAnswer && storedValue === item.question.correctAnswer) {
            correctAnswers++;
          }
        } else if (hasAnswer) {
          completedAnswers++;
        }
      });

      const percentage = scoredQuestions > 0
        ? Math.round((correctAnswers / scoredQuestions) * 100)
        : Math.round((completedAnswers / quizItems.length) * 100);

      const feedback = percentage >= 70 ? "Outstanding Academic Performance! 🔥 — Engineered by MattieTech" :
               percentage >= 40 ? "Good Core Comprehension — Keep reviewing! 📚 — Engineered by MattieTech" :
                       "Needs Improvement. Let's re-study the source material together! 💪 — Engineered by MattieTech";

        window.mattieLatestReview = {
          quizItems,
          answerStore: { ...quizState.answerStore },
        };

      window.showPerformanceBanner(percentage, feedback);
    };

    const renderQuestion = () => {
      const currentItem = quizItems[quizState.currentQuestionIndex];
      const isFirstQuestion = quizState.currentQuestionIndex === 0;
      const isLastQuestion = quizState.currentQuestionIndex === quizItems.length - 1;
      const questionNumber = quizState.currentQuestionIndex + 1;
      const progressPercent = Math.round((questionNumber / quizItems.length) * 100);
      const storedAnswer = quizState.answerStore[quizState.currentQuestionIndex] || "";

      let optionsHTML = "";
      if (currentItem.type === "mcq") {
        const optionKeys = ["A", "B", "C", "D"];
        optionsHTML = `
          <div class="quiz-options-grid" style="display:flex; flex-direction:column; gap:12px; margin-top:18px;">
            ${optionKeys
              .filter((key) => currentItem.question.options && Object.prototype.hasOwnProperty.call(currentItem.question.options, key))
              .map((key) => {
                const optionText = currentItem.question.options[key];
                const isChecked = storedAnswer === key ? "checked" : "";
                return `
                  <label class="quiz-option-label" style="display:flex; align-items:flex-start; gap:14px; padding:16px 18px; border-radius:18px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.04); cursor:pointer; transition:transform .18s ease, border-color .18s ease, background .18s ease;">
                    <input type="radio" name="quiz-answer" value="${key}" data-correct="${currentItem.question.correctAnswer}" ${isChecked} style="margin-top:3px; flex:0 0 auto;">
                    <span class="option-indicator" style="display:inline-flex; align-items:center; justify-content:center; min-width:34px; height:34px; border-radius:999px; font-weight:800; background:rgba(255,255,255,0.10);">${key}</span>
                    <span style="display:block; line-height:1.5;">${optionText}</span>
                  </label>`;
              })
              .join("")}
          </div>`;
      } else {
        optionsHTML = `
          <textarea class="quiz-text-input form-control" placeholder="Type your academic response here..." style="min-height:220px; margin-top:18px; resize:vertical;">${storedAnswer}</textarea>`;
      }

      container.innerHTML = `
        <div class="quiz-engine-workspace result-anim" style="max-width:860px; margin:0 auto;">
          <div class="card liquid-glass-card" style="border-radius:28px; overflow:hidden; box-shadow:0 24px 80px rgba(0,0,0,0.22);">
            <div class="card-body" style="padding:28px;">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; flex-wrap:wrap;">
                <div>
                  <h2 style="font-size:1.2rem; font-weight:800; margin-bottom:6px;">📝 Academic Performance Evaluation</h2>
                  <p style="font-size:0.88rem; color:var(--label3); margin:0;">Question ${questionNumber} of ${quizItems.length}</p>
                </div>
                <div style="min-width:180px; text-align:right; color:var(--label3); font-size:0.82rem;">${progressPercent}% complete</div>
              </div>
              <div style="height:10px; border-radius:999px; background:rgba(255,255,255,0.08); overflow:hidden; margin-bottom:24px;">
                <div style="height:100%; width:${progressPercent}%; border-radius:999px; background:linear-gradient(90deg, #76c8ff, #5b8cff); transition:width .25s ease;"></div>
              </div>
              <div class="quiz-question-card" style="padding:24px; border-radius:24px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08);">
                <p class="quiz-prompt" style="font-size:1.05rem; font-weight:700; margin-bottom:12px;">${currentItem.prompt}</p>
                ${optionsHTML}
              </div>
              <div style="display:flex; gap:12px; justify-content:space-between; margin-top:24px; flex-wrap:wrap;">
                <button type="button" id="quiz-prev-btn" class="btn btn-secondary" ${isFirstQuestion ? "disabled" : ""} style="min-width:120px;">Prev</button>
                <div style="display:flex; gap:12px; margin-left:auto; flex-wrap:wrap;">
                    ${isLastQuestion ? `<button type="button" id="submit-mattie-quiz" class="btn btn-primary btn-lg" style="min-width:190px;">Submit Assessment</button>` : `<button type="button" id="quiz-next-btn" class="btn btn-primary btn-lg" style="min-width:120px;">Next</button>`}
                </div>
              </div>
            </div>
          </div>
        </div>`;

      container.style.display = 'block';
      container.scrollIntoView({ behavior: 'smooth', block: 'start' });

      if (currentItem.type === "mcq") {
        container.querySelectorAll('input[name="quiz-answer"]').forEach((input) => {
          input.addEventListener("change", () => {
            quizState.answerStore[quizState.currentQuestionIndex] = input.value;
          });
        });
      } else {
        const responseField = container.querySelector(".quiz-text-input");
        if (responseField) {
          responseField.addEventListener("input", (event) => {
            quizState.answerStore[quizState.currentQuestionIndex] = event.target.value;
          });
        }
      }

      const prevButton = container.querySelector('#quiz-prev-btn');
      const nextButton = container.querySelector('#quiz-next-btn');
      const submitButton = container.querySelector('#submit-mattie-quiz');

      if (prevButton) {
        prevButton.addEventListener('click', (event) => {
          event.preventDefault();
          syncCurrentAnswer();
          quizState.currentQuestionIndex = Math.max(0, quizState.currentQuestionIndex - 1);
          renderQuestion();
        });
      }

      if (nextButton) {
        nextButton.addEventListener('click', (event) => {
          event.preventDefault();
          syncCurrentAnswer();
          quizState.currentQuestionIndex = Math.min(quizItems.length - 1, quizState.currentQuestionIndex + 1);
          renderQuestion();
        });
      }

      if (submitButton) {
        submitButton.addEventListener('click', (event) => {
          event.preventDefault();
          container.style.display = 'none';
          container.innerHTML = '';
          window.scrollTo({ top: 0, behavior: 'smooth' });
          submitCurrentQuiz();
        });
      }

      typesetQuizMath();
    };

    renderQuestion();
  };
}

function renderStudyContent(data, container, documentId = null) {
  if (!data || !container) return;

  if (documentId) {
    window.currentQuizDocumentId = documentId;
  }

  container.style.display = 'block';

  if (data && typeof data === "object" && data.__html) {
    container.innerHTML = data.__html;
    return;
  }

  // Check if data.questions exists (nested structure from backend)
  if (data && typeof data === "object" && data.questions) {
    console.log("Rendering nested quiz payload...");
    const quizPayload = data.questions;
    if (typeof renderMattieQuiz === "function") {
      container.innerHTML = ""; // Clear loader text
      // Force the quiz to render inside the ACTIVE page container passed from study.html
      window.quizTargetContainer = container; 
      renderMattieQuiz(quizPayload, container, window.currentQuizDocumentId || null);
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
      renderMattieQuiz(data, container, window.currentQuizDocumentId || null);
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
