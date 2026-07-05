"use strict";

// ---------- tiny DOM helpers (no framework — brief calls for plain JS, no build step) ----------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json", ...opts.headers } : opts.headers,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(body?.error?.message || body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 2200);
}

const ISSUE_CONDITIONS = new Set(["Dirty", "Corroded", "Leaking", "Damaged", "Missing Insulation", "Missing Label", "Poor Access"]);
const GOOD_CONDITIONS = new Set(["Clean", "Good Condition"]);
const LOW_CONFIDENCE_THRESHOLD = 0.6;

function formatDay(iso) {
  const date = new Date(iso);
  const now = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function tagNode(text, cls) {
  return el("span", { class: `tag${cls ? " " + cls : ""}`, text });
}

function conditionTagNode(condition) {
  if (ISSUE_CONDITIONS.has(condition)) return tagNode(condition, "tag-condition-issue");
  if (GOOD_CONDITIONS.has(condition)) return tagNode(condition, "tag-condition-good");
  return tagNode(condition);
}

// ---------- app state ----------

const state = {
  view: "ledger",
  photos: [],
  untagged: [],
  untaggedIndex: 0,
  searchQuery: "",
};

// ---------- view switching ----------

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "ledger") loadLedger();
  if (view === "grid") loadGrid();
  if (view === "untagged") loadUntagged();
}

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) switchView(btn.dataset.view);
});

// ---------- ledger ----------

async function loadLedger() {
  const container = document.getElementById("ledger-content");
  const { photos } = await api("/api/photos");
  state.photos = photos;
  renderDayGroups(photos, container, true);
}

function renderDayGroups(photos, container, showEmptyDropHint) {
  clear(container);
  if (photos.length === 0) {
    container.appendChild(
      el("div", { class: "empty-state" }, [
        el("div", { class: "empty-state-icon", text: "📷" }),
        el("div", { text: showEmptyDropHint ? "No photos yet — drop some above to get started." : "No photos match." }),
      ])
    );
    return;
  }

  const groups = new Map();
  for (const photo of photos) {
    const day = formatDay(photo.createdAt);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(photo);
  }

  for (const [day, dayPhotos] of groups) {
    const card = el("div", { class: "ledger-card" }, dayPhotos.map(renderLedgerRow));
    container.appendChild(el("div", { class: "day-group" }, [el("div", { class: "day-label", text: day }), card]));
  }
}

function renderLedgerRow(photo) {
  const isFailed = photo.status === "failed";
  const img = el("img", { class: "ledger-thumb", src: `/api/photos/${photo.id}/image`, alt: "" });
  const captionText = isFailed ? "Analysis failed — tap to view error and retry" : photo.caption || "(no caption)";
  const meta = [];
  if (isFailed) {
    meta.push(tagNode("Failed", "tag-condition-issue"));
  } else {
    if (photo.category) meta.push(tagNode(photo.category, "tag-category"));
    for (const c of photo.conditions ?? []) meta.push(conditionTagNode(c));
    if (photo.confidence != null && photo.confidence < LOW_CONFIDENCE_THRESHOLD) meta.push(tagNode("Needs review", "tag-lowconf"));
    if (!photo.site && !photo.project && !photo.workType) meta.push(tagNode("Untagged", "tag-untagged"));
  }

  const row = el("div", { class: "ledger-row", onclick: () => openDetail(photo.id) }, [
    img,
    el("div", { class: "ledger-body" }, [el("div", { class: "ledger-caption", text: captionText }), el("div", { class: "ledger-meta" }, meta)]),
    el("div", { class: "ledger-time", text: formatTime(photo.createdAt) }),
    el(
      "button",
      {
        class: "icon-btn",
        title: "Copy caption",
        onclick: (e) => {
          e.stopPropagation();
          copyCaption(photo);
        },
      },
      "⧉"
    ),
  ]);
  return row;
}

function copyCaption(photo) {
  if (!photo.caption) return toast("No caption to copy");
  navigator.clipboard.writeText(photo.caption).then(
    () => toast("Caption copied"),
    () => toast("Couldn't copy — clipboard blocked")
  );
}

// ---------- grid ----------

async function loadGrid() {
  const container = document.getElementById("grid-content");
  const { photos } = await api("/api/photos");
  state.photos = photos;
  renderGrid(photos, container);
}

