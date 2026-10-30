const state = {
  instance: null,
  docId: null,
  userId: null,
  users: [],
  trustedCAs: null,
  config: null,
  electronNoticeShown: false,
  licensed: false,
  fieldOwners: {},
  fieldLabels: {},
  signatureFieldNames: new Set(),
  signedFieldNames: new Set(),
  annotationFields: {},
  sigCount: 0
};

const USER_COLORS = ["#4b7bec", "#20bf6b", "#f7913d"];

const $ = (id) => document.getElementById(id);

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function toArr(v) {
  if (!v) return [];
  if (typeof v.toArray === "function") return v.toArray();
  return Array.from(v);
}

function userById(id) {
  return state.users.find((u) => u.id === id);
}

function userColor(id) {
  return USER_COLORS[state.users.findIndex((u) => u.id === id)] || "#9aa0ab";
}

function workflowComplete() {
  return state.sigCount >= state.users.length;
}

let toastTimer = null;
function showToast(message, kind = "info", ms = 3200) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), ms);
}

function waitForLayout(el) {
  return new Promise((resolve) => {
    const check = () => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) return resolve();
      requestAnimationFrame(check);
    };
    check();
  });
}

async function loadDocument(docId) {
  state.docId = docId;
  await waitForLayout(document.getElementById("viewer"));
  try {
    NutrientViewer.unload("#viewer");
  } catch (e) {}
  state.instance = null;
  if (!state.trustedCAs) state.trustedCAs = await fetchJSON("/api/trusted-cas");
  if (!state.config) state.config = await fetchJSON("/api/config");

  const buffer = await (
    await fetch(`/api/documents/${encodeURIComponent(docId)}/file?ts=${Date.now()}`)
  ).arrayBuffer();

  const TOOLBAR_TYPES = new Set([
    "sidebar-thumbnails", "sidebar-signatures", "sidebar-attachments",
    "pager", "pan", "zoom-out", "zoom-in", "zoom-mode", "spacer",
    "search", "print", "export-pdf"
  ]);
  const loadConfig = {
    baseUrl: `${location.origin}/vendor/nutrient/`,
    container: "#viewer",
    document: buffer,
    trustedCAsCallback: () => Promise.resolve(state.trustedCAs),
    toolbarItems: NutrientViewer.defaultToolbarItems.filter((i) => TOOLBAR_TYPES.has(i.type)),
    initialViewState: new NutrientViewer.ViewState({
      showSignatureValidationStatus: NutrientViewer.ShowSignatureValidationStatusMode.IF_SIGNED
    })
  };
  const isElectron = /Electron/i.test(navigator.userAgent);
  const licensed = !!state.config.licenseKey && !isElectron;
  state.licensed = licensed;
  if (licensed) loadConfig.licenseKey = state.config.licenseKey;

  state.instance = await NutrientViewer.load(loadConfig);
  $("trial-banner").classList.toggle("hidden", licensed);
  if (state.config.licenseKey && isElectron && !state.electronNoticeShown) {
    state.electronNoticeShown = true;
    showToast("Embedded Electron browser detected: running in evaluation mode. The Web SDK license applies in regular browsers.", "info", 6000);
  }

  installFieldGuards();

  if (state.instance.viewState.readOnly) {
    await state.instance.setViewState((v) => v.set("readOnly", false));
  }
  state.instance.addEventListener("annotations.press", onAnnotationPress);

  await indexFormFields();
  await buildAnnotationOwnerMap();
  await syncWorkflow({ announce: true });
  highlightOwnFields();
  await refreshPanel();
}

function signatureFieldOwner(name) {
  const m = /^Signature-(.+)$/.exec(name || "");
  return m && userById(m[1]) ? m[1] : null;
}

