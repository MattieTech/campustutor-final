// ============================================================
// middleware/authMiddleware.js — Protect private routes
//
// "Middleware" is code that runs BETWEEN the request arriving
// and your route handler running. Think of it as a bouncer
// at a club — it checks if you have a valid ticket (JWT token)
// before letting you in.
//
// HOW JWT AUTHENTICATION WORKS:
// 1. User logs in → Supabase returns a JWT token (a long string)
// 2. Frontend stores the token in localStorage
// 3. Frontend sends the token in every request header:
//    Authorization: Bearer eyJhbGci...
// 4. This middleware checks the token before the route runs
// 5. If valid → user info is attached to req.user → route runs
// 6. If invalid → 401 Unauthorized error is returned
// ============================================================

const supabase = require("../utils/supabase");

async function authMiddleware(req, res, next) {
  try {
    // 1. Get the token from the Authorization header
    //    Header looks like: "Bearer eyJhbGciOiJIUzI1NiIs..."
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "No token provided. Please log in first.",
      });
    }

    // 2. Extract just the token part (remove "Bearer ")
    const token = authHeader.split(" ")[1];

    // 3. Ask Supabase to verify the token and get the user
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        error: "Invalid or expired token. Please log in again.",
      });
    }

    // 4. Attach user info to the request object
    //    Now any route after this middleware can access req.user
    req.user = user;

    // 5. Check if user is banned
    const userStatus = user.app_metadata?.status;
    if (userStatus === "banned") {
      return res.status(403).json({
        error: "Your account has been banned. You cannot perform this action.",
        banned: true,
      });
    }

    // 6. Call next() to pass control to the actual route handler
    next();
  } catch (err) {
    console.error("Auth middleware error:", err.message);
    res.status(500).json({ error: "Authentication failed." });
  }
}

module.exports = authMiddleware;