function renderGrid(photos, container) {
  clear(container);
  if (photos.length === 0) {
    container.appendChild(el("div", { class: "empty-state" }, [el("div", { class: "empty-state-icon", text: "🖼️" }), el("div", { text: "No photos yet." })]));
    return;
  }
  const grid = el(
    "div",
    { class: "photo-grid" },
    photos.map((photo) =>
      el("div", { class: "grid-card", onclick: () => openDetail(photo.id) }, [
        el("img", { src: `/api/photos/${photo.id}/image`, alt: "" }),
        el("div", { class: "grid-card-caption", text: photo.status === "failed" ? "Analysis failed" : photo.caption || "(no caption)" }),
      ])
    )
  );
  container.appendChild(grid);
}

// ---------- untagged review queue ----------

async function refreshUntaggedBadge() {
  const { count } = await api("/api/photos/untagged?limit=1");
  document.getElementById("untagged-badge").textContent = count;
}

async function loadUntagged() {
  const { photos } = await api("/api/photos/untagged");
  state.untagged = photos;
  state.untaggedIndex = 0;
  renderUntaggedQueue();
}

function renderUntaggedQueue() {
  const container = document.getElementById("untagged-content");
  const subtitle = document.getElementById("untagged-subtitle");
  clear(container);

  if (state.untagged.length === 0) {
    subtitle.textContent = "Nothing to review";
    container.appendChild(el("div", { class: "empty-state" }, [el("div", { class: "empty-state-icon", text: "✅" }), el("div", { text: "All caught up — every photo has Site/Project/Work Type filled in." })]));
    return;
  }

  if (state.untaggedIndex >= state.untagged.length) {
    subtitle.textContent = "Done";
    container.appendChild(el("div", { class: "empty-state" }, [el("div", { class: "empty-state-icon", text: "🎉" }), el("div", { text: "Queue cleared for this session." })]));
    refreshUntaggedBadge();
    return;
  }

  const photo = state.untagged[state.untaggedIndex];
  subtitle.textContent = `${state.untaggedIndex + 1} of ${state.untagged.length} remaining`;

  const siteInput = el("input", { type: "text", placeholder: "e.g. Edinburgh Royal Infirmary" });
  const projectInput = el("input", { type: "text", placeholder: "e.g. Plant Room Upgrade" });
  const workTypeSelect = buildWorkTypeSelect();
  const noteInput = el("textarea", { placeholder: "Optional note…" });

  const card = el("div", { class: "tagging-card" }, [
    el("div", { class: "tagging-image-wrap" }, [
      el("img", { src: `/api/photos/${photo.id}/image`, alt: "" }),
      el("div", { class: "tagging-caption", text: photo.status === "failed" ? "Analysis failed for this photo." : photo.caption || "(no caption)" }),
    ]),
    el("div", { class: "tagging-form" }, [
      el("div", { class: "field" }, [el("label", { text: "Site" }), siteInput]),
      el("div", { class: "field" }, [el("label", { text: "Project" }), projectInput]),
      el("div", { class: "field" }, [el("label", { text: "Work Type" }), workTypeSelect]),
      el("div", { class: "field" }, [el("label", { text: "Note" }), noteInput]),
      el("div", { class: "tagging-actions" }, [
        el("button", { class: "btn btn-lime", onclick: () => saveTagAndAdvance(photo.id, siteInput, projectInput, workTypeSelect, noteInput) }, "Save & next"),
        el("button", { class: "btn btn-ghost", onclick: skipUntagged }, "Skip"),
      ]),
    ]),
  ]);
  container.appendChild(card);
}

function buildWorkTypeSelect() {
  const WORK_TYPES = [
    "",
    "Commissioning",
    "Flushing",
    "Water Sampling",
    "Legionella Sampling",
    "Disinfection/Chlorination",
    "Chemical Dosing",
    "Temperature Testing",
    "Pressure Testing",
    "Inspection",
    "Installation",
    "Fault Finding",
  ];
  return el(
    "select",
    {},
    WORK_TYPES.map((w) => el("option", { value: w, text: w || "— select —" }))
  );
}