async function indexFormFields() {
  const fields = toArr(await state.instance.getFormFields());
  const editable = [];
  state.signatureFieldNames = new Set();
  state.fieldLabels = {};
  state.fieldOwners = {};

  const positions = {};
  for (let p = 0; p < state.instance.totalPageCount; p++) {
    for (const a of toArr(await state.instance.getAnnotations(p))) {
      if (a.formFieldName && !(a.formFieldName in positions)) {
        positions[a.formFieldName] = { page: p, top: a.boundingBox.top, left: a.boundingBox.left };
      }
    }
  }

  for (const f of fields) {
    if (f instanceof NutrientViewer.FormFields.SignatureFormField) {
      state.signatureFieldNames.add(f.name);
      const owner = signatureFieldOwner(f.name);
      if (owner) {
        state.fieldOwners[f.name] = owner;
        state.fieldLabels[f.name] = `Signature (${userById(owner).name})`;
      }
      continue;
    }
    editable.push(f);
  }

  editable.sort((a, b) => {
    const pa = positions[a.name] || { page: 99, top: 0, left: 0 };
    const pb = positions[b.name] || { page: 99, top: 0, left: 0 };
    return pa.page - pb.page || pa.top - pb.top || pa.left - pb.left || a.name.localeCompare(b.name);
  });

  const typeCounters = {};
  for (const f of editable) {
    let typeName = "Field";
    if (f instanceof NutrientViewer.FormFields.TextFormField) typeName = "Text field";
    else if (f instanceof NutrientViewer.FormFields.CheckBoxFormField) typeName = "Checkbox";
    else if (f instanceof NutrientViewer.FormFields.RadioButtonFormField) typeName = "Radio group";
    else if (f instanceof NutrientViewer.FormFields.ComboBoxFormField) typeName = "Combo box";
    else if (f instanceof NutrientViewer.FormFields.ListBoxFormField) typeName = "List box";
    typeCounters[typeName] = (typeCounters[typeName] || 0) + 1;
    state.fieldLabels[f.name] = `${typeName} ${typeCounters[typeName]}`;
  }

  const n = state.users.length;
  const per = Math.max(1, Math.ceil(editable.length / n));
  editable.forEach((f, i) => {
    const idx = Math.min(Math.floor(i / per), n - 1);
    state.fieldOwners[f.name] = state.users[idx].id;
  });
}

function ownedFieldLabels(userId) {
  return Object.keys(state.fieldOwners)
    .filter(
      (name) =>
        state.fieldOwners[name] === userId && !state.signatureFieldNames.has(name)
    )
    .map((name) => state.fieldLabels[name] || name);
}

async function buildAnnotationOwnerMap() {
  state.annotationFields = {};
  for (let p = 0; p < state.instance.totalPageCount; p++) {
    for (const a of toArr(await state.instance.getAnnotations(p))) {
      if (a.formFieldName) state.annotationFields[String(a.id)] = a.formFieldName;
    }
  }
}

function highlightOwnFields() {
  const cd = state.instance.contentDocument;
  let styleEl = cd.getElementById ? cd.getElementById("own-fields-style") : cd.querySelector("#own-fields-style");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "own-fields-style";
    (cd.head || cd).appendChild(styleEl);
  }
  if (workflowComplete()) {
    styleEl.textContent = "";
    return;
  }
  const color = userColor(state.userId);
  const rules = [];
  for (const [annId, fieldName] of Object.entries(state.annotationFields)) {
    const owner = state.fieldOwners[fieldName];
    if (owner !== state.userId) continue;
    if (state.signedFieldNames.has(fieldName)) continue;
    rules.push(
      `[data-annotation-id="${annId}"] {` +
        ` outline: 2px solid ${color};` +
        ` outline-offset: 2px;` +
        ` box-shadow: 0 0 0 5px ${color}2e;` +
        ` border-radius: 2px; }`
    );
  }
  styleEl.textContent = rules.join("\n");
}

let lastWarn = { key: "", at: 0 };
function warnFieldBlocked(fieldName, owner) {
  const now = Date.now();
  if (lastWarn.key === fieldName && now - lastWarn.at < 1500) return;
  lastWarn = { key: fieldName, at: now };
  const u = userById(owner);
  const who = u ? u.name : owner;
  showToast(
    state.signatureFieldNames.has(fieldName)
      ? `This signature field is reserved for ${who}.`
      : `You can't edit this field. It is assigned to ${who}.`,
    "error"
  );
}

function installFieldGuards() {
  const cd = state.instance.contentDocument;
  const guard = (e) => {
    const holder = e.target && e.target.closest ? e.target.closest("[data-annotation-id]") : null;
    if (!holder) return;
    const fieldName = state.annotationFields[holder.getAttribute("data-annotation-id")];
    if (!fieldName || state.signedFieldNames.has(fieldName)) return;
    const owner = state.fieldOwners[fieldName];

    if (state.signatureFieldNames.has(fieldName)) {
      e.preventDefault();
      e.stopPropagation();
      if (owner && owner !== state.userId) {
        warnFieldBlocked(fieldName, owner);
      } else if (e.type === "click" && !workflowComplete() && !$("sign-btn").disabled) {
        openSignModal();
      }
      return;
    }

    if (!owner || owner === state.userId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "focusin" && e.target && typeof e.target.blur === "function") e.target.blur();
    warnFieldBlocked(fieldName, owner);
  };
  ["pointerdown", "click", "focusin", "beforeinput", "keydown", "paste"].forEach((t) =>
    cd.addEventListener(t, guard, true)
  );
}

