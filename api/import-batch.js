const { requirePost, sendJson, supabaseFetch } = require("./_supabase");

const MAX_ROWS_PER_BATCH = 1000;
const TEST_ROW_LIMIT = 1000;

async function handler(req, res) {
  if (!requirePost(req, res)) return;

  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) {
    sendJson(res, 400, { error: "No rows supplied" });
    return;
  }
  if (rows.length > MAX_ROWS_PER_BATCH) {
    sendJson(res, 413, { error: `Batch is too large. Maximum is ${MAX_ROWS_PER_BATCH} rows.` });
    return;
  }
  if (rows.length >= TEST_ROW_LIMIT && rows[rows.length - 1].source_row > TEST_ROW_LIMIT) {
    sendJson(res, 400, { error: `Test mode enabled: only ${TEST_ROW_LIMIT} rows are allowed per import.` });
    return;
  }

  try {
    await supabaseFetch("/rest/v1/enterprise_import_rows", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
    });
    sendJson(res, 200, { ok: true, inserted: rows.length });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: "4mb",
    },
  },
};
