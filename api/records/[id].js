const { sendJson, supabaseFetch } = require("../_supabase");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id < 1) {
    sendJson(res, 400, { error: "Invalid record id" });
    return;
  }

  try {
    const params = new URLSearchParams({
      select: "*",
      id: `eq.${id}`,
      limit: "1",
    });
    const { body } = await supabaseFetch(`/rest/v1/enterprises?${params}`);
    if (!body || !body.length) {
      sendJson(res, 404, { error: "Record not found" });
      return;
    }
    sendJson(res, 200, { record: body[0] });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
};
