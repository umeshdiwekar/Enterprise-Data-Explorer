const { getString, sendJson, supabaseFetch } = require("./_supabase");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const selectedState = getString(req.query.state);
    const { body } = await supabaseFetch("/rest/v1/rpc/enterprise_meta", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ selected_state: selectedState || null }),
    });
    sendJson(res, 200, body);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
};