function onAnnotationPress(event) {
  const ann = event.annotation;
  if (!(ann instanceof NutrientViewer.Annotations.WidgetAnnotation)) return;
  if (state.signedFieldNames.has(ann.formFieldName)) return;
  const owner = state.fieldOwners[ann.formFieldName];
  const isSignature = state.signatureFieldNames.has(ann.formFieldName);

  if (isSignature) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (owner && owner !== state.userId) {
      warnFieldBlocked(ann.formFieldName, owner);
    } else if (!workflowComplete()) {
      openSignModal();
    }
    return;
  }

  if (owner && owner !== state.userId) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    warnFieldBlocked(ann.formFieldName, owner);
  }
}

async function syncWorkflow({ announce = false } = {}) {
  const info = await state.instance.getSignaturesInfo();
  const sigs = toArr(info.signatures);
  state.sigCount = sigs.length;
  state.signedFieldNames = new Set(sigs.map((s) => s.signatureFormFQN).filter(Boolean));

  const step = Math.min(state.sigCount, state.users.length);
  const complete = step >= state.users.length;

  if (!complete) {
    const expected = state.users[step].id;
    const changed = state.userId !== expected;
    state.userId = expected;
    if (announce && changed) {
      showToast(`It's ${userById(expected).name}'s turn: fill your fields, then sign.`, "info");
    }
  } else {
    state.userId = state.users[state.users.length - 1].id;
    if (announce) {
      showToast("All signatures collected. The workflow is complete.", "success", 5000);
    }
  }

  $("sign-btn").disabled = complete || !state.licensed;
  $("sign-btn").title = !state.licensed
    ? "Signing is disabled in evaluation mode: signatures created with the evaluation watermark are rejected by other PDF readers. Set NUTRIENT_WEB_LICENSE_KEY and open the app in a regular browser to sign."
    : "";
  renderUserBadge();
  renderStepper();
}

function renderStepper() {
  const bar = $("stepper");
  const complete = workflowComplete();
  let html = "";
  state.users.forEach((u, i) => {
    const done = state.sigCount > i;
    const active = !complete && i === state.sigCount;
    const fields = ownedFieldLabels(u.id);
    html += `
      <div class="step ${done ? "done" : ""} ${active ? "active" : ""}">
        <span class="step-avatar" style="background:${userColor(u.id)}">${done ? "&#10003;" : i + 1}</span>
        <span class="step-body">
          <span class="step-name">${u.name}</span>
          <span class="step-fields">${done ? "Signed" : fields.length ? fields.join(", ") : "Sign only"}</span>
        </span>
      </div>
      <span class="step-arrow">&#8594;</span>`;
  });
  html += `
    <div class="step finish ${complete ? "done" : ""}">
      <span class="step-avatar" style="background:${complete ? "#20bf6b" : "#9aa0ab"}">${complete ? "&#10003;" : state.users.length + 1}</span>
      <span class="step-body">
        <span class="step-name">Complete</span>
        <span class="step-fields">${complete ? "All signatures valid" : `${state.sigCount}/${state.users.length} signatures`}</span>
      </span>
    </div>`;
  bar.innerHTML = html;
}

function renderUserBadge() {
  const u = userById(state.userId) || state.users[0];
  $("user-avatar").style.background = userColor(u.id);
  $("user-avatar").textContent = u.name.charAt(0);
  $("user-name").textContent = workflowComplete() ? "Workflow complete" : u.name;
}

const STATUS_META = {
  valid: { icon: "&#10003;", cls: "ok", label: "Valid" },
  warning: { icon: "!", cls: "warn", label: "Valid with warnings" },
  error: { icon: "&#10005;", cls: "bad", label: "Invalid" }
};

