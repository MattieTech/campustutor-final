// ============================================================
// routes/auth.js — Signup & Login routes
// ============================================================

const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabase");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

// ── NODEMAILER TRANSPORTER ────────────────────────────────────
const smtpPort = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || "465");
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || process.env.EMAIL_HOST || "smtp.gmail.com",
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER,
    pass: process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.GMAIL_PASSWORD,
  },
  connectionTimeout: 10000, // 10 seconds timeout
  greetingTimeout: 10000,
  socketTimeout: 15000,
  dnsTimeout: 5000,
  // Force IPv4 address family to avoid unreachable IPv6 addresses on Render
  family: 4 
});

async function sendVerificationEmail(email, otp) {
  const mailOptions = {
    from: process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER || "no-reply@campustutor.com",
    to: email,
    subject: "Verify Your CampusTutor Account",
    text: `Your verification code is: ${otp}\n\nThis code will expire in 10 minutes.`,
    html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code will expire in 10 minutes.</p>`,
  };
  // Propagate errors to the caller so they are explicitly handled in endpoints
  await transporter.sendMail(mailOptions);
  console.log(`✅ Verification email sent to ${email}`);
}

// Helper to generate referral code
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ── SIGNUP ────────────────────────────────────────────────────
router.post("/signup", async (req, res) => {
  try {
    const { email, password, fullName, referredBy } = req.body;

    if (!email || !password || !fullName) {
      return res
        .status(400)
        .json({ error: "Email, password, and full name are required." });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });
    }

    const cleanEmail = email.trim().toLowerCase();

    // 1. Create the user in Supabase Auth
    const { data, error } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      password,
      email_confirm: true, // Bypass Supabase default flow so we handle via nodemailer OTP
      user_metadata: { full_name: fullName },
    });

    if (error) {
      console.error("❌ Supabase auth creation error:", error.message);
      return res.status(400).json({ error: error.message });
    }

    // 2. Generate referral and verification info
    const userReferralCode = generateReferralCode();
    let referredById = null;
    if (referredBy) {
      const { data: referrerProfile } = await supabase
        .from("profiles")
        .select("id")
        .eq("referral_code", referredBy.trim().toUpperCase())
        .single();
      if (referrerProfile) {
        referredById = referrerProfile.id;
      }
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // 3. Save additional profile info
    const { error: profileError } = await supabase.from("profiles").insert({
      id: data.user.id,
      full_name: fullName,
      email: cleanEmail,
      plan: "free",
      is_verified: false,
      verification_otp: otp,
      verification_otp_expires: otpExpires,
      referral_code: userReferralCode,
      referred_by: referredById,
      created_at: new Date().toISOString(),
    });

    if (profileError) {
      console.error("❌ Profile table insertion failed:", profileError);
      // Clean up the auth user to prevent dangling auth user
      try {
        await supabase.auth.admin.deleteUser(data.user.id);
      } catch (delErr) {
        console.error("⚠️ Failed to clean up auth user after profile failure:", delErr.message);
      }
      return res.status(400).json({ error: `Failed to create user profile in database: ${profileError.message}` });
    }

    // 4. Send verification email
    try {
      await sendVerificationEmail(cleanEmail, otp);
    } catch (mailErr) {
      console.warn("⚠️ Verification email send failed during signup:", mailErr.message || mailErr);
    }

    // 5. Log the signup activity
    const { error: actErr } = await supabase.from("user_activity").insert({
      user_id: data.user.id,
      action: "user_signup",
      details: `New user registered: ${fullName}`,
      created_at: new Date().toISOString(),
    });
    if (actErr) {
      console.warn("⚠️ Could not log signup activity:", actErr.message);
    }

    res.status(201).json({
      message: "Account created successfully! Please check your email for the verification code.",
      userId: data.user.id,
    });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ error: `Signup failed: ${err.message}` });
  }
});

// ── VERIFY OTP ────────────────────────────────────────────────
router.post("/verify", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP code are required." });
    }

    const cleanEmail = email.trim().toLowerCase();

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .ilike("email", cleanEmail)
      .maybeSingle();

    if (error) {
      console.error("❌ Verify OTP profile query database error:", error);
      return res.status(500).json({ error: `Database error: ${error.message || error}` });
    }

    if (!profile) {
      return res.status(404).json({ error: `Account profile not found for ${cleanEmail}. Please ensure your email is correct or sign up again.` });
    }

    if (profile.is_verified) {
      return res.json({ message: "This email address is already verified." });
    }

    if (profile.verification_otp !== otp) {
      return res.status(400).json({ error: "Invalid verification code." });
    }

    if (new Date(profile.verification_otp_expires) < new Date()) {
      return res.status(400).json({ error: "Verification code has expired. Please sign up again." });
    }

    // Set verified
    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        is_verified: true,
        verification_otp: null,
        verification_otp_expires: null
      })
      .eq("id", profile.id);

    if (updateError) {
      console.error("❌ Verify OTP update database error:", updateError);
      return res.status(500).json({ error: `Failed to update profile verification status: ${updateError.message}` });
    }

    // Create referrals table entry if referred_by is set
    if (profile.referred_by) {
      await supabase.from("referrals").insert({
        referrer_id: profile.referred_by,
        referee_id: profile.id,
        reward_amount: 0,
        status: "pending",
        created_at: new Date().toISOString()
      }).catch((e) => console.error("Error creating referral record:", e.message));
    }

    res.json({ message: "Email verified successfully! You can now log in." });
  } catch (err) {
    console.error("Verification error:", err);
    res.status(500).json({ error: "Verification failed." });
  }
});

// ── GET AUTH CONFIG ───────────────────────────────────────────
router.get("/config", (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || "1028751505342-placeholder.apps.googleusercontent.com"
  });
});

// ── GOOGLE LOGIN ──────────────────────────────────────────────
router.post("/google-login", async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: "Google OAuth credential token is required." });
    }

    // 1. Decode Google credential JWT to get email & name
    let email, fullName;
    try {
      const payloadBase64 = credential.split(".")[1];
      const payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));
      email = payload.email;
      fullName = payload.name || payload.given_name;
    } catch (e) {
      console.error("Failed to parse Google credential:", e);
      return res.status(400).json({ error: "Invalid Google credential token." });
    }

    if (!email) {
      return res.status(400).json({ error: "Email is required for Google login." });
    }
    if (!fullName) {
      fullName = email.split("@")[0];
    }

    const cleanEmail = email.trim().toLowerCase();

    // 2. Generate magic link to verify if user exists in Supabase Auth
    let linkRes = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: cleanEmail
    });

    if (linkRes.error) {
      console.log(`User not found in Supabase Auth for email: ${cleanEmail}. Creating new user...`);
      // Create new user in Supabase Auth
      const tempPassword = crypto.randomBytes(16).toString("hex");
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: cleanEmail,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName }
      });

      if (authError) {
        console.error("Google auth user creation error:", authError.message);
        return res.status(400).json({ error: authError.message });
      }

      // Retry generating magic link
      linkRes = await supabase.auth.admin.generateLink({
        type: "magiclink",
        email: cleanEmail
      });

      if (linkRes.error) {
        console.error("Retry generateLink error:", linkRes.error.message);
        return res.status(500).json({ error: "Failed to generate session link." });
      }
    }

    const linkData = linkRes.data;

    // 3. Verify OTP code to log user in
    const { data: sessionData, error: sessionError } = await supabase.auth.verifyOtp({
      email: cleanEmail,
      token: linkData.properties.email_otp,
      type: "magiclink"
    });

    if (sessionError || !sessionData || !sessionData.session) {
      console.error("Failed to verify Google login session:", sessionError?.message);
      return res.status(401).json({ error: "Failed to authenticate Google session." });
    }

    const user = sessionData.user;
    const userId = user.id;

    // 4. Fetch or create profile
    let { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (!profile) {
      // Create new profile
      const refCode = generateReferralCode();
      const { data: newProfile, error: profileError } = await supabase
        .from("profiles")
        .insert({
          id: userId,
          full_name: fullName,
          email: cleanEmail,
          is_verified: true,
          plan: "free",
          referral_code: refCode,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (profileError) {
        console.error("Failed to create profile for Google user:", profileError.message);
      }
      profile = newProfile;
    } else {
      // If profile exists, ensure ID matches and verify
      const updates = { is_verified: true };
      if (profile.id !== userId) {
        updates.id = userId;
      }
      await supabase
        .from("profiles")
        .update(updates)
        .eq("email", cleanEmail);
    }

    const userRole = profile?.role || "user";
    const userStatus = profile?.status || "active";

    if (userStatus === "banned") {
      return res.status(403).json({ error: "Your account has been suspended. Please contact support." });
    }

    // Update last login
    await supabase
      .from("profiles")
      .update({ last_login: new Date().toISOString() })
      .eq("id", userId);

    res.json({
      message: "Login successful!",
      token: sessionData.session.access_token,
      user: {
        id: userId,
        email: cleanEmail,
        fullName: profile?.full_name || fullName,
        role: userRole,
        status: userStatus,
        plan: profile?.plan || 'free',
        isVerified: true
      }
    });
  } catch (err) {
    console.error("Google login error:", err);
    res.status(500).json({ error: "Google login failed." });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) { 
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }

    // Ask Supabase to verify credentials
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return res
        .status(401)
        .json({ error: "Invalid email or password." });
    }

    // Try to get user profile
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("full_name, role, status, is_verified, plan")
      .eq("id", data.user.id)
      .maybeSingle();

    if (profileError) {
      console.error("❌ Login profiles query failed:", profileError);
    }

    // Check if user is banned
    const status = profile?.status || data.user.app_metadata?.status;
    if (status === "banned") {
      return res
        .status(403)
        .json({ error: "Your account has been suspended. Please contact support." });
    }

    // Update last login
    if (profile) {
      const { error: loginUpdateErr } = await supabase
        .from("profiles")
        .update({ last_login: new Date().toISOString() })
        .eq("id", data.user.id);
      if (loginUpdateErr) {
        console.error("❌ Could not update last_login:", loginUpdateErr);
      }
    }

    const userRole = data.user.app_metadata?.role || profile?.role || "user";
    const userStatus = data.user.app_metadata?.status || profile?.status || "active";

    console.log("🔐 Login for:", email);

    res.json({
      message: "Login successful!",
      token: data.session.access_token,
      user: {
        id: data.user.id,
        email: data.user.email,
        fullName: profile?.full_name || data.user.user_metadata?.full_name || "Student",
        role: userRole,
        status: userStatus,
        plan: profile?.plan || "free",
        isVerified: profile ? profile.is_verified : false,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ── RESEND VERIFICATION OTP ──────────────────────────────────
router.post("/resend-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const cleanEmail = email.trim().toLowerCase();

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .ilike("email", cleanEmail)
      .maybeSingle();

    if (error) {
      console.error("❌ Resend OTP database error:", error);
      return res.status(500).json({ error: `Database error: ${error.message || error}` });
    }

    if (!profile) {
      return res.status(404).json({ error: `Account profile not found for ${cleanEmail}. Please ensure your email is correct or sign up again.` });
    }

    if (profile.is_verified) {
      return res.json({ message: "This email address is already verified." });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        verification_otp: otp,
        verification_otp_expires: otpExpires
      })
      .eq("id", profile.id);

    if (updateError) {
      console.error("❌ Resend OTP update database error:", updateError);
      return res.status(500).json({ error: `Failed to update verification code: ${updateError.message}` });
    }

    await sendVerificationEmail(cleanEmail, otp);

    res.json({ message: "A new verification code has been sent to your email." });
  } catch (err) {
    console.error("Resend OTP error:", err);
    res.status(500).json({ error: `Verification code send failed: ${err.message || err}` });
  }
});

// ── PASSWORD RESET REQUEST ────────────────────────────────────
router.post("/reset-request", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if profile exists case-insensitively
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .ilike("email", cleanEmail)
      .maybeSingle();

    if (error) {
      console.error("❌ Reset request database error:", error);
      return res.status(500).json({ error: `Database error: ${error.message || error}` });
    }

    if (!profile) {
      return res.status(404).json({ error: "No account found with this email address." });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins validity

    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        verification_otp: otp, // Reuse verification_otp
        verification_otp_expires: otpExpires
      })
      .eq("id", profile.id);

    if (updateError) {
      console.error("❌ Reset request update database error:", updateError);
      return res.status(500).json({ error: `Failed to update reset code: ${updateError.message}` });
    }

    const mailOptions = {
      from: process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER || "no-reply@campustutor.com",
      to: cleanEmail,
      subject: "Reset Your CampusTutor Password",
      text: `Your password reset code is: ${otp}\n\nThis code will expire in 15 minutes.`,
      html: `<p>Your password reset code is: <strong>${otp}</strong></p><p>This code will expire in 15 minutes.</p>`,
    };
    await transporter.sendMail(mailOptions);

    res.json({ message: "Reset code has been sent to your email." });
  } catch (err) {
    console.error("Reset request error:", err);
    res.status(500).json({ error: `Password reset send failed: ${err.message || err}` });
  }
});

// ── PASSWORD RESET CONFIRM ────────────────────────────────────
router.post("/reset-confirm", async (req, res) => {
  try {
    const { email, otp, password } = req.body;
    if (!email || !otp || !password) {
      return res.status(400).json({ error: "Email, OTP, and password are required." });
    }

    const cleanEmail = email.trim().toLowerCase();

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .ilike("email", cleanEmail)
      .maybeSingle();

    if (error) {
      console.error("❌ Reset confirm database error:", error);
      return res.status(500).json({ error: `Database error: ${error.message || error}` });
    }

    if (!profile) {
      return res.status(404).json({ error: "No account found with this email address." });
    }

    if (profile.verification_otp !== otp) {
      return res.status(400).json({ error: "Invalid reset code." });
    }

    if (new Date(profile.verification_otp_expires) < new Date()) {
      return res.status(400).json({ error: "Reset code has expired. Please request a new code." });
    }

    // Update password in Supabase Auth
    const { error: authError } = await supabase.auth.admin.updateUserById(profile.id, {
      password: password
    });

    if (authError) {
      console.error("Auth password reset error:", authError.message);
      return res.status(400).json({ error: authError.message });
    }

    // Clear OTP details and auto-verify account since they successfully used their verified email
    await supabase
      .from("profiles")
      .update({
        is_verified: true,
        verification_otp: null,
        verification_otp_expires: null
      })
      .eq("id", profile.id);

    res.json({ message: "Password has been reset successfully! You can now log in." });
  } catch (err) {
    console.error("Reset confirm error:", err);
    res.status(500).json({ error: "Failed to reset password." });
  }
});

// ── LOGOUT ────────────────────────────────────────────────────
router.post("/logout", async (req, res) => {
  try {
    await supabase.auth.signOut();
    res.json({ message: "Logged out successfully." });
  } catch (err) {
    res.json({ message: "Logged out." });
  }
});

// ── DIAGNOSTIC ROUTE ──────────────────────────────────────────
router.get("/diagnostic", async (req, res) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || "NOT SET";
    const serviceKey = process.env.SUPABASE_SERVICE_KEY ? `${process.env.SUPABASE_SERVICE_KEY.substring(0, 10)}...` : "NOT SET";
    
    // Count profiles
    const { count, error: countErr } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true });
      
    // Fetch user profile specifically
    const email = req.query.email || "comfortolateru234@gmail.com";
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("*")
      .ilike("email", email.trim().toLowerCase())
      .maybeSingle();

    res.json({
      supabaseUrl,
      supabaseServiceKeySnippet: serviceKey,
      profilesCount: countErr ? `Error: ${countErr.message}` : count,
      searchedEmail: email,
      profileFound: !!profile,
      profileData: profile || null,
      profileError: profileErr ? profileErr.message : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
