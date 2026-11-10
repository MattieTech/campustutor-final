// ============================================================
// js/api.js — CampusTutor AI Frontend API Helper
// ============================================================

// API_BASE: The backend API runs on Render. When developing locally on port 3000, use ""; otherwise always point to the live Render backend.
const API_BASE = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && window.location.port === "3000"
  ? ""
  : "https://campustutor-backend.onrender.com";

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
      if (response.status === 401 && !endpoint.includes("/api/auth/")) {
        console.warn("[Session] Session expired. Logging out...");
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
        console.warn("[Auth] User account has been banned!");
        logout(); // Force logout
        return { 
          data: null, 
          error: "Your account has been banned.",
          status: response.status,
          banned: true
        };
      }

      // Check if insufficient coins (do NOT redirect to pricing if coins modal should handle it)
      if (response.status === 403 && (data.insufficientCoins || data.needCoins || data.coinsNeeded)) {
        return {
          data: null,
          error: data.error || "CampusCoins or an active subscription required.",
          status: response.status,
          needCoins: true,
          insufficientCoins: true,
          coinsNeeded: true,
          needed: data.needed,
          currentCoins: data.currentCoins ?? data.coins ?? 0,
        };
      }

      // Check if subscription required (403 with subscriptionRequired flag)
      if (response.status === 403 && data.subscriptionRequired) {
        console.warn("[Billing] Active subscription required. Redirecting to pricing...");
        if (!window.location.pathname.includes("pricing.html")) {
          window.location.href = "/pages/pricing.html?reason=paywall";
        }
        return {
          data: null,
          error: data.error || "Active subscription required.",
          status: response.status,
          subscriptionRequired: true
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
async function apiSignup(fullName, email, password, referredBy = null) {
  return apiRequest("/api/auth/signup", "POST", { fullName, email, password, referredBy });
}


// ── FETCH CURRENT USER PROFILE ────────────────────────────────
async function apiGetMe() {
  const res = await apiRequest("/api/auth/me");
  if (res.data && res.data.user) {
    localStorage.setItem("ct_user", JSON.stringify(res.data.user));
    if (res.data.user.coins !== undefined) {
      userCoinState.coins = Number(res.data.user.coins);
      if (res.data.user.streak !== undefined) {
        userCoinState.streak = Number(res.data.user.streak);
      }
      if (res.data.user.canClaimDaily !== undefined) {
        userCoinState.canClaimDaily = Boolean(res.data.user.canClaimDaily);
      }
      updateCoinUIElements();
    }
    return res.data.user;
  }
  return null;
}
window.apiGetMe = apiGetMe;

async function apiLogin(email, password) {
  const result = await apiRequest("/api/auth/login", "POST", { email, password });
  if (result.data) {
    localStorage.setItem("ct_token", result.data.token);
    localStorage.setItem("ct_user", JSON.stringify(result.data.user));
    
    // DEBUG: Log what we got back from the server
    console.log("[Auth] Login successful. User data:", result.data.user);
    console.log("[Auth] app_metadata:", result.data.user.app_metadata);
    console.log("[Auth] role:", result.data.user.role);
    console.log("[Auth] Is admin?", result.data.user.app_metadata?.role === "admin" || result.data.user.role === "admin");
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

// Get user's XP, level, streak, and achievements
async function apiGetUserStats(userId) { return apiRequest(`/api/upload/stats/${userId}`); }
// Get leaderboard top users by XP
async function apiGetLeaderboard()      { return apiRequest("/api/upload/leaderboard"); }

// ── AI ────────────────────────────────────────────────────────
async function apiSummarize(documentId, summarySize = 'standard')           { return apiRequest("/api/ai/summarize", "POST", { documentId, summarySize }); }
async function apiExplain(documentId, concept)    { return apiRequest("/api/ai/explain", "POST", { documentId, concept }); }
async function apiGenerateQuestions(documentId, quizSize = 10)   { return apiRequest("/api/ai/questions", "POST", { documentId, quizSize }); }
async function apiGenerateFlashcards(documentId, flashcardSize = 25)  { return apiRequest("/api/ai/flashcards", "POST", { documentId, flashcardSize }); }

// ── CAMPUS COINS & ECONOMY ─────────────────────────────────────
async function apiGetCoinBalance() { return apiRequest("/api/coins/balance"); }
window.apiGetWallet = apiGetCoinBalance;
async function apiClaimDailyBonus() { return apiRequest("/api/coins/claim-daily", "POST"); }
async function apiBuyCoinPackage(packageId) { return apiRequest("/api/coins/buy-package", "POST", { packageId, callbackUrl: window.location.href }); }
async function apiGetCoinHistory() { return apiRequest("/api/coins/history"); }

// ── PROBLEM SOLVER & ESSAY POLISH ─────────────────────────────
async function apiSolveProblem(question, subject = "General") { return apiRequest("/api/ai/solve-problem", "POST", { question, subject }); }
async function apiPolishEssay(text, citationStyle = "APA 7th Edition") { return apiRequest("/api/ai/polish-essay", "POST", { text, citationStyle }); }

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

function buildQuizGenerationLoaderHTML(waitingTime = "1-2 minutes") {
  return `
    <div class="quiz-engine-workspace result-anim" style="display:flex; align-items:center; justify-content:center; min-height:260px;">
      <div class="card liquid-glass-card" style="max-width:620px; width:100%; padding:30px; text-align:center; border-radius:24px;">
        <div style="width:48px; height:48px; margin:0 auto 18px; border-radius:50%; border:4px solid rgba(0,0,0,0.08); border-top-color:#ff9f43; animation:ctSpin 0.8s linear infinite;"></div>
        <p style="font-weight:800; margin:0 0 10px;"><i class="fa-solid fa-arrows-rotate fa-spin" style="color:var(--blue);margin-right:6px;"></i> Generating Questions... Please wait ${waitingTime}.</p>
        <p style="margin:0; color:var(--label3);">CampusTutor AI is crafting a high-yield interactive exam pool. Deep analysis extraction takes about ${waitingTime}. Please keep this tab open...</p>
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

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderQuizCorrections(reviewData) {
  if (!reviewData || !Array.isArray(reviewData.quizItems) || !reviewData.quizItems.length) {
    return '<div style="padding:16px 0;color:#666;">No correction data is available for this quiz yet.</div>';
  }

  const renderAnswerLine = (label, value, tone = 'neutral') => {
    const background = tone === 'good' ? 'rgba(46,213,115,0.14)' : tone === 'bad' ? 'rgba(255,77,77,0.14)' : 'rgba(0,0,0,0.04)';
    const color = tone === 'good' ? '#2ed573' : tone === 'bad' ? '#ff4d4d' : '#444';
    return `<div style="padding:10px 12px;border-radius:14px;background:${background};color:${color};margin-top:8px;"><strong>${label}:</strong> ${value}</div>`;
  };

  return reviewData.quizItems.map((item, index) => {
    const storedValue = reviewData.answerStore?.[index];
    const isMcq = item.type === 'mcq';
    
    let correctAnswer = isMcq ? item.question.correctAnswer : (item.question.modelAnswer || (Array.isArray(item.question.keyPoints) ? item.question.keyPoints.join('; ') : item.question.gradingCriteria || ''));
    let explanation = isMcq
      ? (item.question.explanation || item.question.gradingCriteria || 'Review this answer against the lecture notes.')
      : (item.question.gradingCriteria || item.question.modelAnswer || item.question.keyPoints?.join('; ') || 'Review this answer against the lecture notes.');
    
    let displayYourAnswer = storedValue || (isMcq ? 'No answer selected' : 'No response submitted');
    let displayCorrectAnswer = correctAnswer || 'N/A';

    if (isMcq) {
      if (storedValue && item.question.options && item.question.options[storedValue]) {
        displayYourAnswer = `${storedValue}: ${item.question.options[storedValue]}`;
      }
      if (correctAnswer && item.question.options && item.question.options[correctAnswer]) {
        displayCorrectAnswer = `${correctAnswer}: ${item.question.options[correctAnswer]}`;
      }
    }

    const selectedTone = isMcq && storedValue !== correctAnswer ? 'bad' : 'good';

    return `
      <section style="padding:18px;border:1px solid rgba(0,0,0,0.08);border-radius:18px;background:rgba(255,255,255,0.72);box-shadow:0 8px 24px rgba(0,0,0,0.04);display:grid;gap:10px;">
        <div style="font-weight:800;font-size:0.98rem;line-height:1.5;">Question ${index + 1}: ${item.prompt || `Question ${index + 1}`}</div>
        <div style="font-size:0.82rem;color:#666;">${isMcq ? 'Multiple Choice' : 'Written Response'}</div>
        ${isMcq ? renderAnswerLine('Your Answer', escapeHTML(displayYourAnswer), selectedTone) : renderAnswerLine('Your Response', escapeHTML(displayYourAnswer), storedValue ? 'neutral' : 'bad')}
        ${renderAnswerLine('Correct Answer', escapeHTML(displayCorrectAnswer), 'good')}
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
  showToast("Summary downloaded successfully!", "success");
}

async function downloadFlashcardsCSV(documentId) {
  const url = `/api/ai/download/flashcards/${documentId}/csv`;
  downloadFile(url, "flashcards.csv");
  showToast("Flashcards downloaded successfully!", "success");
}

async function downloadQuestionsTXT(documentId) {
  const url = `/api/ai/download/questions/${documentId}/txt`;
  downloadFile(url, "questions.txt");
  showToast("Questions downloaded successfully!", "success");
}

async function downloadExplanationTXT(documentId) {
  const url = `/api/ai/download/explanation/${documentId}/txt`;
  downloadFile(url, "explanation.txt");
  showToast("Explanation downloaded successfully!", "success");
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
  toast.innerHTML = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function requireAuth() {
  if (!isLoggedIn()) window.location.href = "/pages/login.html";
}

async function requirePaidSubscription() {
  if (!isLoggedIn()) {
    window.location.href = "/pages/login.html";
    return false;
  }
  // Sync latest user profile from server in background to ensure upgraded status is recognized
  try {
    const user = getUser();
    if (user && user.plan === 'free') {
      apiGetMe().catch(() => {});
    }
  } catch(e) {}
  return true;
}
window.requirePaidSubscription = requirePaidSubscription;

function requireAdmin() {
  console.log("[Admin] Checking admin access...");
  
  if (!isLoggedIn()) { 
    console.warn("[Admin] Not logged in");
    window.location.href = "/pages/login.html"; 
    return; 
  }
  
  const user = getUser();
  console.log("[Admin] User object from localStorage:", user);
  console.log("[Admin] app_metadata:", user?.app_metadata);
  console.log("[Admin] role property:", user?.role);
  
  // Check admin role in app_metadata (where Supabase stores it)
  const userRole = user?.app_metadata?.role || user?.role;
  console.log("[Admin] Checking role: userRole =", userRole);
  
  if (!user || userRole !== "admin") {
    console.warn("[Admin] Access denied: Not an admin user. Role:", userRole);
    window.location.href = "/pages/dashboard.html";
    return;
  }
  
  console.log("[Admin] Access granted: User is admin");
}

function redirectIfLoggedIn(options = {}) {
  if (!isLoggedIn()) return false;
  
  const params = new URLSearchParams(window.location.search);
  if (params.get('stay') === 'true' || params.get('switch') === 'true' || options.stay) {
    return true;
  }

  // If a banner container exists on the page (like login.html or signup.html), render session alert instead of abrupt redirect
  const banner = document.getElementById('alreadyLoggedInBanner');
  if (banner) {
    const user = getUser();
    const name = user?.fullName || user?.name || user?.email || 'Logged In Scholar';
    const email = user?.email || '';
    banner.innerHTML = `
      <div class="auth-session-card">
        <div class="auth-session-head">
          <div class="auth-session-avatar"><i class="fa-solid fa-circle-user"></i></div>
          <div class="auth-session-text">
            <div class="auth-session-title">Currently Signed In</div>
            <div class="auth-session-sub">You are active as <strong>${escapeHTML(name)}</strong>${email ? ` (${escapeHTML(email)})` : ''}</div>
          </div>
        </div>
        <div class="auth-session-actions">
          <a href="/pages/dashboard.html" class="btn btn-primary btn-sm"><i class="fa-solid fa-arrow-right"></i> Continue to Dashboard</a>
          <button type="button" onclick="logoutAndStay()" class="btn btn-ghost btn-sm"><i class="fa-solid fa-right-from-bracket"></i> Switch Account / Log Out</button>
        </div>
      </div>
    `;
    banner.style.display = 'block';
    return true;
  }

  window.location.href = "/pages/dashboard.html";
  return true;
}

function logoutAndStay() {
  localStorage.removeItem("ct_token");
  localStorage.removeItem("ct_user");
  window.location.reload();
}
window.logoutAndStay = logoutAndStay;
window.redirectIfLoggedIn = redirectIfLoggedIn;

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
            <button type="button" onclick="this.closest('.performance-modal-overlay').remove()" class="btn btn-primary btn-lg" style="padding:12px 24px; border-radius:14px; font-weight:700;"><i class="fa-solid fa-arrow-right"></i> Continue Learning</button>
            <button type="button" id="mattie-review-answers-btn" class="btn btn-info" style="padding:12px 20px; border-radius:14px; font-weight:700; background:#0ea5e9; border:none; color:white; cursor:pointer;"><i class="fa-solid fa-magnifying-glass"></i> Review Corrections</button>
            <button type="button" id="mattie-refresh-quiz-btn" class="btn btn-secondary" style="padding:12px 20px; border-radius:14px; font-weight:700; background:#64748b; border:none; color:white; cursor:pointer;"><i class="fa-solid fa-arrows-rotate"></i> Generate Fresh Quiz</button>
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
    refreshButton.addEventListener('click', () => {
      const overlay = refreshButton.closest('.performance-modal-overlay');
      if (overlay) {
        overlay.remove();
      }

      // Set force fresh flag so the caching layer is bypassed
      window.mattieForceFreshQuiz = true;

      const quizContainer = document.getElementById('quizSizeSelectContainer');
      if (quizContainer) {
        const sumContainer = document.getElementById('summarySizeSelectContainer');
        const flashContainer = document.getElementById('flashcardSizeSelectContainer');
        if (sumContainer) sumContainer.style.display = 'none';
        if (flashContainer) flashContainer.style.display = 'none';

        quizContainer.style.display = 'block';
        quizContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });

        if (typeof showToast === 'function') {
          showToast('Select the number of questions you want for your new quiz!', 'info');
        }
      } else {
        regenerateFreshQuiz();
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

      const feedback = percentage >= 70 ? "Outstanding Academic Performance! — Engineered by MattieTech" :
               percentage >= 40 ? "Good Core Comprehension — Keep reviewing! — Engineered by MattieTech" :
                       "Needs Improvement. Let's re-study the source material together! — Engineered by MattieTech";

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
                  <h2 style="font-size:1.2rem; font-weight:800; margin-bottom:6px;"><i class="fa-solid fa-graduation-cap anim-bulb" style="color:var(--blue);margin-right:8px;"></i>Academic Performance Evaluation</h2>
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
function preProcessMathDelimiters(text) {
  if (!text) return "";
  // Safely convert [ ... ] to $$ ... $$ if it contains algebraic patterns like ^, _, \ or = and no plain English words
  let processed = text.replace(/\[\s*([^\]\n]{1,80}?)\s*\]/g, (match, p1) => {
    const hasMath = /[\^_\+\-\*\/\\=]/.test(p1);
    const hasWords = /\b(the|and|where|is|are|of|in|to|for|with)\b/i.test(p1);
    if (hasMath && !hasWords) {
      return `$$${p1}$$`;
    }
    return match;
  });
  return processed;
}

// ── MARKDOWN → HTML ───────────────────────────────────────────
function markdownToHTML(text) {
  if (!text || typeof text !== "string") return "";

  // Preprocess brackets/parentheses to add missing backslashes for LaTeX
  text = preProcessMathDelimiters(text);

  // Protect LaTeX math blocks from being mangled by markdown parsing.
  // We replace them with placeholders, process markdown, then restore.
  const mathBlocks = [];
  let idx = 0;

  // Protect display math $$ ... $$
  text = text.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (match) => {
    const key = `MATHTOKENDSP${idx++}`;
    mathBlocks.push({ key, val: match });
    return key;
  });

  // Protect display math \[ ... \]
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (match) => {
    const key = `MATHTOKENDSP${idx++}`;
    mathBlocks.push({ key, val: match });
    return key;
  });

  // Protect inline math \( ... \)
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (match) => {
    const key = `MATHTOKENINL${idx++}`;
    mathBlocks.push({ key, val: match });
    return key;
  });

  // Protect inline math $ ... $
  text = text.replace(/\$([^\$\n]+)\$/g, (match) => {
    const key = `MATHTOKENINL${idx++}`;
    mathBlocks.push({ key, val: match });
    return key;
  });

  // Line-by-line parser for headers and nested lists
  const lines = text.split("\n");
  let listLevel = 0; // 0 = none, 1 = main, 2 = nested
  let outputLines = [];

  for (let line of lines) {
    // Check headers
    if (line.startsWith("## ")) {
      while (listLevel > 0) { outputLines.push("</ul>"); listLevel--; }
      outputLines.push(`<h2>${line.substring(3).trim()}</h2>`);
      continue;
    }
    if (line.startsWith("### ")) {
      while (listLevel > 0) { outputLines.push("</ul>"); listLevel--; }
      outputLines.push(`<h3>${line.substring(4).trim()}</h3>`);
      continue;
    }
    if (line.startsWith("#### ")) {
      while (listLevel > 0) { outputLines.push("</ul>"); listLevel--; }
      outputLines.push(`<h4>${line.substring(5).trim()}</h4>`);
      continue;
    }
    if (line.startsWith("##### ")) {
      while (listLevel > 0) { outputLines.push("</ul>"); listLevel--; }
      outputLines.push(`<h5>${line.substring(6).trim()}</h5>`);
      continue;
    }

    // Match list item with spaces before marker: e.g., "  - Option" or "* Option"
    const listMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (listMatch) {
      const spaces = listMatch[1].length;
      const content = listMatch[3].trim();
      const targetLevel = spaces >= 2 ? 2 : 1;

      if (listLevel === 0) {
        outputLines.push("<ul>");
        listLevel = 1;
      }

      if (targetLevel > listLevel) {
        outputLines.push("<ul>");
        listLevel = 2;
      } else if (targetLevel < listLevel) {
        outputLines.push("</ul>");
        listLevel = 1;
      }

      outputLines.push(`<li>${content}</li>`);
      continue;
    }

    // Blank line closes lists
    if (line.trim() === "") {
      while (listLevel > 0) { outputLines.push("</ul>"); listLevel--; }
      outputLines.push("");
      continue;
    }

    // Normal paragraph text
    if (listLevel > 0) {
      while (listLevel > 0) { outputLines.push("</ul>"); listLevel--; }
    }
    outputLines.push(`<p>${line.trim()}</p>`);
  }

  while (listLevel > 0) {
    outputLines.push("</ul>");
    listLevel--;
  }

  let html = outputLines.join("\n");

  // Inline formatting
  html = html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/<p><\/p>/g, "");

  // Restore math blocks safely using function replacement
  mathBlocks.forEach(({ key, val }) => {
    html = html.replace(key, () => val);
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

function togglePasswordVisibility(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const icon = btnEl.querySelector('i');
  if (input.type === 'password') {
    input.type = 'text';
    if (icon) {
      icon.classList.remove('fa-eye');
      icon.classList.add('fa-eye-slash');
    }
  } else {
    input.type = 'password';
    if (icon) {
      icon.classList.remove('fa-eye-slash');
      icon.classList.add('fa-eye');
    }
  }
}

// ── DYNAMIC GLOBAL INJECTION OF SUPPORT & FEEDBACK ──────────────
document.addEventListener("DOMContentLoaded", () => {
  const sidebar = document.querySelector(".sidebar");
  const mobileMenu = document.querySelector(".mobile-menu");

  if (!sidebar && !mobileMenu) return; // Only run on dashboard and other study pages

  // 1. Inject Sidebar navigation
  if (sidebar) {
    // Look for productivity or study tools section
    const sec = document.createElement("div");
    sec.className = "sidebar-section";
    sec.style.marginTop = "8px";
    sec.textContent = "Help & Support";
    sidebar.appendChild(sec);

    const btnSupport = document.createElement("button");
    btnSupport.className = "sidebar-link";
    btnSupport.style.cssText = "background:none;border:none;width:100%;text-align:left;cursor:pointer;";
    btnSupport.innerHTML = '<i class="fa-solid fa-circle-question"></i> Help Desk';
    btnSupport.onclick = openSupportModal;
    sidebar.appendChild(btnSupport);

    const btnFeedback = document.createElement("button");
    btnFeedback.className = "sidebar-link";
    btnFeedback.style.cssText = "background:none;border:none;width:100%;text-align:left;cursor:pointer;";
    btnFeedback.innerHTML = '<i class="fa-solid fa-star"></i> Give Feedback';
    btnFeedback.onclick = openFeedbackModal;
    sidebar.appendChild(btnFeedback);
  }

  // 2. Inject Mobile menu links
  if (mobileMenu) {
    const divider = document.createElement("div");
    divider.style.cssText = "height:1px;background:var(--sep);margin:8px 0;";
    mobileMenu.insertBefore(divider, mobileMenu.querySelector(".logout"));

    const itemSupport = document.createElement("button");
    itemSupport.className = "mobile-menu-item";
    itemSupport.innerHTML = '<i class="fa-solid fa-circle-question"></i> Help Desk';
    itemSupport.onclick = () => { closeMobileMenu(); openSupportModal(); };
    mobileMenu.insertBefore(itemSupport, mobileMenu.querySelector(".logout"));

    const itemFeedback = document.createElement("button");
    itemFeedback.className = "mobile-menu-item";
    itemFeedback.innerHTML = '<i class="fa-solid fa-star"></i> Give Feedback';
    itemFeedback.onclick = () => { closeMobileMenu(); openFeedbackModal(); };
    mobileMenu.insertBefore(itemFeedback, mobileMenu.querySelector(".logout"));
  }

  // 3. Inject Modals HTML
  const modalsWrap = document.createElement("div");
  modalsWrap.innerHTML = `
    <!-- FEEDBACK MODAL -->
    <div class="support-modal-overlay" id="feedbackOverlay">
      <div class="support-modal-card">
        <div class="support-modal-header">
          <h3>Give Feedback <i class="fa-solid fa-star" style="color:#f59e0b;"></i></h3>
          <button class="support-modal-close" onclick="closeSupportModal('feedbackOverlay')"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="support-modal-body">
          <p style="font-size:0.9rem;color:var(--label3);text-align:center;margin-bottom:12px;">How would you rate your experience with CampusTutor?</p>
          <div class="star-rating" id="feedbackStars">
            <i class="fa-solid fa-star" data-val="1"></i>
            <i class="fa-solid fa-star" data-val="2"></i>
            <i class="fa-solid fa-star" data-val="3"></i>
            <i class="fa-solid fa-star" data-val="4"></i>
            <i class="fa-solid fa-star" data-val="5"></i>
          </div>
          <form id="feedbackForm" onsubmit="submitUserFeedback(event)">
            <input type="hidden" id="feedbackRating" value="5"/>
            <div class="form-group">
              <label class="form-label">Review / Comments</label>
              <textarea id="feedbackComments" class="form-input" style="min-height:90px;resize:vertical;" placeholder="Tell us what you like or how we can improve..." required></textarea>
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;margin-top:12px;">Submit Feedback</button>
          </form>
        </div>
      </div>
    </div>

    <!-- HELP & SUPPORT MODAL -->
    <div class="support-modal-overlay" id="supportOverlay">
      <div class="support-modal-card" style="max-width:550px;">
        <div class="support-modal-header">
          <h3>Customer Help Desk <i class="fa-solid fa-circle-question" style="color:var(--blue);"></i></h3>
          <button class="support-modal-close" onclick="closeSupportModal('supportOverlay')"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="support-modal-body">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
            <h4 style="margin:0;font-size:1rem;">Your Tickets</h4>
            <button class="btn btn-sm btn-glass" onclick="toggleNewTicketForm(true)" id="btnNewTicket">Create Ticket +</button>
          </div>

          <!-- New Ticket Form -->
          <div id="newTicketBox" style="display:none;background:rgba(118,118,128,0.05);padding:16px;border-radius:12px;margin-bottom:18px;border:0.5px solid var(--sep);">
            <h5 style="margin:0 0 12px;font-size:0.9rem;">Submit Inquire / Issue</h5>
            <form id="supportTicketForm" onsubmit="submitSupportTicket(event)">
              <div class="form-group" style="margin-bottom:10px;">
                <label class="form-label" style="font-size:0.75rem;">Subject</label>
                <input type="text" id="ticketSubject" class="form-input" placeholder="e.g. Note Summarization issue" required/>
              </div>
              <div class="form-group" style="margin-bottom:10px;">
                <label class="form-label" style="font-size:0.75rem;">Message / Inquiry Details</label>
                <textarea id="ticketMessage" class="form-input" style="min-height:80px;resize:vertical;" placeholder="Describe your request in detail..." required></textarea>
              </div>
              <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" class="btn btn-sm btn-glass" onclick="toggleNewTicketForm(false)">Cancel</button>
                <button type="submit" class="btn btn-sm btn-primary">Submit Ticket</button>
              </div>
            </form>
          </div>

          <!-- Tickets Container -->
          <div id="ticketsContainer" style="max-height:350px;overflow-y:auto;">
            <div class="adm-loading"><div class="spinner"></div> Loading support history...</div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalsWrap);

  // Hook interactive stars rating clicks
  const stars = document.querySelectorAll("#feedbackStars i");
  stars.forEach(s => {
    s.addEventListener("click", (e) => {
      const val = parseInt(e.target.getAttribute("data-val"));
      document.getElementById("feedbackRating").value = val;
      updateStarsDisplay(val);
    });
  });

  function updateStarsDisplay(val) {
    stars.forEach(st => {
      const v = parseInt(st.getAttribute("data-val"));
      if (v <= val) {
        st.classList.add("active");
      } else {
        st.classList.remove("active");
      }
    });
  }

  // Initialize display
  updateStarsDisplay(5);
});

// Modal open/close functions
function openFeedbackModal() {
  document.getElementById("feedbackOverlay").style.display = "flex";
  document.getElementById("feedbackComments").value = "";
}

function openSupportModal() {
  document.getElementById("supportOverlay").style.display = "flex";
  toggleNewTicketForm(false);
  loadUserTickets();
}

function closeSupportModal(id) {
  document.getElementById(id).style.display = "none";
}

function toggleNewTicketForm(show) {
  const box = document.getElementById("newTicketBox");
  const btn = document.getElementById("btnNewTicket");
  if (show) {
    box.style.display = "block";
    btn.style.display = "none";
    document.getElementById("ticketSubject").value = "";
    document.getElementById("ticketMessage").value = "";
  } else {
    box.style.display = "none";
    btn.style.display = "block";
  }
}

// Submit Feedback to API
async function submitUserFeedback(event) {
  event.preventDefault();
  const rating = document.getElementById("feedbackRating").value;
  const comments = document.getElementById("feedbackComments").value.trim();

  const { error } = await apiRequest("/api/support/feedback", "POST", { rating, comments });
  if (error) {
    showToast(error, "error");
  } else {
    showToast("Feedback submitted! Thank you so much! <i class='fa-solid fa-circle-check'></i>", "success");
    closeSupportModal("feedbackOverlay");
  }
}

// Submit Support ticket to API
async function submitSupportTicket(event) {
  event.preventDefault();
  const subject = document.getElementById("ticketSubject").value.trim();
  const message = document.getElementById("ticketMessage").value.trim();

  const { error } = await apiRequest("/api/support/ticket", "POST", { subject, message });
  if (error) {
    showToast(error, "error");
  } else {
    showToast("Support request sent! We will reply shortly. <i class='fa-solid fa-circle-check'></i>", "success");
    toggleNewTicketForm(false);
    loadUserTickets();
  }
}

// Load tickets list
async function loadUserTickets() {
  const container = document.getElementById("ticketsContainer");
  container.innerHTML = '<div style="text-align:center;padding:20px;"><div class="spinner" style="margin:0 auto 10px;"></div>Loading ticket history...</div>';

  const { data, error } = await apiRequest("/api/support/tickets");
  if (error || !data) {
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--label3);">Failed to load tickets history.</div>';
    return;
  }

  if (data.warning) {
    container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--label3);"><i class="fa-solid fa-triangle-exclamation" style="font-size:1.8rem;color:#f59e0b;margin-bottom:8px;display:block;"></i> Support system is currently being set up. Please try again later.</div>';
    return;
  }

  const tickets = data.tickets || [];
  if (tickets.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--label3);"><i class="fa-solid fa-circle-info" style="font-size:1.5rem;margin-bottom:8px;display:block;"></i> No inquiries submitted yet. Need help? Create a ticket above.</div>';
    return;
  }

  container.innerHTML = tickets.map(t => `
    <div class="ticket-item">
      <div class="ticket-header">
        <span class="ticket-subject">${escapeHTML(t.subject)}</span>
        <span class="ticket-status ${t.status}">${t.status}</span>
      </div>
      <div class="ticket-msg">${escapeHTML(t.message)}</div>
      ${t.reply ? `
        <div class="ticket-reply">
          <strong>Response from Help Desk:</strong>
          <div>${escapeHTML(t.reply)}</div>
        </div>
      ` : ''}
      <div class="ticket-date">${formatDateTime(t.created_at)}</div>
    </div>
  `).join('');
}

// ── CAMPUS COINS & DAILY STREAK WALLET SYSTEM ─────────────────
let userCoinState = { coins: 0, canClaimDaily: false, streak: 0 };

async function refreshUserCoins() {
  if (!isLoggedIn()) return;
  const { data } = await apiGetCoinBalance();
  if (data) {
    userCoinState = data;
    updateCoinUIElements();
  }
}

function updateCoinUIElements() {
  const coinDisplay = document.getElementById("navCoinCount");
  if (coinDisplay) coinDisplay.textContent = userCoinState.coins;

  const modalBal = document.getElementById("modalCoinBalance");
  if (modalBal) modalBal.textContent = `${userCoinState.coins} Coins`;
  const statCoins = document.getElementById("statCoins");
  if (statCoins) statCoins.textContent = userCoinState.coins;
  const sideCoinCount = document.getElementById("sideCoinCount");
  if (sideCoinCount) sideCoinCount.textContent = userCoinState.coins;
  const statStreak = document.getElementById("statStreak");
  if (statStreak && userCoinState.streak !== undefined) statStreak.textContent = userCoinState.streak;
  const heroCoins = document.getElementById("heroCoinsDisplay");
  if (heroCoins) heroCoins.textContent = userCoinState.coins;
  const studyCoins = document.getElementById("studyCoinsCount");
  if (studyCoins) studyCoins.textContent = userCoinState.coins;
  const histCoins = document.getElementById("userCoinsBalance");
  if (histCoins) histCoins.textContent = userCoinState.coins;

  const dailyBtn = document.getElementById("navDailyGiftBtn");
  if (dailyBtn) {
    if (userCoinState.canClaimDaily) {
      dailyBtn.classList.add("has-bonus");
      dailyBtn.title = "Daily study reward ready to claim!";
    } else {
      dailyBtn.classList.remove("has-bonus");
      dailyBtn.title = `Streak active (Day ${userCoinState.streak || 0})`;
    }
  }

  const claimBoxBtn = document.getElementById("btnClaimChest");
  const quickPill = document.getElementById("quickClaimPill");
  const tabBadge = document.getElementById("tabDailyBonusBadge");
  const streakEl = document.getElementById("rewardStreakCount");
  const effectiveStreak = Number(userCoinState.streak || 0);
  if (streakEl) streakEl.textContent = effectiveStreak;

  const nextDay = userCoinState.canClaimDaily ? effectiveStreak + 1 : Math.max(1, effectiveStreak);
  const bonusEstimate = 3 + Math.min(Math.floor((nextDay - 1) / 2), 2);

  if (userCoinState.canClaimDaily) {
    if (tabBadge) {
      tabBadge.style.display = "inline-block";
      tabBadge.textContent = `+${bonusEstimate}`;
    }
    if (quickPill) {
      quickPill.style.display = "inline-flex";
      quickPill.disabled = false;
      quickPill.innerHTML = `<i class="fa-solid fa-gift anim-gift"></i> Claim +${bonusEstimate} Coins`;
    }
    if (claimBoxBtn) {
      claimBoxBtn.disabled = false;
      claimBoxBtn.style.background = "linear-gradient(135deg,#ffb020,#d97806)";
      claimBoxBtn.style.color = "#fff";
      claimBoxBtn.innerHTML = `<i class="fa-solid fa-gift anim-gift" style="margin-right:8px;"></i> Claim Day ${nextDay} Bonus (+${bonusEstimate} Coins)`;
    }
  } else {
    if (tabBadge) {
      tabBadge.style.display = "none";
    }
    if (quickPill) {
      quickPill.style.display = "none";
    }
    if (claimBoxBtn) {
      claimBoxBtn.disabled = true;
      claimBoxBtn.style.background = "rgba(142, 142, 147, 0.2)";
      claimBoxBtn.style.color = "var(--label3, #94a3b8)";
      claimBoxBtn.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:8px;"></i> Day ${userCoinState.streak} Claimed! Next Reward Tomorrow`;
    }
  }

  // Update visual streak roadmap track
  renderStreakRoadmapTrack();
}

function renderStreakRoadmapTrack() {
  const track = document.getElementById("modalStreakTrack");
  if (!track) return;
  const currentStreak = Number(userCoinState.streak || 0);
  const canClaim = Boolean(userCoinState.canClaimDaily);
  const targetDay = canClaim ? currentStreak + 1 : Math.max(1, currentStreak);
  
  // 7-day rolling cycle
  const currentCycleDay = ((targetDay - 1) % 7) + 1;

  let html = "";
  for (let d = 1; d <= 7; d++) {
    const isPast = d < currentCycleDay;
    const isCurrent = d === currentCycleDay;
    const isClaimedToday = isCurrent && !canClaim;
    const coinsReward = d <= 2 ? 3 : d <= 4 ? 4 : 5;

    let stateClass = "";
    let iconHtml = "";

    if (isPast || isClaimedToday) {
      stateClass = "claimed";
      iconHtml = '<i class="fa-solid fa-check" style="color:#22c55e;font-size:0.75rem;"></i>';
    } else if (isCurrent) {
      stateClass = "current";
      iconHtml = '<i class="fa-solid fa-gift anim-gift" style="color:#ffb020;font-size:0.75rem;"></i>';
    } else {
      iconHtml = '<i class="fa-solid fa-lock" style="color:var(--label3);font-size:0.7rem;"></i>';
    }

    html += `
      <div class="streak-day-item ${stateClass}">
        <div class="streak-day-num">D${d}</div>
        <div style="margin:2px 0;">${iconHtml}</div>
        <div class="streak-day-coins">+${coinsReward}</div>
      </div>
    `;
  }
  track.innerHTML = html;
}

function switchCoinsModalTab(targetTab) {
  const tabPackages = document.getElementById("coinsTabPackages");
  const tabReward = document.getElementById("coinsTabReward");
  const btnPackages = document.getElementById("tabBtnBuyCoins");
  const btnReward = document.getElementById("tabBtnDailyBonus");

  if (!tabPackages || !tabReward) return;

  if (targetTab === "reward" || targetTab === "streak") {
    tabPackages.style.display = "none";
    tabReward.style.display = "block";
    if (btnPackages) btnPackages.classList.remove("active");
    if (btnReward) btnReward.classList.add("active");
  } else {
    tabPackages.style.display = "block";
    tabReward.style.display = "none";
    if (btnPackages) btnPackages.classList.add("active");
    if (btnReward) btnReward.classList.remove("active");
  }
}

function openCoinsModal(defaultTab = "packages") {
  let modal = document.getElementById("coinsWalletModal");
  if (!modal) {
    injectCoinsModal();
    modal = document.getElementById("coinsWalletModal");
  }
  switchCoinsModalTab(defaultTab || "packages");
  modal.style.display = "flex";
  refreshUserCoins();
}

function closeCoinsModal() {
  const modal = document.getElementById("coinsWalletModal");
  if (modal) modal.style.display = "none";
}

async function claimDailyBonusAction() {
  const btn = document.getElementById("btnClaimChest");
  const quickPill = document.getElementById("quickClaimPill");
  if (btn) btn.disabled = true;
  if (quickPill) quickPill.disabled = true;

  showToast("Opening your daily study reward...", "info");

  const { data, error } = await apiClaimDailyBonus();
  if (error || !data || !data.success) {
    showToast(error || (data && data.message) || "Could not claim bonus right now.", "error");
    if (btn && userCoinState.canClaimDaily) btn.disabled = false;
    if (quickPill && userCoinState.canClaimDaily) quickPill.disabled = false;
    return;
  }

  showToast(data.message || "Daily reward claimed!", "success");
  await refreshUserCoins();
}

async function buyCoinPackAction(packageId) {
  const card = document.querySelector(`.coin-pack-card[data-package="${packageId}"]`);
  const buyBtn = card ? card.querySelector(".coin-pack-btn") : null;
  const originalBtnText = buyBtn ? buyBtn.innerHTML : "";

  if (buyBtn) {
    buyBtn.disabled = true;
    buyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...';
  }

  showToast("Connecting to Paystack checkout...", "info");
  const { data, error } = await apiBuyCoinPackage(packageId);

  if (error || !data || !data.checkoutUrl) {
    showToast(error || "Failed to initialize payment.", "error");
    if (buyBtn) {
      buyBtn.disabled = false;
      buyBtn.innerHTML = originalBtnText;
    }
    return;
  }

  window.location.href = data.checkoutUrl;
}

function injectCoinsModal() {
  if (document.getElementById("coinsWalletModal")) return;

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <!-- CAMPUS COINS WALLET MODAL -->
    <div class="support-modal-overlay" id="coinsWalletModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(10px);z-index:20000;align-items:center;justify-content:center;padding:16px;">
      <div class="coins-modal-dialog">
        <!-- Header -->
        <div class="support-modal-header" style="border-bottom:1px solid var(--sep);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:36px;height:36px;border-radius:10px;background:rgba(255,176,32,0.15);display:flex;align-items:center;justify-content:center;color:#d97806;font-size:1.1rem;">
              <i class="fa-solid fa-coins anim-coin"></i>
            </div>
            <div>
              <h3 style="font-size:1.15rem;font-weight:800;margin:0;line-height:1.2;color:var(--label);">CampusCoins Wallet</h3>
              <p style="font-size:0.78rem;color:var(--label3);margin:2px 0 0;">Top up coins or claim daily streak rewards</p>
            </div>
          </div>
          <button class="support-modal-close" onclick="closeCoinsModal()" style="border:none;background:rgba(142,142,147,0.12);width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--label2);">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="support-modal-body" style="padding:16px 18px;overflow-y:auto;flex:1;">
          <!-- Navigation Tabs -->
          <div class="coins-modal-nav-tabs">
            <button class="coins-tab-btn active" id="tabBtnBuyCoins" onclick="switchCoinsModalTab('packages')">
              <i class="fa-solid fa-bolt-lightning" style="color:#f59e0b;"></i> Top-Up Packages
            </button>
            <button class="coins-tab-btn" id="tabBtnDailyBonus" onclick="switchCoinsModalTab('reward')">
              <i class="fa-solid fa-gift" style="color:#af52de;"></i> Daily Reward
              <span class="coins-tab-badge" id="tabDailyBonusBadge" style="display:none;">+3</span>
            </button>
          </div>

          <!-- TAB 1: TOP-UP PACKAGES (ZERO SCROLL NEEDED) -->
          <div id="coinsTabPackages" style="display:block;">
            <!-- Balance & Quick Claim Bar -->
            <div class="coins-balance-bar">
              <div>
                <div class="coins-balance-label">Your Balance</div>
                <div id="modalCoinBalance" class="coins-balance-amount">-- Coins</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <button class="quick-claim-pill" id="quickClaimPill" onclick="claimDailyBonusAction()" style="display:none;">
                  <i class="fa-solid fa-gift anim-gift"></i> Claim +3 Coins
                </button>
                <a href="/pages/pricing.html" class="btn btn-sm btn-glass" style="font-size:0.75rem;padding:5px 10px;text-decoration:none;">Unlimited Plan →</a>
              </div>
            </div>

            <!-- Coin Packages Grid: 4 Packages All Visible Above The Fold -->
            <div class="coins-modal-grid">
              <!-- 100 Coins -->
              <div class="coin-pack-card" data-package="starter" onclick="buyCoinPackAction('starter')">
                <div>
                  <div style="display:flex;justify-content:center;margin-bottom:2px;">
                    <lord-icon src="https://cdn.lordicon.com/qhgmphtg.json" trigger="hover" colors="primary:#f59e0b,secondary:#d97706" style="width:38px;height:38px"></lord-icon>
                  </div>
                  <div class="coin-amount-title">100 Coins</div>
                  <div class="coin-pack-subtitle">Starter Stash</div>
                  <div class="coin-price-tag">₦1,500</div>
                </div>
                <button class="coin-pack-btn">Buy Pack</button>
              </div>

              <!-- 250 Coins (Popular) -->
              <div class="coin-pack-card featured" data-package="popular" onclick="buyCoinPackAction('popular')">
                <span class="coin-pack-badge">Popular</span>
                <div>
                  <div style="display:flex;justify-content:center;margin-bottom:2px;">
                    <lord-icon src="https://cdn.lordicon.com/webtefou.json" trigger="hover" colors="primary:#007AFF,secondary:#5ac8fa" style="width:38px;height:38px"></lord-icon>
                  </div>
                  <div class="coin-amount-title">250 Coins</div>
                  <div class="coin-pack-subtitle">Scholar Pack</div>
                  <div class="coin-price-tag">₦3,500</div>
                </div>
                <button class="coin-pack-btn">Buy Pack</button>
              </div>

              <!-- 600 Coins -->
              <div class="coin-pack-card" data-package="pro" onclick="buyCoinPackAction('pro')">
                <div>
                  <div style="display:flex;justify-content:center;margin-bottom:2px;">
                    <lord-icon src="https://cdn.lordicon.com/lbjtvqiv.json" trigger="hover" colors="primary:#34c759,secondary:#30b0c7" style="width:38px;height:38px"></lord-icon>
                  </div>
                  <div class="coin-amount-title">600 Coins</div>
                  <div class="coin-pack-subtitle" style="color:#10b981;font-weight:700;">+100 Bonus</div>
                  <div class="coin-price-tag">₦7,500</div>
                </div>
                <button class="coin-pack-btn">Buy Pack</button>
              </div>

              <!-- 1,600 Coins -->
              <div class="coin-pack-card" data-package="vip" onclick="buyCoinPackAction('vip')">
                <div>
                  <div style="display:flex;justify-content:center;margin-bottom:2px;">
                    <lord-icon src="https://cdn.lordicon.com/lupuorrc.json" trigger="hover" colors="primary:#af52de,secondary:#f59e0b" style="width:38px;height:38px"></lord-icon>
                  </div>
                  <div class="coin-amount-title">1,600 Coins</div>
                  <div class="coin-pack-subtitle" style="color:#a855f7;font-weight:700;">+350 Bonus</div>
                  <div class="coin-price-tag">₦18,000</div>
                </div>
                <button class="coin-pack-btn">Buy Pack</button>
              </div>
            </div>

            <p style="text-align:center;font-size:0.75rem;color:var(--label3);margin:10px 0 0;">
              <i class="fa-solid fa-shield-halved" style="color:#10b981;margin-right:4px;"></i> Coins never expire. Instant Paystack activation.
            </p>
          </div>

          <!-- TAB 2: DAILY STUDY REWARD & STREAK -->
          <div id="coinsTabReward" style="display:none;">
            <!-- Streak Roadmap -->
            <div class="streak-roadmap-card">
              <div class="streak-roadmap-header">
                <div>
                  <span style="font-size:0.95rem;font-weight:800;color:var(--label);display:flex;align-items:center;gap:6px;">
                    <i class="fa-solid fa-fire anim-fire" style="color:#f97316;"></i> <span id="rewardStreakCount">1</span> Day Study Streak
                  </span>
                </div>
                <span style="font-size:0.72rem;font-weight:700;color:#f59e0b;background:rgba(245,158,11,0.12);padding:3px 8px;border-radius:10px;">
                  Up to +5 Coins/day
                </span>
              </div>
              <p style="font-size:0.78rem;color:var(--label3);margin:0 0 8px;">Check in daily to build your streak and earn free CampusCoins!</p>
              
              <!-- 7-day track -->
              <div class="streak-days-track" id="modalStreakTrack">
                <!-- Injected dynamically -->
              </div>
            </div>

            <!-- Big Chest / Action Box -->
            <div class="coin-chest-box">
              <div style="display:flex;justify-content:center;margin-bottom:6px;">
                <lord-icon src="https://cdn.lordicon.com/lupuorrc.json" trigger="hover" colors="primary:#ffb020,secondary:#d97806" style="width:60px;height:60px"></lord-icon>
              </div>
              <h4 style="font-size:1.05rem;font-weight:800;margin-bottom:4px;color:var(--label);">Daily Study Bonus</h4>
              <p style="font-size:0.8rem;color:var(--label2);margin-bottom:14px;">Claim your daily check-in coins to fund problem solves & exams.</p>
              <button class="btn btn-warning" id="btnClaimChest" onclick="claimDailyBonusAction()" style="background:linear-gradient(135deg,#ffb020,#d97806);color:#fff;border:none;font-weight:800;padding:10px 24px;border-radius:24px;width:100%;font-size:0.88rem;cursor:pointer;box-shadow:0 4px 14px rgba(217,120,6,0.35);">
                <i class="fa-solid fa-gift anim-gift" style="margin-right:6px;"></i> Claim Today's Bonus
              </button>
            </div>

            <p style="text-align:center;font-size:0.78rem;color:var(--label3);margin:8px 0 0;">
              Need more coins immediately? <a href="javascript:void(0)" onclick="switchCoinsModalTab('packages')" style="color:var(--blue);font-weight:700;text-decoration:underline;">View Top-Up Packages →</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  // Overlay click to close
  const modalEl = document.getElementById("coinsWalletModal");
  if (modalEl) {
    modalEl.onclick = (e) => {
      if (e.target === modalEl) closeCoinsModal();
    };
  }

  // Escape key to close
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalEl && modalEl.style.display !== "none") {
      closeCoinsModal();
    }
  });
}