function meta(status) {
  return STATUS_META[status] || { icon: "?", cls: "warn", label: String(status) };
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function fmtDate(v) {
  if (!v) return "n/a";
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleString("en-GB");
}

async function getUnsignedSignatureFields() {
  const formFields = await state.instance.getFormFields();
  const info = await state.instance.getSignaturesInfo();
  const signed = new Set(
    toArr(info.signatures).map((s) => s.signatureFormFQN).filter(Boolean)
  );
  return toArr(formFields)
    .filter(
      (f) =>
        f instanceof NutrientViewer.FormFields.SignatureFormField &&
        !signed.has(f.name)
    )
    .map((f) => f.name);
}

async function refreshPanel() {
  const info = await state.instance.getSignaturesInfo();
  const overall = $("sig-overall");
  const list = $("sig-list");
  const sigs = toArr(info.signatures);

  if (sigs.length === 0) {
    overall.className = "sig-overall neutral";
    overall.textContent = "This document has no digital signatures yet.";
  } else {
    const m = meta(info.status);
    overall.className = `sig-overall ${m.cls}`;
    overall.innerHTML =
      `${m.icon} ${sigs.length} signature${sigs.length > 1 ? "s" : ""}: ${m.label}` +
      (info.documentModifiedSinceSignature
        ? ". Document was modified after the latest signature."
        : "");
  }

  let html = "";
  sigs.forEach((sig, i) => {
    const m = meta(sig.signatureValidationStatus);
    const signer = sig.signerName || sig.creatorName || "Unknown signer";
    html += `
      <details class="sig-card" ${sigs.length <= 3 ? "open" : ""}>
        <summary>
          <span class="sig-icon ${m.cls}">${m.icon}</span>
          <span class="sig-title">Revision ${i + 1}: ${esc(signer)}</span>
        </summary>
        <div class="sig-details">
          <div><span>Status</span><b class="${m.cls}">${m.label}</b></div>
          <div><span>Signed on</span><b>${fmtDate(sig.creationDate)}</b></div>
          ${sig.signatureReason ? `<div><span>Reason</span><b>${esc(sig.signatureReason)}</b></div>` : ""}
          ${sig.signatureLocation ? `<div><span>Location</span><b>${esc(sig.signatureLocation)}</b></div>` : ""}
          <div><span>Document integrity</span><b>${esc(sig.documentIntegrityStatus)}</b></div>
          <div><span>Certificate chain</span><b>${esc(sig.certificateChainValidationStatus)}</b></div>
          ${sig.signatureFormFQN ? `<div><span>Field</span><b>${esc(sig.signatureFormFQN)}</b></div>` : ""}
          ${sig.PAdESSignatureLevel ? `<div><span>PAdES level</span><b>${esc(sig.PAdESSignatureLevel)}</b></div>` : ""}
          <div><span>Certificate valid</span><b>${fmtDate(sig.validFrom)} to ${fmtDate(sig.validUntil)}</b></div>
          ${sig.isSelfSigned ? "<div><span>Note</span><b>Self-signed certificate</b></div>" : ""}
        </div>
      </details>`;
  });

  const unsigned = await getUnsignedSignatureFields();
  if (unsigned.length > 0) {
    html += `
      <details class="sig-card" open>
        <summary>
          <span class="sig-icon neutral">&#8226;</span>
          <span class="sig-title">Unsigned signature fields (${unsigned.length})</span>
        </summary>
        <div class="sig-details">
          ${unsigned.map((n) => `<div><span>Field</span><b>${esc(state.fieldLabels[n] || n)}</b></div>`).join("")}
        </div>
      </details>`;
  }

  list.innerHTML = html || "";
}

async function openSignModal() {
  const user = userById(state.userId);
  $("modal-user").textContent = user.name;

  const fieldSelect = $("field-select");
  fieldSelect.innerHTML = "";
  const optNew = document.createElement("option");
  optNew.value = "";
  optNew.textContent = "New signature (auto placement)";
  fieldSelect.appendChild(optNew);

  const unsigned = (await getUnsignedSignatureFields()).filter((name) => {
    const owner = state.fieldOwners[name];
    return !owner || owner === state.userId;
  });
  for (const name of unsigned) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = state.fieldLabels[name]
      ? `Your prepared field: ${state.fieldLabels[name]}`
      : `Existing field: ${name}`;
    fieldSelect.appendChild(opt);
  }
  if (unsigned.length > 0) fieldSelect.value = unsigned[0];

  $("reason-input").value = `Approved by ${user.name}`;
  $("modal-status").textContent = "";
  $("sign-modal").classList.remove("hidden");
}

async function nextSignaturePosition() {
  const info = await state.instance.getSignaturesInfo();
  const count = toArr(info.signatures).length;
  const pageInfo = state.instance.pageInfoForIndex(0);
  const w = 180;
  const h = 60;
  const perRow = Math.max(1, Math.floor((pageInfo.width - 80) / (w + 10)));
  const col = count % perRow;
  const row = Math.floor(count / perRow);
  return {
    pageIndex: 0,
    boundingBox: new NutrientViewer.Geometry.Rect({
      left: 40 + col * (w + 10),
      top: pageInfo.height - 80 - h - row * (h + 10),
      width: w,
      height: h
    })
  };
}

