// ============================================================
// middleware/authMiddleware.js — Protect private routes
//
// Verifies JWT token from Authorization header against Supabase
// Auth. Includes in-memory caching (60s TTL) and exponential
// backoff retries on transient network/DNS hiccups for rock-solid
// reliability under high concurrency and unstable connections.
// ============================================================

const supabase = require("../utils/supabase");

// In-memory cache: token -> { user, expiresAt }
const tokenCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

// Periodic cleanup of stale cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of tokenCache.entries()) {
    if (val.expiresAt <= now) tokenCache.delete(key);
  }
}, 120 * 1000).unref();

/**
 * Verify a Supabase JWT with caching and transient error retry
 */
async function verifyTokenWithRetry(token) {
  if (!token) return { user: null, error: new Error("No token provided") };

  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return { user: cached.user, error: null };
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error) {
        const msg = String(error.message || "").toLowerCase();
        // Retry only on network / DNS / server-side gateway hiccups
        const isTransient =
          msg.includes("fetch failed") ||
          msg.includes("enotfound") ||
          msg.includes("etimedout") ||
          msg.includes("econnreset") ||
          error.status === 502 ||
          error.status === 503 ||
          error.status === 504;

        if (isTransient) {
          lastErr = error;
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        return { user: null, error };
      }

      if (data?.user) {
        tokenCache.set(token, { user: data.user, expiresAt: Date.now() + CACHE_TTL_MS });
        return { user: data.user, error: null };
      }
    } catch (netErr) {
      lastErr = netErr;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }

  return { user: null, error: lastErr || new Error("Failed to verify token after retries") };
}

function invalidateTokenCache(token) {
  if (token) tokenCache.delete(token);
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "No token provided. Please log in first.",
      });
    }

    const token = authHeader.split(" ")[1];
    const { user, error } = await verifyTokenWithRetry(token);

    if (error || !user) {
      return res.status(401).json({
        error: "Invalid or expired token. Please log in again.",
      });
    }

    req.user = user;

    // Check if user is banned
    const userStatus = user.app_metadata?.status;
    if (userStatus === "banned") {
      return res.status(403).json({
        error: "Your account has been banned. You cannot perform this action.",
        banned: true,
      });
    }

    next();
  } catch (err) {
    console.error("Auth middleware error:", err.message);
    res.status(500).json({ error: "Authentication failed." });
  }
}

module.exports = authMiddleware;
module.exports.verifyTokenWithRetry = verifyTokenWithRetry;
module.exports.invalidateTokenCache = invalidateTokenCache;