// Global initialization on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  injectCoinsModal();

  // If user is logged in, inject coin pill in navbar
  if (isLoggedIn()) {
    const navRight = document.querySelector(".navbar-right") || document.querySelector(".ct-nav-right-actions");
    if (navRight && !document.getElementById("navCoinPill")) {
      const coinBtn = document.createElement("button");
      coinBtn.id = "navCoinPill";
      coinBtn.className = "coin-nav-pill";
      coinBtn.innerHTML = `<i class="fa-solid fa-coins anim-coin"></i> <span id="navCoinCount">--</span> <span class="coin-plus">+</span>`;
      coinBtn.title = "CampusCoins Wallet — Click to top up or view balance";
      coinBtn.onclick = () => openCoinsModal('packages');
      navRight.insertBefore(coinBtn, navRight.firstChild);

      if (!document.getElementById("navDailyGiftBtn") && !document.querySelector(".ct-daily-gift-btn")) {
        const dailyBtn = document.createElement("button");
        dailyBtn.id = "navDailyGiftBtn";
        dailyBtn.className = "daily-gift-nav-btn";
        dailyBtn.innerHTML = `<i class="fa-solid fa-gift anim-gift"></i> <span>Daily Gift</span>`;
        dailyBtn.onclick = () => openCoinsModal('reward');
        navRight.insertBefore(dailyBtn, coinBtn.nextSibling);
      }
    }

    refreshUserCoins();
  }

  // Check URL parameters for coin payment return
  const urlParams = new URLSearchParams(window.location.search);
  const paymentType = urlParams.get("payment");
  const ref = urlParams.get("reference") || urlParams.get("trxref");
  if (paymentType === "coins_success" && ref) {
    showToast("Verifying your coin purchase with Paystack...", "info");
    apiRequest(`/api/paystack/verify/${encodeURIComponent(ref)}`).then(({ data, error }) => {
      if (data && data.success) {
        showToast(data.message || "CampusCoins credited to your wallet!", "success");
        window.history.replaceState({}, document.title, window.location.pathname);
        refreshUserCoins();
      } else {
        showToast(error || "Coin verification failed.", "error");
      }
    });
  }
});




