// ============================================================
// utils/download.js — Generate downloadable files
//
// This module handles creating downloadable versions of
// AI-generated content in PDF and TXT formats.
// ============================================================

// ── GENERATE TXT FILE ──────────────────────────────────────────
// Simple text file generation
function generateTXT(content, title = "Document") {
  // Replace LaTeX delimiters with readable text for TXT format
  let txtContent = content
    .replace(/\\\(/g, "[MATH: ") // inline math start
    .replace(/\\\)/g, "]") // inline math end
    .replace(/\\\[/g, "\n[EQUATION]\n") // display math start
    .replace(/\\\]/g, "\n[/EQUATION]\n") // display math end
    .replace(/\\\//g, ""); // clean up any escaped slashes

  // Convert HTML entities to plain text
  txtContent = txtContent
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Clean up multiple newlines
  txtContent = txtContent.replace(/\n\n\n+/g, "\n\n");

  return txtContent;
}

// ── GENERATE FLASHCARD CSV ─────────────────────────────────────
// CSV format: front,back,category
function generateFlashcardCSV(flashcards, title = "Flashcards") {
  if (!Array.isArray(flashcards)) return "";

  // CSV header
  let csv = "Question,Answer,Category\n";

  // Add each flashcard
  flashcards.forEach((card) => {
    const front = (card.front || "").replace(/"/g, '""'); // Escape quotes
    const back = (card.back || "").replace(/"/g, '""');
    const category = (card.category || "General").replace(/"/g, '""');

    csv += `"${front}","${back}","${category}"\n`;
  });

  return csv;
}

// ── GENERATE PDF (SIMPLE TEXT VERSION) ──────────────────────────
// Note: For proper PDF with formatting, you'd need a library like:
// - pdfkit (Node.js)
// - puppeteer (headless browser)
// - jspdf (browser-side)
//
// For now, return empty — we'll implement via frontend or external service

function generatePDF(content, title = "Document") {
  // This is a placeholder
  // In production, use a library like:
  // const PDFDocument = require('pdfkit');
  // or call an external PDF generation service
  console.warn("PDF generation not yet fully implemented. Use TXT or CSV format.");
  return null;
}

module.exports = {
  generateTXT,
  generateFlashcardCSV,
  generatePDF,
};
