const { requirePost, sendJson, supabaseFetch } = require("./_supabase");

module.exports = async function handler(req, res) {
  if (!requirePost(req, res)) return;

  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const requestedBatchSize = Number(payload.batch_size || 1000);
    const batchSize = Math.min(Math.max(Number.isFinite(requestedBatchSize) ? requestedBatchSize : 1000, 1), 1000);
    const { body } = await supabaseFetch("/rest/v1/rpc/complete_enterprise_import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch_size: batchSize }),
    });

    const rowsImported = Number(body || 0);
    sendJson(res, 200, {
      ok: true,
      rowsImported,
      rowsInDatabase: rowsImported,
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
};