// ── PWA SERVICE WORKER & APP INSTALL PROMPT ────────────────────
let deferredPWAInstallPrompt = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('[PWA] Service Worker registered:', reg.scope))
      .catch((err) => console.warn('PWA SW registration failed:', err));
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPWAInstallPrompt = e;
  showPWAInstallPromptUI();
});

window.addEventListener('appinstalled', () => {
  deferredPWAInstallPrompt = null;
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.remove();
  showToast('CampusTutor AI installed successfully on your device!', 'success');
});

function showPWAInstallPromptUI() {
  if (document.getElementById('pwaInstallBanner')) return;

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isStandalone) return;

  // Don't show the intrusive install banner on auth pages (login, signup, reset)
  const currentPath = window.location.pathname.toLowerCase();
  if (currentPath.includes('login') || currentPath.includes('signup') || currentPath.includes('reset')) {
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'pwaInstallBanner';
  banner.className = 'ct-pwa-install-banner';
  banner.innerHTML = `
    <div class="ct-pwa-banner-content">
      <div class="ct-pwa-icon-box">
        <i class="fa-solid fa-graduation-cap"></i>
      </div>
      <div class="ct-pwa-text">
        <div class="ct-pwa-title">Install CampusTutor App</div>
        <div class="ct-pwa-desc">Instant 1-tap mobile access to summaries, flashcards & solver!</div>
      </div>
      <div class="ct-pwa-actions">
        <button id="pwaInstallBtn" class="ct-pwa-install-btn"><i class="fa-solid fa-download"></i> Install App</button>
        <button id="pwaDismissBtn" class="ct-pwa-dismiss-btn" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);

  document.getElementById('pwaInstallBtn').addEventListener('click', async () => {
    if (deferredPWAInstallPrompt) {
      deferredPWAInstallPrompt.prompt();
      const choice = await deferredPWAInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        banner.remove();
      }
      deferredPWAInstallPrompt = null;
    } else {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      if (isIOS) {
        showToast('To install: Tap Share <i class="fa-solid fa-arrow-up-from-bracket"></i> and select "Add to Home Screen" <i class="fa-solid fa-square-plus"></i>', 'info');
      } else {
        showToast('Open browser menu (⋮) and tap "Install app" or "Add to Home screen"', 'info');
      }
    }
  });

  document.getElementById('pwaDismissBtn').addEventListener('click', () => {
    banner.remove();
  });
}

window.installCampusTutorPWA = function() {
  if (deferredPWAInstallPrompt) {
    deferredPWAInstallPrompt.prompt();
  } else {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      showToast('Install on iOS: Tap Share <i class="fa-solid fa-arrow-up-from-bracket"></i> and select "Add to Home Screen" <i class="fa-solid fa-square-plus"></i>', 'info');
    } else {
      showToast('Open browser menu (⋮) and tap "Install app" or "Add to Home screen"', 'info');
    }
  }
};

// ── STANDARDIZED 5-ITEM BOTTOM NAVIGATION BAR ─────────────────
// Renders the master navigation across all authenticated pages:
// 1. Home (/pages/dashboard.html)
// 2. Tools (/pages/tools.html)
// 3. Progress (/pages/progress.html)
// 4. Earn (/pages/referral.html)
// 5. Settings (/pages/settings.html)
window.renderStandardBottomNav = function(activePage = 'home') {
  let nav = document.getElementById('mobileBottomNav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'mobileBottomNav';
    nav.className = 'ct-exact-dock';
    document.body.appendChild(nav);
  }

  const items = [
    { key: 'home', label: 'Home', icon: 'fa-solid fa-house', href: '/pages/dashboard.html' },
    { key: 'tools', label: 'Tools', icon: 'fa-solid fa-book-open anim-book', href: '/pages/tools.html' },
    { key: 'progress', label: 'Progress', icon: 'fa-solid fa-chart-line anim-pulse', href: '/pages/progress.html' },
    { key: 'earn', label: 'Earn', icon: 'fa-solid fa-users anim-sparkle', href: '/pages/referral.html' },
    { key: 'settings', label: 'Settings', icon: 'fa-solid fa-gear', href: '/pages/settings.html' }
  ];

  nav.innerHTML = items.map(item => {
    const isActive = item.key === activePage;
    return `
      <a href="${item.href}" class="ct-exact-dock-item ${isActive ? 'active' : ''}" title="${item.label}">
        <i class="${item.icon}"></i>
        <span>${item.label}</span>
        ${isActive ? '<div class="ct-exact-dock-indicator"></div>' : ''}
      </a>
    `;
  }).join('');
};

// Auto-initialize bottom nav immediately if empty or missing Earn item
(function autoInitBottomNav() {
  function initNav() {
    const nav = document.getElementById('mobileBottomNav');
    if (!nav) return;
    const path = (window.location.pathname || '').toLowerCase();
    let current = '';
    if (path.includes('dashboard')) current = 'home';
    else if (path.includes('tools')) current = 'tools';
    else if (path.includes('progress')) current = 'progress';
    else if (path.includes('referral')) current = 'earn';
    else if (path.includes('settings')) current = 'settings';

    const hasEarn = nav.querySelector('a[href*="referral"]');
    const childCount = nav.querySelectorAll('.ct-exact-dock-item').length;
    if (childCount < 5 || !hasEarn) {
      window.renderStandardBottomNav(current);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();

