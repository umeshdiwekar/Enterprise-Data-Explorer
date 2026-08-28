const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const missing = [
      !SUPABASE_URL && "SUPABASE_URL",
      !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
    ].filter(Boolean);
    throw new Error(`Missing environment variable(s): ${missing.join(", ")}`);
  }
}

async function supabaseFetch(path, options = {}) {
  assertConfig();
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && body.message
        ? body.message
        : text || `Supabase request failed with status ${response.status}`;
    throw new Error(message);
  }
  return { response, body };
}

function sendJson(res, status, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(payload);
}

function getString(value) {
  return Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim();
}

function requirePost(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return false;
  }
  return true;
}

module.exports = {
  getString,
  requirePost,
  sendJson,
  supabaseFetch,
};
