// ============================================================
// js/api.js — CampusTutor AI Frontend API Helper
// ============================================================

const API_BASE = "";

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

    const response = await fetch(`${API_BASE}${endpoint}`, options);
    const data = await response.json();

    if (!response.ok) {
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
        error: data.error || "Something went wrong.",
        status: response.status
      };
    }
    return { data, error: null, status: response.status };
  } catch (err) {
    console.error("API request failed:", err);
    return { data: null, error: "Network error. Is the server running?", status: 0 };
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

// ── MARKDOWN → HTML ───────────────────────────────────────────
// Converts markdown to HTML. Math delimiters \( \) and \[ \] are
// preserved as-is — renderMath() will process them separately.
function markdownToHTML(text) {
  if (!text) return "";

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
