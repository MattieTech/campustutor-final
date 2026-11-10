// ============================================================
// server.js — CampusTutor AI Express Server
// ============================================================

const path    = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors    = require("cors");
const { initializeDatabase } = require("./utils/initDatabase");

const authRoutes     = require("./routes/auth");
const uploadRoutes   = require("./routes/upload");
const aiRoutes       = require("./routes/ai");
const adminRoutes    = require("./routes/admin");
const contactRoutes  = require("./routes/contact");
const paystackRoutes = require("./routes/paystack");
const supportRoutes  = require("./routes/support");
const coinsRoutes    = require("./routes/coins");

const app = express();

// ── INITIALIZE DATABASE ───────────────────────────────────────
initializeDatabase().catch(err => {
  console.error("❌ Database initialization warning:", err.message);
  console.warn("⚠️ Some features may not work properly. Check database schema.");
});

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

app.use(express.static(path.join(__dirname, "../frontend")));

// ── API ROUTES ────────────────────────────────────────────────
app.use("/api/auth",     authRoutes);
app.use("/api/upload",   uploadRoutes);
app.use("/api/ai",       aiRoutes);
app.use("/api/admin",    adminRoutes);
app.use("/api/contact",  contactRoutes);
app.use("/api/paystack", paystackRoutes);
app.use("/api/support",  supportRoutes);
app.use("/api/coins",    coinsRoutes);

// ── FRONTEND ROUTES ───────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.get(["/signup", "/register"], (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/signup.html"));
});

app.get(["/login", "/signin"], (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/login.html"));
});

app.get(["/reset", "/forgot-password"], (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/reset.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/dashboard.html"));
});

app.get("/pricing", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/pricing.html"));
});

app.get("/study", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/study.html"));
});

app.get("/upload", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/upload.html"));
});

app.get("/tools", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/tools.html"));
});

app.get("/history", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/history.html"));
});

app.get("/referral", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/referral.html"));
});

app.get("/settings", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/settings.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/pages/admin.html"));
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("💥 Server error:", err.message);
  res.status(500).json({ error: "Something went wrong on the server." });
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ CampusTutor AI server running on http://localhost:${PORT}`);
});
