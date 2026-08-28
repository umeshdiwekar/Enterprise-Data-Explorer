const { requirePost, sendJson, supabaseFetch } = require("./_supabase");

module.exports = async function handler(req, res) {
  if (!requirePost(req, res)) return;

  try {
    const { body } = await supabaseFetch("/rest/v1/rpc/complete_enterprise_import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    sendJson(res, 200, { ok: true, rowsInDatabase: Number(body || 0) });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
};
