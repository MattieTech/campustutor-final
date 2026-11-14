// ============================================================
// utils/paymentLedger.js — Idempotent Payment Ledger & Revenue
// ============================================================

const supabase = require("./supabase");

const STORAGE_BUCKET = "documents";
const STORAGE_PAYMENTS_PREFIX = "__system__/payments";

let _hasPaymentsTable = null;
const _refLocks = new Map();

async function withReferenceLock(reference, fn) {
  const key = String(reference || "unknown");
  const prev = _refLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  _refLocks.set(key, prev.then(() => next));

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (_refLocks.get(key) === next) {
      _refLocks.delete(key);
    }
  }
}

async function checkPaymentsTable() {
  if (_hasPaymentsTable !== null) return _hasPaymentsTable;
  try {
    const { error } = await supabase.from("payments").select("id").limit(1);
    _hasPaymentsTable = !(
      error &&
      (error.code === "PGRST205" || (error.message || "").includes("does not exist") || (error.message || "").includes("schema cache"))
    );
  } catch (_) {
    _hasPaymentsTable = false;
  }
  return _hasPaymentsTable;
}

function safeRefFilename(reference) {
  return String(reference || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function getPaymentByReference(reference) {
  if (!reference) return null;
  const hasTable = await checkPaymentsTable();
  if (hasTable) {
    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("reference", reference)
      .maybeSingle();
    if (!error && data) return data;
  }

  try {
    const path = `${STORAGE_PAYMENTS_PREFIX}/${safeRefFilename(reference)}.json`;
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(path);
    if (!error && data) {
      return JSON.parse(await data.text());
    }
  } catch (_) {}

  try {
    const { data: acts } = await supabase
      .from("user_activity")
      .select("details")
      .eq("action", "paystack_payment")
      .ilike("details", `%${reference}%`)
      .order("created_at", { ascending: false })
      .limit(5);
    for (const row of acts || []) {
      try {
        const parsed = JSON.parse(row.details);
        if (parsed && parsed.reference === reference) return parsed;
      } catch (_) {}
    }
  } catch (_) {}

  return null;
}

async function recordPayment(entry) {
  const now = new Date().toISOString();
  const record = {
    reference: entry.reference,
    user_id: entry.userId,
    payment_type: entry.paymentType, // 'subscription' | 'coins'
    plan_name: entry.planName || null,
    duration_months: entry.durationMonths || null,
    package_id: entry.packageId || null,
    coins_awarded: Number(entry.coinsAwarded || 0),
    amount_kobo: Number(entry.amountKobo || 0),
    currency: entry.currency || "NGN",
    status: entry.status || "success",
    gateway_response: entry.gatewayResponse || null,
    metadata: entry.metadata || {},
    created_at: entry.createdAt || now,
    verified_at: entry.verifiedAt || now,
  };

  const hasTable = await checkPaymentsTable();
  if (hasTable) {
    const { error } = await supabase
      .from("payments")
      .upsert(record, { onConflict: "reference" });
    if (error) {
      console.error("Failed to persist payment in payments table:", error.message);
    }
  } else {
    const path = `${STORAGE_PAYMENTS_PREFIX}/${safeRefFilename(record.reference)}.json`;
    try {
      await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, Buffer.from(JSON.stringify(record), "utf-8"), {
          contentType: "application/json",
          upsert: true,
        });
    } catch (_) {}

    // Also mirror into user_activity for quick queryable history
    try {
      await supabase
        .from("user_activity")
        .insert({
          user_id: record.user_id,
          action: "paystack_payment",
          details: JSON.stringify(record),
          created_at: now,
        });
    } catch (_) {}
  }

  return record;
}

async function getAllVerifiedPayments(limit = 200) {
  const hasTable = await checkPaymentsTable();
  if (hasTable) {
    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("status", "success")
      .order("verified_at", { ascending: false })
      .limit(limit);
    if (!error && Array.isArray(data)) return data;
  }

  // Fallback: read from user_activity
  const { data: acts } = await supabase
    .from("user_activity")
    .select("user_id, details, created_at")
    .eq("action", "paystack_payment")
    .order("created_at", { ascending: false })
    .limit(limit);

  const seenRefs = new Set();
  const list = [];
  (acts || []).forEach((a) => {
    try {
      const parsed = JSON.parse(a.details || "{}");
      if (parsed.status === "success" && parsed.reference && !seenRefs.has(parsed.reference)) {
        seenRefs.add(parsed.reference);
        list.push(parsed);
      }
    } catch (_) {}
  });
  return list;
}

module.exports = {
  withReferenceLock,
  getPaymentByReference,
  recordPayment,
  getAllVerifiedPayments,
};
