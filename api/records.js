const { getString, sendJson, supabaseFetch } = require("./_supabase");

const SORT_COLUMNS = new Set([
  "lg_st_code",
  "state",
  "lg_dt_code",
  "district",
  "pincode",
  "registration_date",
  "enterprise_name",
  "activities",
]);

function addEq(params, query, key, column = key) {
  const value = getString(query[key]);
  if (value) params.set(column, `eq.${value}`);
}

function addLikeFilter(params, query, key, column = key) {
  const value = getString(query[key]);
  if (!value) return;
  const escaped = value.replace(/[\\*()%_]/g, " ").trim();
  if (!escaped) return;
  params.set(column, `ilike.*${escaped}*`);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const page = Math.max(1, Number(getString(req.query.page) || 1));
    const perPage = Math.min(100, Math.max(10, Number(getString(req.query.per_page) || 50)));
    const offset = (page - 1) * perPage;
    const sortInput = getString(req.query.sort) || "enterprise_name";
    const sort = SORT_COLUMNS.has(sortInput) ? sortInput : "enterprise_name";
    const direction = getString(req.query.direction).toLowerCase() === "desc" ? "desc" : "asc";

    const params = new URLSearchParams();
    params.set(
      "select",
      "id,lg_st_code,state,lg_dt_code,district,pincode,registration_date,enterprise_name,communication_address,activities"
    );
    params.set("order", `${sort}.${direction}.nullslast,id.asc`);
    params.set("limit", String(perPage));
    params.set("offset", String(offset));

    addEq(params, req.query, "state");
    addEq(params, req.query, "district");
    addEq(params, req.query, "pincode");
    addEq(params, req.query, "lg_st_code");
    addEq(params, req.query, "lg_dt_code");

    addLikeFilter(params, req.query, "enterprise_name");
    addLikeFilter(params, req.query, "activities");

    const dateFrom = getString(req.query.date_from);
    const dateTo = getString(req.query.date_to);
    if (dateFrom) params.set("registration_date", `gte.${dateFrom}`);
    if (dateTo) params.append("registration_date", `lte.${dateTo}`);

    const search = getString(req.query.q);
    if (search) {
      const escaped = search.replace(/[*,()]/g, " ");
      params.set(
        "or",
        `(enterprise_name.ilike.*${escaped}*,communication_address.ilike.*${escaped}*,activities.ilike.*${escaped}*)`
      );
    }

    const { response, body } = await supabaseFetch(`/rest/v1/enterprises?${params}`, {
      headers: {
        Prefer: "count=exact",
      },
    });
    const range = response.headers.get("content-range") || "0-0/0";
    const total = Number(range.split("/")[1] || 0);

    sendJson(res, 200, {
      rows: body || [],
      page,
      perPage,
      total,
      pages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
};
