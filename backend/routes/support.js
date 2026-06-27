// ============================================================
// routes/support.js — Feedback and Support Tickets Handler
// ============================================================

const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabase");
const authMiddleware = require("../middleware/authMiddleware");

// ── SUBMIT FEEDBACK ──────────────────────────────────────────
// POST /api/support/feedback
router.post("/feedback", authMiddleware, async (req, res) => {
  try {
    const { rating, comments, category = "general" } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating between 1 and 5 is required." });
    }

    const { data, error } = await supabase
      .from("feedback")
      .insert({
        user_id: req.user.id,
        rating: Number(rating),
        comments: comments ? comments.trim() : null,
        category: category,
      })
      .select()
      .single();

    if (error) {
      console.error("❌ Feedback submission error:", error.message);
      return res.status(500).json({ error: "Failed to submit feedback." });
    }

    res.json({ message: "Thank you for your feedback!", data });
  } catch (err) {
    console.error("Feedback error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// ── CREATE SUPPORT TICKET ─────────────────────────────────────
// POST /api/support/ticket
router.post("/ticket", authMiddleware, async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ error: "Subject and message are required." });
    }

    const { data, error } = await supabase
      .from("support_tickets")
      .insert({
        user_id: req.user.id,
        subject: subject.trim(),
        message: message.trim(),
        status: "open",
      })
      .select()
      .single();

    if (error) {
      console.error("❌ Support ticket error:", error.message);
      if (error.code === "PGRST205" || error.message.includes("find the table")) {
        return res.status(400).json({ 
          error: "Support tickets table not set up in Supabase yet. Please run migration SQL." 
        });
      }
      return res.status(500).json({ error: "Failed to submit support request." });
    }

    res.json({ message: "Support ticket created successfully!", ticket: data });
  } catch (err) {
    console.error("Support ticket error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// ── LIST USER'S TICKET HISTORY ────────────────────────────────
// GET /api/support/tickets
router.get("/tickets", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("support_tickets")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("❌ Fetch tickets error:", error.message);
      if (error.code === "PGRST205" || error.message.includes("find the table")) {
        return res.json({ 
          tickets: [], 
          warning: "support_tickets table is missing. Run migration SQL." 
        });
      }
      return res.status(500).json({ error: "Failed to fetch support tickets." });
    }

    res.json({ tickets: data || [] });
  } catch (err) {
    console.error("Fetch tickets error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