async function saveTagAndAdvance(id, siteInput, projectInput, workTypeSelect, noteInput) {
  try {
    await api(`/api/photos/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        site: siteInput.value.trim() || null,
        project: projectInput.value.trim() || null,
        workType: workTypeSelect.value || null,
        note: noteInput.value.trim() || null,
      }),
    });
    toast("Saved");
    state.untaggedIndex++;
    renderUntaggedQueue();
  } catch (err) {
    toast(`Save failed: ${err.message}`);
  }
}

function skipUntagged() {
  state.untaggedIndex++;
  renderUntaggedQueue();
}

// ---------- search ----------

document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("search-input").value.trim();
  if (!q) return;
  runSearch(q);
});

document.getElementById("clear-search-btn").addEventListener("click", () => {
  document.getElementById("search-input").value = "";
  switchView("ledger");
});

async function runSearch(query) {
  state.searchQuery = query;
  switchView("search");
  document.getElementById("search-title").textContent = `Search: "${query}"`;
  document.getElementById("search-subtitle").textContent = "Searching…";
  const { photos } = await api(`/api/photos?search=${encodeURIComponent(query)}`);
  document.getElementById("search-subtitle").textContent = `${photos.length} result${photos.length === 1 ? "" : "s"}`;
  renderDayGroups(photos, document.getElementById("search-content"), false);
}

// ---------- upload ----------

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");

document.getElementById("upload-btn").addEventListener("click", () => fileInput.click());
dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) uploadFiles(fileInput.files);
  fileInput.value = "";
});

["dragover", "dragenter"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

async function uploadFiles(fileList) {
  const form = new FormData();
  for (const file of fileList) form.append("photos", file);

  dropzone.textContent = `Uploading and analyzing ${fileList.length} photo${fileList.length === 1 ? "" : "s"}… this can take a while on a fresh Anthropic account with low rate limits.`;

  try {
    const result = await api("/api/photos", { method: "POST", body: form });
    renderSessionSummary(result.summary);
    toast(`${result.summary.succeeded}/${result.summary.total} photos analyzed`);
    refreshUntaggedBadge();
    refreshCurrentView();
  } catch (err) {
    toast(`Upload failed: ${err.message}`);
  } finally {
    resetDropzoneText();
  }
}

function resetDropzoneText() {
  clear(dropzone);
  dropzone.appendChild(document.createTextNode("Drop photos here, or "));
  dropzone.appendChild(el("strong", { text: "click to choose files" }));
  dropzone.appendChild(document.createTextNode(" — no need to tag anything first."));
}

function renderSessionSummary(summary) {
  const slot = document.getElementById("summary-panel-slot");
  clear(slot);

  const stats = [
    ["Uploaded", summary.total],
    ["Analyzed OK", summary.succeeded],
    ["Failed", summary.failed],
  ];

  const equipmentChips = Object.entries(summary.equipmentCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => el("span", { class: "summary-chip", text: `${name} × ${count}` }));

  const issueChips = Object.entries(summary.issueCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => el("span", { class: "summary-chip issue", text: `${name} × ${count}` }));

  const panel = el("div", { class: "summary-panel" }, [
    el("h3", { text: "Batch summary" }),
    el(
      "div",
      { class: "summary-stats" },
      stats.map(([label, value]) => el("div", {}, [el("div", { class: "summary-stat-value", text: String(value) }), el("div", { class: "summary-stat-label", text: label })]))
    ),
    equipmentChips.length ? el("div", { class: "summary-chips", style: "margin-bottom:8px" }, equipmentChips) : null,
    issueChips.length ? el("div", { class: "summary-chips" }, issueChips) : el("div", { class: "summary-chips" }, [el("span", { class: "summary-chip", text: "No issues detected" })]),
  ]);
  slot.appendChild(panel);
}

// ---------- photo detail modal ----------

const modalOverlay = document.getElementById("modal-overlay");
document.getElementById("modal-close").addEventListener("click", closeDetail);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeDetail();
});

function closeDetail() {
  modalOverlay.classList.remove("active");
}

async function openDetail(id) {
  const { photo } = await api(`/api/photos/${id}`);
  renderDetail(photo);
  modalOverlay.classList.add("active");
}

function renderDetail(photo) {
  const body = document.getElementById("modal-body");
  const footer = document.getElementById("modal-footer");
  clear(body);
  clear(footer);

  const imageWrap = el("div", { class: "modal-image-wrap" }, [el("img", { src: `/api/photos/${photo.id}/image`, alt: "" })]);

  const details = el("div", { class: "modal-details" });

  if (photo.status === "failed") {
    details.appendChild(el("div", { class: "detail-section-label", text: "Analysis failed — real error" }));
    details.appendChild(el("div", { class: "error-box", text: photo.error?.message ? JSON.stringify(photo.error, null, 2) : "Unknown error" }));
  } else {
    const captionArea = el("textarea", { rows: 3 }, photo.caption || "");
    details.appendChild(el("div", { class: "detail-section-label", text: "Caption (editable)" }));
    details.appendChild(el("div", { class: "detail-caption-row" }, [captionArea, el("button", { class: "icon-btn", title: "Copy", onclick: () => copyCaption(photo) }, "⧉")]));

    details.appendChild(el("div", { class: "detail-section-label", text: "Category" }));
    details.appendChild(tagNode(photo.category || "—", "tag-category"));

    details.appendChild(el("div", { class: "detail-section-label", text: "Equipment" }));
    details.appendChild(el("div", { class: "tag-list" }, (photo.equipment ?? []).map((e) => tagNode(e)).concat(photo.equipment?.length ? [] : [tagNode("—")])));

    details.appendChild(el("div", { class: "detail-section-label", text: "Conditions" }));
    details.appendChild(el("div", { class: "tag-list" }, (photo.conditions ?? []).map(conditionTagNode).concat(photo.conditions?.length ? [] : [tagNode("—")])));

    details.appendChild(el("div", { class: "detail-section-label", text: "Activity" }));
    details.appendChild(el("div", { class: "tag-list" }, (photo.activities ?? []).map((a) => tagNode(a)).concat(photo.activities?.length ? [] : [tagNode("—")])));

    if (photo.confidence != null) {
      const pct = Math.round(photo.confidence * 100);
      details.appendChild(el("div", { class: "detail-section-label", text: `Confidence — ${pct}%` }));
      details.appendChild(
        el("div", { class: "confidence-bar-wrap" }, [
          el("div", { class: "confidence-bar" }, [el("div", { class: `confidence-bar-fill${photo.confidence < LOW_CONFIDENCE_THRESHOLD ? " low" : ""}`, style: `width:${pct}%` })]),
        ])
      );
    }

    if (photo.visibleText?.length) {
      details.appendChild(el("div", { class: "detail-section-label", text: "OCR text" }));
      details.appendChild(el("div", { class: "ocr-list", text: photo.visibleText.join(" · ") }));
    }

    if (photo.keywords?.length) {
      details.appendChild(el("div", { class: "detail-section-label", text: "Search keywords" }));
      details.appendChild(el("div", { class: "tag-list" }, photo.keywords.map((k) => tagNode(k))));
    }

    details.appendChild(el("div", { class: "detail-section-label", text: "Site / Project / Work Type / Note" }));
    const siteInput = el("input", { type: "text", value: photo.site || "", placeholder: "Site" });
    const projectInput = el("input", { type: "text", value: photo.project || "", placeholder: "Project" });
    const workTypeSelect = buildWorkTypeSelect();
    workTypeSelect.value = photo.workType || "";
    const noteInput = el("textarea", { rows: 2, placeholder: "Note" }, photo.note || "");
    details.appendChild(el("div", { class: "field" }, [siteInput]));
    details.appendChild(el("div", { class: "field" }, [projectInput]));
    details.appendChild(el("div", { class: "field" }, [workTypeSelect]));
    details.appendChild(el("div", { class: "field" }, [noteInput]));

    footer.appendChild(
      el(
        "button",
        {
          class: "btn btn-primary",
          onclick: () =>
            saveDetailEdits(photo.id, {
              caption: captionArea.value,
              site: siteInput.value.trim() || null,
              project: projectInput.value.trim() || null,
              workType: workTypeSelect.value || null,
              note: noteInput.value.trim() || null,
            }),
        },
        "Save changes"
      )
    );
  }

  footer.appendChild(el("button", { class: "btn btn-ghost", onclick: () => retryPhoto(photo.id) }, photo.status === "failed" ? "Retry analysis" : "Re-analyze"));

  body.appendChild(imageWrap);
  body.appendChild(details);
}

async function saveDetailEdits(id, updates) {
  try {
    await api(`/api/photos/${id}`, { method: "PATCH", body: JSON.stringify(updates) });
    toast("Saved");
    closeDetail();
    refreshUntaggedBadge();
    refreshCurrentView();
  } catch (err) {
    toast(`Save failed: ${err.message}`);
  }
}

async function retryPhoto(id) {
  toast("Re-analyzing…");
  try {
    const { photo } = await api(`/api/photos/${id}/retry`, { method: "POST" });
    toast("Analysis succeeded");
    renderDetail(photo);
  } catch (err) {
    // A retry that fails again is still a successful round-trip (502, not a
    // network failure) — the server includes the updated photo (with its
    // fresh error) in the response body, so the modal must still re-render
    // with it. Otherwise the user sees the error from BEFORE this retry.
    toast(`Still failing: ${err.message}`);
    if (err.body?.photo) renderDetail(err.body.photo);
  }
  refreshCurrentView();
}

function refreshCurrentView() {
  if (state.view === "ledger") loadLedger();
  else if (state.view === "grid") loadGrid();
  else if (state.view === "untagged") loadUntagged();
  else if (state.view === "search") runSearch(state.searchQuery);
}

// ---------- boot ----------

refreshUntaggedBadge();
loadLedger();