async function signAndSave() {
  const statusEl = $("modal-status");
  const confirmBtn = $("modal-confirm");
  confirmBtn.disabled = true;
  try {
    statusEl.textContent = "Saving form entries...";
    const filledPdf = await state.instance.exportPDF();
    const flushRes = await fetch(`/api/documents/${encodeURIComponent(state.docId)}/file`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: filledPdf
    });
    if (!flushRes.ok) {
      const flushData = await flushRes.json().catch(() => ({}));
      throw new Error(flushData.error || `saving form entries failed (HTTP ${flushRes.status})`);
    }
    await loadDocument(state.docId);

    statusEl.textContent = "Fetching signer certificates...";
    const certs = await fetchJSON(`/api/users/${state.userId}/certificates`);
    const certificates = [certs.certificate, certs.caCertificate];

    const fieldName = $("field-select").value || null;
    const reason = $("reason-input").value.trim() || "I approve this document";
    const location = $("location-input").value.trim() || "Head office";

    const preparation = {
      signingData: {
        signatureType: NutrientViewer.SignatureType.CAdES,
        certificates
      },
      signatureMetadata: {
        signerName: certs.name,
        signatureReason: reason,
        signatureLocation: location
      },
      appearance: {
        mode: NutrientViewer.SignatureAppearanceMode.descriptionOnly,
        showSigner: true,
        showReason: true,
        showSignDate: true,
        showLocation: true,
        showWatermark: false
      }
    };
    if (fieldName) {
      preparation.formFieldName = fieldName;
    } else {
      preparation.position = await nextSignaturePosition();
    }

    statusEl.textContent = "Signing document (hash signed by the server)...";
    await state.instance.signDocument(preparation, async ({ dataToBeSigned }) => {
      const res = await fetch(`/api/users/${state.userId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: dataToBeSigned
      });
      if (!res.ok) throw new Error(`signing service error (HTTP ${res.status})`);
      const data = await res.json();
      const bin = Uint8Array.from(atob(data.signature), (c) => c.charCodeAt(0));
      return { signedData: bin.buffer, certificates };
    });

    statusEl.textContent = "Saving signed document to server...";
    const pdf = await state.instance.exportPDF();
    const saveRes = await fetch(`/api/documents/${encodeURIComponent(state.docId)}/file`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: pdf
    });
    const saveData = await saveRes.json();
    if (!saveRes.ok) {
      throw new Error(saveData.error || `save failed (HTTP ${saveRes.status})`);
    }

    statusEl.textContent = "Reloading saved document from server...";
    $("sign-modal").classList.add("hidden");
    await loadDocument(state.docId);
    openPanel();
    if (saveData.verification) {
      const n = saveData.verification.signatures.length;
      showToast(
        `Saved. Server check: ${n} signature${n > 1 ? "s" : ""} cryptographically verified.`,
        "success",
        4000
      );
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message || err}`;
  } finally {
    confirmBtn.disabled = false;
  }
}

function openPanel() {
  $("sig-panel").classList.remove("collapsed");
}

function togglePanel() {
  $("sig-panel").classList.toggle("collapsed");
}

async function main() {
  const [users, docs] = await Promise.all([
    fetchJSON("/api/users"),
    fetchJSON("/api/documents")
  ]);
  state.users = users;
  state.userId = users[0].id;

  const docSelect = $("doc-select");
  docs.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.name;
    docSelect.appendChild(opt);
  });
  docSelect.onchange = () => loadDocument(docSelect.value);

  $("sign-btn").onclick = openSignModal;
  $("panel-btn").onclick = togglePanel;
  $("panel-close").onclick = togglePanel;
  $("modal-cancel").onclick = () => $("sign-modal").classList.add("hidden");
  $("modal-confirm").onclick = signAndSave;
  $("reset-btn").onclick = async () => {
    await fetch(`/api/documents/${encodeURIComponent(state.docId)}/reset`, { method: "POST" });
    await loadDocument(state.docId);
    showToast("Document restored to its original state. Workflow restarted.", "info");
  };

  const preferred = docs.find((d) => d.id === "service-agreement.pdf") || docs[0];
  docSelect.value = preferred.id;
  await loadDocument(preferred.id);
}

main().catch((err) => {
  console.error(err);
  alert(`Failed to start: ${err.message}`);
});
