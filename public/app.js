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

const csvColumns = [
  "LG_ST_Code",
  "State",
  "LG_DT_Code",
  "District",
  "Pincode",
  "RegistrationDate",
  "EnterpriseName",
  "CommunicationAddress",
  "Activities",
];

const importBatchSize = 250;

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

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanCode(value) {
  const text = cleanText(value);
  if (!text) return null;
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

function cleanPincode(value) {
  const text = cleanCode(value);
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  return digits || text;
}

function parseRegistrationDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, day, month, year] = slash;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const dash = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dash) {
    const [, year, month, day] = dash;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return null;
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

function normalizeCsvRow(row, sourceRow) {
  return {
    source_row: sourceRow,
    lg_st_code: cleanCode(row[0]),
    state: cleanText(row[1]),
    lg_dt_code: cleanCode(row[2]),
    district: cleanText(row[3]),
    pincode: cleanPincode(row[4]),
    registration_date: parseRegistrationDate(row[5]),
    enterprise_name: cleanText(row[6]),
    communication_address: cleanText(row[7]),
    activities: cleanText(row[8]),
  };
}

function validateCsvHeader(row) {
  const found = row.map((value) => String(value || "").trim());
  const matches =
    found.length === csvColumns.length &&
    csvColumns.every((column, index) => found[index] === column);
  if (!matches) {
    throw new Error(`CSV header mismatch. Expected: ${csvColumns.join(", ")}`);
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function importCsvFile(file) {
  await postJson("/api/import", {});

  const decoder = new TextDecoder();
  const reader = file.stream().getReader();
  let field = "";
  let row = [];
  let inQuotes = false;
  let pendingQuote = false;
  let headerRead = false;
  let sourceRow = 0;
  let uploadedRows = 0;
  let unparsedDates = 0;
  let batch = [];

  async function flushBatch() {
    if (!batch.length) return;
    const data = await postJson("/api/import-batch", { rows: batch });
    uploadedRows += data.inserted || batch.length;
    showImportResult(`Imported ${formatNumber(uploadedRows)} rows from ${file.name}.`);
    batch = [];
  }

  async function acceptRow(rawRow) {
    if (rawRow.length === 1 && rawRow[0] === "") return;
    if (!headerRead) {
      validateCsvHeader(rawRow);
      headerRead = true;
      return;
    }
    sourceRow += 1;
    const normalized = normalizeCsvRow(rawRow, sourceRow);
    if (rawRow[5] && !normalized.registration_date) unparsedDates += 1;
    batch.push(normalized);
    if (batch.length >= importBatchSize) await flushBatch();
  }

  async function pushFieldAndRow() {
    row.push(field);
    field = "";
    const completeRow = row;
    row = [];
    await acceptRow(completeRow);
  }

  while (true) {
    const { done, value } = await reader.read();
    const chunk = decoder.decode(value || new Uint8Array(), { stream: !done });
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index];
      const next = chunk[index + 1];
      if (pendingQuote) {
        pendingQuote = false;
        if (char === '"') {
          field += '"';
          continue;
        }
        inQuotes = false;
      }
      if (char === '"') {
        if (inQuotes && next === '"') {
          field += '"';
          index += 1;
        } else if (inQuotes && index === chunk.length - 1 && !done) {
          pendingQuote = true;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") index += 1;
        await pushFieldAndRow();
      } else {
        field += char;
      }
    }
    if (done) break;
  }

  if (field || row.length) await pushFieldAndRow();
  await flushBatch();
  const completed = await postJson("/api/import-complete", {});

  return {
    csvRowsRead: sourceRow,
    rowsInDatabase: completed.rowsInDatabase,
    unparsedRegistrationDates: unparsedDates,
  };
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

  $("uploadButton").disabled = true;
  setStatus("Importing");
  showImportResult(`Preparing ${file.name} for import.`);

  try {
    const stats = await importCsvFile(file);
    for (const field of fields) $(field).value = "";
    state.page = 1;
    await loadMeta();
    await loadRecords();
    showImportResult(
      `Imported ${formatNumber(stats.rowsInDatabase)} rows from ${formatNumber(stats.csvRowsRead)} CSV rows.`
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
