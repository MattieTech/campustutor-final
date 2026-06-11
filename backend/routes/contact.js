// ============================================================
// routes/contact.js — Contact Form Email Handler
//
// This route handles the contact form submission from the
// homepage and sends an email to the admin's Gmail address.
//
// Routes:
//   POST /api/contact — Send a contact form message
// ============================================================

const express = require("express");
const router = express.Router();
const nodemailer = require("nodemailer");

// Configure the email transporter
// This uses Gmail's SMTP server
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER, // Your Gmail address
    pass: process.env.GMAIL_PASSWORD, // Your Gmail app password (NOT your actual password!)
  },
});

// Test the connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Gmail connection failed:", error.message);
  } else {
    console.log("✅ Gmail connection successful - ready to send emails");
  }
});

// ── SEND CONTACT MESSAGE ──────────────────────────────────────
// POST /api/contact
// Body: { name, email, message }
// No authentication required — this is a public endpoint
router.post("/", async (req, res) => {
  try {
    console.log("📬 Contact form submission received:", req.body);
    
    const { name, email, message } = req.body;

    // Validate input
    if (!name || !email || !message) {
      console.log("❌ Missing fields:", { name: !!name, email: !!email, message: !!message });
      return res
        .status(400)
        .json({ error: "Name, email, and message are required." });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.log("❌ Invalid email format:", email);
      return res.status(400).json({ error: "Invalid email address." });
    }

    // Create the email HTML template
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #007AFF;">New Message from CampusTutor AI Contact Form</h2>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        
        <p><strong>From:</strong> ${name}</p>
        <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        
        <h3 style="color: #333;">Message:</h3>
        <p style="white-space: pre-wrap; color: #555;">${message}</p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        
        <p style="font-size: 0.9rem; color: #999;">
          This email was sent from your CampusTutor AI contact form.
        </p>
      </div>
    `;

    // Send the email to the admin
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: process.env.CONTACT_EMAIL || process.env.GMAIL_USER, // Send to the specified email (default to Gmail user)
      subject: `New Contact Form Message from ${name}`,
      html: htmlContent,
      replyTo: email, // Allow admin to reply directly to the sender
    };

    // Send the email
    console.log("📧 Sending email to:", mailOptions.to);
    await transporter.sendMail(mailOptions);
    console.log("✅ Email sent successfully!");

    // Also send a confirmation email to the user
    const confirmationHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #007AFF;">✅ Message Received</h2>
        <p>Hi ${name},</p>
        <p>Thank you for reaching out to CampusTutor AI! We've received your message and will get back to you within 24 hours.</p>
        
        <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Your message:</strong></p>
          <p style="margin: 10px 0; white-space: pre-wrap; color: #555;">${message}</p>
        </div>
        
        <p>Best regards,<br><strong>CampusTutor AI Team</strong></p>
      </div>
    `;

    const confirmationOptions = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: "We received your message - CampusTutor AI",
      html: confirmationHtml,
    };

    console.log("📧 Sending confirmation email to:", email);
    await transporter.sendMail(confirmationOptions);
    console.log("✅ Confirmation email sent!");

    console.log(`📧 Contact form email sent from ${email}`);
    res.json({
      success: true,
      message: "Your message has been sent! We'll reply within 24 hours.",
    });
  } catch (err) {
    console.error("Contact form error:", {
      message: err.message,
      stack: err.stack,
      details: err
    });
    res.status(500).json({
      error: "Failed to send message. Please try again later.",
    });
  }
});

module.exports = router;
