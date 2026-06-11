// ============================================================
// server.js — CampusTutor AI Express Server
//
// Entry point. Mounts all route groups and serves the frontend.
// ============================================================

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { initializeDatabase } = require("./utils/initDatabase");

const authRoutes    = require("./routes/auth");
const uploadRoutes  = require("./routes/upload");
const aiRoutes      = require("./routes/ai");
const adminRoutes   = require("./routes/admin");   // ← admin panel API
const contactRoutes = require("./routes/contact");

const app = express();

// ── INITIALIZE DATABASE ───────────────────────────────────────
// Check and create required tables at startup
initializeDatabase().catch(err => {
  console.error("❌ Database initialization warning:", err.message);
  console.warn("⚠️  Some features may not work properly. Check database schema.");
});

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

// Serve all static frontend files (HTML, CSS, JS, images)
app.use(express.static(path.join(__dirname, "../frontend")));

// ── API ROUTES ────────────────────────────────────────────────
app.use("/api/auth",   authRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/ai",     aiRoutes);
app.use("/api/admin",  adminRoutes);   // protected by isAdmin() inside admin.js
app.use("/api/contact", contactRoutes);   // contact form submission handler

// ── FRONTEND CATCH-ALL ────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
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
