const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const nodemailer = require("nodemailer");

console.log("GMAIL_USER:", process.env.GMAIL_USER);
console.log("GMAIL_PASSWORD:", process.env.GMAIL_PASSWORD ? "SET" : "NOT SET");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || process.env.EMAIL_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || "587"),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER,
    pass: process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.GMAIL_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false
  }
});

const mailOptions = {
  from: process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER || "no-reply@campustutor.com",
  to: "mattietechdev@gmail.com",
  subject: "SMTP Test",
  text: "This is a test email.",
};

transporter.sendMail(mailOptions, (error, info) => {
  if (error) {
    console.error("❌ Send failed:", error);
  } else {
    console.log("✅ Send success:", info.response);
  }
  process.exit(0);
});
