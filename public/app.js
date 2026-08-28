const state = {
  page: 1,
  perPage: 50,
  sort: "enterprise_name",
  direction: "asc",
  total: 0,
  pages: 1,
  abort: null,
};

const fields = [
  "q",
  "state",
  "district",
  "pincode",
  "date_from",
  "date_to",
  "lg_st_code",
  "lg_dt_code",
];

const $ = (id) => document.getElementById(id);
const rowsEl = $("rows");
const statusEl = $("status");
const emptyEl = $("empty");
const importResultEl = $("importResult");

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function paramsForRecords() {
  const params = new URLSearchParams({
    page: state.page,
    per_page: state.perPage,
    sort: state.sort,
    direction: state.direction,
  });
  for (const field of fields) {
    const value = $(field).value.trim();
    if (value) params.set(field, value);
  }
  return params;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function showImportResult(message, isError = false) {
  importResultEl.hidden = false;
  importResultEl.classList.toggle("error", isError);
  importResultEl.textContent = message;
}

async function readJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  throw new Error(text.trim() || `Request failed with status ${response.status}`);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-IN").format(value || 0);
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cell(value, className = "") {
  const text = escapeHtml(value || "");
  return `<td title="${text}"><div class="${className}">${text}</div></td>`;
}

function renderSkeleton() {
  rowsEl.innerHTML = Array.from({ length: 12 }, () => {
    const cells = Array.from({ length: 9 }, () => "<td><span></span></td>").join("");
    return `<tr class="skeleton">${cells}</tr>`;
  }).join("");
}

function renderRows(rows) {
  rowsEl.innerHTML = rows.map((row) => `
    <tr data-id="${row.id}">
      ${cell(row.lg_st_code)}
      ${cell(row.state)}
      ${cell(row.lg_dt_code)}
      ${cell(row.district)}
      ${cell(row.pincode)}
      ${cell(formatDate(row.registration_date))}
      ${cell(row.enterprise_name, "truncate")}
      ${cell(row.communication_address, "truncate")}
      ${cell(row.activities, "truncate")}
    </tr>
  `).join("");
  emptyEl.hidden = rows.length !== 0;
}

function updateSortHeaders() {
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === state.sort;
    th.classList.toggle("sorted", active);
    th.dataset.arrow = active && state.direction === "asc" ? "^" : "v";
  });
}

async function loadRecords() {
  if (state.abort) state.abort.abort();
  state.abort = new AbortController();
  setStatus("Loading");
  renderSkeleton();

  try {
    const response = await fetch(`/api/records?${paramsForRecords()}`, {
      signal: state.abort.signal,
    });
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error || "Unable to load records");
    state.total = data.total;
    state.pages = data.pages;
    state.page = data.page;
    renderRows(data.rows);
    $("resultSummary").textContent = `${formatNumber(data.total)} matching records`;
    $("pageInfo").textContent = `Page ${formatNumber(data.page)} of ${formatNumber(data.pages)}`;
    $("prev").disabled = data.page <= 1;
    $("next").disabled = data.page >= data.pages;
    updateSortHeaders();
    setStatus("Ready");
  } catch (error) {
    if (error.name === "AbortError") return;
    rowsEl.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = "Could not load records. Check that the server is running.";
    setStatus("Error");
  }
}

async function loadMeta() {
  const params = new URLSearchParams();
  if ($("state").value) params.set("state", $("state").value);
  const response = await fetch(`/api/meta?${params}`);
  if (!response.ok) return;
  const data = await readJson(response);
  $("recordCount").textContent = formatNumber(data.total);
  populateSelect($("state"), data.states, "All states", $("state").value);
  populateSelect($("district"), data.districts, "All districts", $("district").value);
}

function populateSelect(select, values, label, current) {
  select.innerHTML = `<option value="">${label}</option>` + values
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("");
  select.value = current;
}

async function openDetail(id) {
  const response = await fetch(`/api/records/${id}`);
  if (!response.ok) return;
  const { record } = await readJson(response);
  $("detail").innerHTML = `
    <h2>${escapeHtml(record.enterprise_name || "Enterprise detail")}</h2>
    <div class="detail-grid">
      <div class="detail-item"><b>State</b>${escapeHtml(record.state || "")}</div>
      <div class="detail-item"><b>District</b>${escapeHtml(record.district || "")}</div>
      <div class="detail-item"><b>LG ST Code</b>${escapeHtml(record.lg_st_code || "")}</div>
      <div class="detail-item"><b>LG DT Code</b>${escapeHtml(record.lg_dt_code || "")}</div>
      <div class="detail-item"><b>Pincode</b>${escapeHtml(record.pincode || "")}</div>
      <div class="detail-item"><b>Registration Date</b>${escapeHtml(formatDate(record.registration_date))}</div>
      <div class="detail-item full"><b>Communication Address</b>${escapeHtml(record.communication_address || "")}</div>
      <div class="detail-item full"><b>Activities</b>${escapeHtml(record.activities || "")}</div>
    </div>
  `;
  $("detailDialog").showModal();
}

const debouncedSearch = debounce(() => {
  state.page = 1;
  loadRecords();
}, 350);

for (const field of fields) {
  $(field).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      state.page = 1;
      loadRecords();
    }
  });
}

$("q").addEventListener("input", debouncedSearch);
$("apply").addEventListener("click", () => {
  state.page = 1;
  loadRecords();
});
$("reset").addEventListener("click", () => {
  for (const field of fields) $(field).value = "";
  state.page = 1;
  loadMeta();
  loadRecords();
});
$("uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("csvFile").files[0];
  if (!file) {
    showImportResult("Choose a CSV file first.", true);
    return;
  }

  const body = new FormData();
  body.append("csv", file);
  $("uploadButton").disabled = true;
  setStatus("Importing");
  showImportResult(`Importing ${file.name}. Large files can take a moment.`);

  try {
    const response = await fetch("/api/import", {
      method: "POST",
      body,
    });
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error || "Import failed");

    for (const field of fields) $(field).value = "";
    state.page = 1;
    await loadMeta();
    await loadRecords();
    showImportResult(
      `Imported ${formatNumber(data.stats.rowsInDatabase)} rows from ${formatNumber(data.stats.csvRowsRead)} CSV rows.`
    );
  } catch (error) {
    setStatus("Error");
    showImportResult(error.message, true);
  } finally {
    $("uploadButton").disabled = false;
    $("csvFile").value = "";
  }
});
$("state").addEventListener("change", async () => {
  $("district").value = "";
  await loadMeta();
});
$("perPage").addEventListener("change", () => {
  state.perPage = Number($("perPage").value);
  state.page = 1;
  loadRecords();
});
$("prev").addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    loadRecords();
  }
});
$("next").addEventListener("click", () => {
  if (state.page < state.pages) {
    state.page += 1;
    loadRecords();
  }
});
rowsEl.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-id]");
  if (row) openDetail(row.dataset.id);
});
document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    if (state.sort === th.dataset.sort) {
      state.direction = state.direction === "asc" ? "desc" : "asc";
    } else {
      state.sort = th.dataset.sort;
      state.direction = "asc";
    }
    state.page = 1;
    loadRecords();
  });
});

loadMeta();
loadRecords();
