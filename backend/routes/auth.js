// ============================================================
// routes/auth.js — Signup & Login routes
//
// This file handles user authentication using Supabase Auth.
// Supabase handles ALL the hard stuff (password hashing,
// JWT tokens, sessions) — we just call their API.
//
// Routes defined here:
//   POST /api/auth/signup  → Create a new account
//   POST /api/auth/login   → Log in to existing account
//   POST /api/auth/logout  → Log out (invalidate token)
// ============================================================

const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabase");

// ── SIGNUP ────────────────────────────────────────────────────
// Frontend sends: { email, password, fullName }
// We create the account in Supabase, then save extra profile data
router.post("/signup", async (req, res) => {
  try {
    // 1. Destructure the data sent from the frontend
    const { email, password, fullName } = req.body;

    // 2. Basic validation
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

    // 3. Create the user in Supabase Auth
    //    Supabase automatically hashes the password and sends a
    //    verification email if you have it enabled in the dashboard
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Skip email verification for MVP
      user_metadata: { full_name: fullName },
    });

    if (error) {
      // Supabase returns friendly error messages
      console.error("❌ Supabase auth creation error:", error.message);
      return res.status(400).json({ error: error.message });
    }

    // 4. Save additional profile info to our custom "profiles" table
    // This is wrapped in try-catch because the table may not exist initially
    try {
      const { error: profileError } = await supabase.from("profiles").insert({
        id: data.user.id, // Same ID as Supabase Auth user
        full_name: fullName,
        email: email,
        created_at: new Date().toISOString(),
      });

      if (profileError) {
        console.warn("⚠️  Could not save profile to profiles table:", profileError.message);
        console.warn("   The profiles table may not exist. Please run migration.sql in Supabase.");
        // Don't fail the signup — the auth user was created successfully
        // The profile is just extra metadata
      }
    } catch (profileErr) {
      console.warn("⚠️  Profile table operation failed:", profileErr.message);
      // Continue anyway — the user was created in auth
    }

    // 5. Log the signup activity
    try {
      await supabase.from("user_activity").insert({
        user_id: data.user.id,
        action: "user_signup",
        details: `New user registered: ${fullName}`,
        created_at: new Date().toISOString(),
      });
      console.log("✅ Activity logged: user_signup for", data.user.id);
    } catch (actErr) {
      console.log("⚠️  Could not log signup activity:", actErr.message);
    }

    // 5. Send success response
    res.status(201).json({
      message: "Account created successfully! You can now log in.",
      userId: data.user.id,
    });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ error: "Signup failed. Please try again." });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────
// Frontend sends: { email, password }
// We verify credentials and return a JWT token
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }

    // Ask Supabase to verify the email+password and issue a token
    // "signInWithPassword" checks the hashed password for us
    const { data, error } =
      await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return res
        .status(401)
        .json({ error: "Invalid email or password." });
    }

    // Try to get the user's profile from our custom table (if it exists)
    let profile = null;
    try {
      const { data: profileData } = await supabase
        .from("profiles")
        .select("full_name, role, status")
        .eq("id", data.user.id)
        .single();
      profile = profileData;
    } catch (err) {
      // profiles table may not exist, that's okay
      console.log("Note: profiles table query failed, using auth metadata instead");
    }

    // Check if user is banned (from profile or app_metadata)
    const status = profile?.status || data.user.app_metadata?.status;
    if (status === "banned") {
      return res
        .status(403)
        .json({ error: "Your account has been suspended. Please contact support." });
    }

    // Update last login time if profiles table exists
    try {
      await supabase
        .from("profiles")
        .update({ last_login: new Date().toISOString() })
        .eq("id", data.user.id);
    } catch (err) {
      // profiles table may not exist, skip update
      console.log("Note: Could not update last_login in profiles table");
    }

    // Log the login activity
    try {
      await supabase.from("user_activity").insert({
        user_id: data.user.id,
        action: "user_login",
        details: `User logged in from ${req.headers['user-agent'] || 'unknown'}`,
        created_at: new Date().toISOString(),
      });
      console.log("✅ Activity logged: user_login for", data.user.id);
    } catch (actErr) {
      console.log("⚠️  Could not log login activity:", actErr.message);
    }

    // Extract admin role from app_metadata (where Supabase stores it)
    const userRole = data.user.app_metadata?.role || profile?.role || "user";
    
    // Check if user is banned
    const userStatus = data.user.app_metadata?.status || profile?.status || "active";
    if (userStatus === "banned") {
      console.log("🚫 Login attempt by banned user:", email);
      return res
        .status(403)
        .json({ error: "Your account has been banned and cannot log in. Please contact support." });
    }

    console.log("🔐 Login for:", email);
    console.log("📦 app_metadata:", data.user.app_metadata);
    console.log("👤 userRole extracted:", userRole);

    // Return the JWT token and user info to the frontend
    // The frontend will store this token in localStorage
    const response = {
      message: "Login successful!",
      token: data.session.access_token, // JWT token — frontend stores this
      user: {
        id: data.user.id,
        email: data.user.email,
        fullName: profile?.full_name || data.user.user_metadata?.full_name || "Student",
        role: userRole,
        status: userStatus,
        app_metadata: data.user.app_metadata, // Include full app_metadata for frontend
      },
    };
    
    console.log("📤 Sending to frontend:", JSON.stringify(response.user, null, 2));
    res.json(response);
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ── LOGOUT ────────────────────────────────────────────────────
// The frontend mainly handles logout by deleting the token from localStorage.
// But we also tell Supabase to invalidate the server-side session.
router.post("/logout", async (req, res) => {
  try {
    await supabase.auth.signOut();
    res.json({ message: "Logged out successfully." });
  } catch (err) {
    // Even if this fails, the frontend can still clear localStorage
    res.json({ message: "Logged out." });
  }
});

module.exports = router;
