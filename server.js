const express = require("express");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

// Optional local configuration (see .env.example).
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

const app = express();

// Allow a front end served from another local origin to call this demo backend.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const PORT = parseInt(process.env.PORT || "4870", 10);

const INPUT_DIR = path.join(__dirname, "input-docs");
const STORAGE_DIR = path.join(__dirname, "storage");
const HISTORY_DIR = path.join(STORAGE_DIR, "history");
const CERTS_DIR = path.join(__dirname, "certs");
const TRUSTED_DIR = path.join(CERTS_DIR, "trusted");

for (const f of ["ca.crt", "alice.crt", "alice.key", "bob.crt", "bob.key", "carol.crt", "carol.key", "trusted/demo-ca.pem"]) {
  if (!fs.existsSync(path.join(CERTS_DIR, f))) {
    console.error(`Missing certs/${f}. Run "npm run generate-certs" first.`);
    process.exit(1);
  }
}

const USERS = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
  { id: "carol", name: "Carol" }
];

fs.mkdirSync(HISTORY_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/vendor/nutrient",
  express.static(path.join(__dirname, "node_modules/@nutrient-sdk/viewer/dist"))
);

// Web SDK license key, read from the environment only. Empty = evaluation mode.
app.get("/api/config", (req, res) => {
  res.json({ licenseKey: process.env.NUTRIENT_WEB_LICENSE_KEY || null });
});

app.get("/api/users", (req, res) => res.json(USERS));

app.get("/api/users/:id/certificates", (req, res) => {
  const user = USERS.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "unknown user" });
  res.json({
    name: user.name,
    certificate: fs.readFileSync(path.join(CERTS_DIR, `${user.id}.crt`), "utf8"),
    caCertificate: fs.readFileSync(path.join(CERTS_DIR, "ca.crt"), "utf8")
  });
});

app.post(
  "/api/users/:id/sign",
  express.raw({ type: "application/octet-stream", limit: "1mb" }),
  (req, res) => {
    const user = USERS.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "unknown user" });
    if (!req.body || req.body.length === 0) return res.status(400).json({ error: "empty payload" });
    const privateKey = fs.readFileSync(path.join(CERTS_DIR, `${user.id}.key`), "utf8");
    const signature = crypto.sign("sha256", req.body, privateKey);
    console.log(`signed ${req.body.length} bytes for ${user.name}`);
    res.json({ signature: signature.toString("base64") });
  }
);

app.get("/api/trusted-cas", (req, res) => {
  const pems = fs
    .readdirSync(TRUSTED_DIR)
    .filter((f) => /\.(pem|crt|cer)$/i.test(f))
    .map((f) => fs.readFileSync(path.join(TRUSTED_DIR, f), "utf8"));
  res.json(pems);
});

app.get("/api/documents", (req, res) => {
  const docs = fs
    .readdirSync(STORAGE_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => {
      const st = fs.statSync(path.join(STORAGE_DIR, f));
      const histDir = path.join(HISTORY_DIR, f);
      const versions = fs.existsSync(histDir) ? fs.readdirSync(histDir).length : 0;
      return { id: f, name: f, size: st.size, modified: st.mtime, versions };
    });
  res.json(docs);
});

function findMissingObjects(buf) {
  const defined = new Set();
  const objRe = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = objRe.exec(buf)) !== null) {
    const num = parseInt(m[1], 10);
    defined.add(num);
    const seg = buf.slice(m.index, buf.indexOf("endobj", m.index));
    if (seg.includes("/ObjStm")) {
      const h = seg.match(/\/N\s+(\d+)[\s\S]*?\/First\s+(\d+)/) || seg.match(/\/First\s+(\d+)[\s\S]*?\/N\s+(\d+)/);
      const sm = seg.match(/stream\r?\n/);
      if (h && sm) {
        try {
          const raw = Buffer.from(seg.slice(sm.index + sm[0].length), "latin1");
          const inflated = zlib.inflateSync(raw).toString("latin1");
          const n = parseInt(seg.match(/\/N\s+(\d+)/)[1], 10);
          const first = parseInt(seg.match(/\/First\s+(\d+)/)[1], 10);
          const header = inflated.slice(0, first).trim().split(/\s+/);
          for (let i = 0; i < 2 * n; i += 2) defined.add(parseInt(header[i], 10));
        } catch (e) {}
      }
    }
  }
  const referenced = new Set();
  const refRe = /(\d+)\s+\d+\s+R\b/g;
  while ((m = refRe.exec(buf)) !== null) referenced.add(parseInt(m[1], 10));
  return [...referenced].filter((n) => !defined.has(n)).sort((a, b) => a - b);
}

function repairPdf(buffer) {
  const text = buffer.toString("latin1");
  const missing = findMissingObjects(text);
  if (missing.length === 0) return { buffer, repaired: [] };

  const kind = (n) => {
    if (new RegExp(`/FXE\\d+\\s+${n}\\s+0\\s+R`).test(text)) return "gs";
    if (new RegExp(`/FXF\\d+\\s+${n}\\s+0\\s+R`).test(text)) return "font";
    return "stream";
  };

  const sxAll = [...text.matchAll(/startxref\s+(\d+)/g)];
  const trAll = [...text.matchAll(/trailer\s*<<([\s\S]*?)>>/g)];
  const lastSx = parseInt(sxAll[sxAll.length - 1][1], 10);
  const trailer = trAll[trAll.length - 1][1];
  const size = parseInt(trailer.match(/\/Size\s+(\d+)/)[1], 10);
  const root = trailer.match(/\/Root\s+(\d+)\s+\d+\s+R/)[1];
  const info = trailer.match(/\/Info\s+(\d+)\s+\d+\s+R/);
  const ids = trailer.match(/\/ID\s*(\[[^\]]*\])/);

  let out = text;
  if (!out.endsWith("\n")) out += "\n";
  const offsets = {};
  for (const n of missing) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    const k = kind(n);
    if (k === "gs") out += `${n} 0 obj\n<</BM/Normal/CA 1/ca 1>>\nendobj\n`;
    else if (k === "font") out += `${n} 0 obj\n<</BaseFont/Helvetica/Encoding/WinAnsiEncoding/Subtype/Type1/Type/Font>>\nendobj\n`;
    else out += `${n} 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n`;
  }
  const xrefOff = Buffer.byteLength(out, "latin1");
  let xref = "xref\n0 1\n0000000000 65535 f \n";
  const runs = [];
  for (const n of missing) {
    if (runs.length && n === runs[runs.length - 1][runs[runs.length - 1].length - 1] + 1) runs[runs.length - 1].push(n);
    else runs.push([n]);
  }
  for (const run of runs) {
    xref += `${run[0]} ${run.length}\n`;
    for (const n of run) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  out += xref;
  let tr = `trailer\n<</Size ${size} /Root ${root} 0 R /Prev ${lastSx}`;
  if (info) tr += ` /Info ${info[1]} 0 R`;
  if (ids) tr += ` /ID ${ids[1]}`;
  tr += `>>\nstartxref\n${xrefOff}\n%%EOF\n`;
  out += tr;
  return { buffer: Buffer.from(out, "latin1"), repaired: missing };
}

const USER_COLORS = { alice: [0.294, 0.482, 0.925], bob: [0.125, 0.749, 0.42], carol: [0.969, 0.569, 0.239] };

function appendIncrement(text, newObjects) {
  const sxAll = [...text.matchAll(/startxref\s+(\d+)/g)];
  const trAll = [...text.matchAll(/trailer\s*<<([\s\S]*?)>>/g)];
  const lastSx = parseInt(sxAll[sxAll.length - 1][1], 10);
  const trailer = trAll[trAll.length - 1][1];
  const oldSize = parseInt(trailer.match(/\/Size\s+(\d+)/)[1], 10);
  const root = trailer.match(/\/Root\s+(\d+)\s+\d+\s+R/)[1];
  const info = trailer.match(/\/Info\s+(\d+)\s+\d+\s+R/);
  const ids = trailer.match(/\/ID\s*(\[[^\]]*\])/);

  let out = text;
  if (!out.endsWith("\n")) out += "\n";
  const offsets = {};
  const nums = Object.keys(newObjects).map(Number).sort((a, b) => a - b);
  for (const n of nums) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += `${n} 0 obj\n${newObjects[n]}\nendobj\n`;
  }
  const xrefOff = Buffer.byteLength(out, "latin1");
  let xref = "xref\n0 1\n0000000000 65535 f \n";
  const runs = [];
  for (const n of nums) {
    if (runs.length && n === runs[runs.length - 1][runs[runs.length - 1].length - 1] + 1) runs[runs.length - 1].push(n);
    else runs.push([n]);
  }
  for (const run of runs) {
    xref += `${run[0]} ${run.length}\n`;
    for (const n of run) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  out += xref;
  const size = Math.max(oldSize, nums[nums.length - 1] + 1);
  let tr = `trailer\n<</Size ${size} /Root ${root} 0 R /Prev ${lastSx}`;
  if (info) tr += ` /Info ${info[1]} 0 R`;
  if (ids) tr += ` /ID ${ids[1]}`;
  tr += `>>\nstartxref\n${xrefOff}\n%%EOF\n`;
  return out + tr;
}

function latestObjectBody(text, num) {
  const re = new RegExp(`(?:^|[^0-9])${num}\\s+0\\s+obj\\b`, "g");
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) last = m.index + m[0].indexOf(`${num}`);
  if (last === null) return null;
  return text.slice(last, text.indexOf("endobj", last));
}

function prepareSignatureFields(buffer) {
  const text = buffer.toString("latin1");
  if (/\/FT\s*\/Sig/.test(text)) return { buffer, prepared: false };

  const catalogRef = [...text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop();
  if (!catalogRef) return { buffer, prepared: false };
  const catalog = latestObjectBody(text, parseInt(catalogRef[1], 10));
  const afMatch = catalog && catalog.match(/\/AcroForm\s+(\d+)\s+\d+\s+R/);
  if (!afMatch) return { buffer, prepared: false };
  const afNum = parseInt(afMatch[1], 10);
  const acroForm = latestObjectBody(text, afNum);
  const fieldsMatch = acroForm.match(/\/Fields\s*\[([^\]]*)\]/);
  if (!fieldsMatch) return { buffer, prepared: false };

  let pageNum = null;
  const objRe = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = objRe.exec(text)) !== null) {
    const body = text.slice(m.index, text.indexOf("endobj", m.index));
    if (/\/Type\s*\/Page[^s]/.test(body)) { pageNum = parseInt(m[1], 10); break; }
  }
  if (pageNum === null) return { buffer, prepared: false };
  const page = latestObjectBody(text, pageNum);
  const mb = page.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/) ||
             text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  if (!mb) return { buffer, prepared: false };
  const pageWidth = parseFloat(mb[3]) - parseFloat(mb[1]);

  const maxObj = Math.max(...[...text.matchAll(/(\d+)\s+0\s+obj\b/g)].map((x) => parseInt(x[1], 10)));
  const w = 150, h = 55, gap = 20;
  const total = USERS.length * w + (USERS.length - 1) * gap;
  const startX = (pageWidth - total) / 2;

  const newObjects = {};
  const fieldRefs = [];
  USERS.forEach((u, i) => {
    const n = maxObj + 1 + i;
    const x0 = (startX + i * (w + gap)).toFixed(2);
    const x1 = (startX + i * (w + gap) + w).toFixed(2);
    const [r, g, b] = USER_COLORS[u.id] || [0.6, 0.6, 0.6];
    newObjects[n] =
      `<</FT/Sig/T(Signature-${u.id})/Type/Annot/Subtype/Widget` +
      `/Rect[${x0} 55 ${x1} 110]/P ${pageNum} 0 R/F 4` +
      `/MK<</BC[${r} ${g} ${b}]/BW 2>>/BS<</W 2/S/S>>>>`;
    fieldRefs.push(`${n} 0 R`);
  });

  const newFields = `/Fields[${fieldsMatch[1].trim()} ${fieldRefs.join(" ")} ]`;
  let newAcroForm = acroForm.replace(/\/Fields\s*\[[^\]]*\]/, newFields);
  if (!/\/SigFlags/.test(newAcroForm)) newAcroForm = newAcroForm.replace(/>>\s*$/, "/SigFlags 3>>");
  newObjects[afNum] = newAcroForm.replace(new RegExp(`^${afNum}\\s+0\\s+obj\\s*`), "").trim();

  let newPage;
  const annotsMatch = page.match(/\/Annots\s*\[([^\]]*)\]/);
  if (annotsMatch) {
    newPage = page.replace(/\/Annots\s*\[[^\]]*\]/, `/Annots[${annotsMatch[1].trim()} ${fieldRefs.join(" ")} ]`);
  } else {
    newPage = page.replace(/<</, `<</Annots[ ${fieldRefs.join(" ")} ]`);
  }
  newObjects[pageNum] = newPage.replace(new RegExp(`^${pageNum}\\s+0\\s+obj\\s*`), "").trim();

  const out = appendIncrement(text, newObjects);
  return { buffer: Buffer.from(out, "latin1"), prepared: true };
}

function extractToken(dict, key) {
  const m = dict.match(new RegExp(`\\/${key}(?![A-Za-z0-9_])\\s*`));
  if (!m) return null;
  let i = m.index + m[0].length;
  const c = dict[i];
  let end;
  if (c === "(") {
    let depth = 0;
    end = i;
    while (end < dict.length) {
      const ch = dict[end];
      if (ch === "\\") { end += 2; continue; }
      if (ch === "(") depth++;
      if (ch === ")") { depth--; if (depth === 0) { end++; break; } }
      end++;
    }
  } else if (c === "<" && dict[i + 1] !== "<") {
    // Hex string, e.g. a UTF-16 field name written as /T <FEFF...>.
    end = dict.indexOf(">", i);
    if (end === -1) return null;
    end++;
  } else if (c === "/") {
    end = i + 1;
    while (end < dict.length && !/[\s/<>\[\]()]/.test(dict[end])) end++;
  } else if (/[\d.+-]/.test(c)) {
    end = i;
    while (end < dict.length && /[\d.+-]/.test(dict[end])) end++;
  } else {
    return null;
  }
  return `/${key} ${dict.slice(i, end)}`;
}

function mergeHybridFields(buffer) {
  const text = buffer.toString("latin1");
  const objRe = /(\d+)\s+0\s+obj\b/g;
  const bodies = {};
  let m;
  while ((m = objRe.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    const end = text.indexOf("endobj", m.index);
    bodies[num] = text.slice(m.index + m[0].length, end).trim();
  }

  const catalogRef = [...text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop();
  if (!catalogRef) return { buffer, merged: [] };
  const catalog = bodies[parseInt(catalogRef[1], 10)];
  const afMatch = catalog && catalog.match(/\/AcroForm\s+(\d+)\s+\d+\s+R/);
  if (!afMatch) return { buffer, merged: [] };
  const afNum = parseInt(afMatch[1], 10);
  const acroForm = bodies[afNum];
  const fieldsMatch = acroForm && acroForm.match(/\/Fields\s*\[([^\]]*)\]/);
  if (!fieldsMatch) return { buffer, merged: [] };
  const fieldRefs = [...fieldsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((x) => parseInt(x[1], 10));

  const newObjects = {};
  const replacements = {};
  const merged = [];
  for (const fNum of fieldRefs) {
    const field = bodies[fNum];
    if (!field || !/\/FT\s*\/(Tx|Btn|Ch)/.test(field)) continue;
    const kids = field.match(/\/Kids\s*\[\s*(\d+)\s+0\s+R\s*\]/);
    if (!kids) continue;
    const wNum = parseInt(kids[1], 10);
    const widget = bodies[wNum];
    if (!widget || !/\/Subtype\s*\/Widget/.test(widget)) continue;

    let mergedDict = widget.replace(/\/Parent\s+\d+\s+\d+\s+R\s*/, "");
    const carry = [];
    for (const key of ["FT", "T", "DA", "Ff", "Q", "V", "DV", "TU"]) {
      if (new RegExp(`\\/${key}(?![A-Za-z0-9_])`).test(mergedDict)) continue;
      const tok = extractToken(field, key);
      if (tok) carry.push(tok);
    }
    if (!carry.length) continue;
    mergedDict = mergedDict.replace(/>>\s*$/, carry.join("") + ">>");
    newObjects[wNum] = mergedDict;
    replacements[fNum] = wNum;
    merged.push(wNum);
  }
  if (merged.length === 0) return { buffer, merged: [] };

  let newFieldsList = fieldsMatch[1];
  for (const [oldRef, newRef] of Object.entries(replacements)) {
    newFieldsList = newFieldsList.replace(new RegExp(`\\b${oldRef}\\s+0\\s+R`), `${newRef} 0 R`);
  }
  newObjects[afNum] = acroForm.replace(/\/Fields\s*\[[^\]]*\]/, `/Fields[${newFieldsList.trim()} ]`);

  const out = appendIncrement(text, newObjects);
  return { buffer: Buffer.from(out, "latin1"), merged };
}

function untagDocument(buffer) {
  const text = buffer.toString("latin1");
  const catalogRef = [...text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop();
  if (!catalogRef) return { buffer, untagged: false };
  const num = parseInt(catalogRef[1], 10);
  const catalog = latestObjectBody(text, num);
  if (!catalog || !/\/StructTreeRoot/.test(catalog)) return { buffer, untagged: false };
  let body = catalog.replace(new RegExp(`^${num}\\s+0\\s+obj\\s*`), "").trim();
  body = body.replace(/\/StructTreeRoot\s+\d+\s+\d+\s+R\s*/, "");
  body = body.replace(/\/MarkInfo\s*<<[^>]*>>\s*/, "");
  const out = appendIncrement(text, { [num]: body });
  return { buffer: Buffer.from(out, "latin1"), untagged: true };
}

function seedDocument(name) {
  const src = path.join(INPUT_DIR, name);
  const dest = path.join(STORAGE_DIR, name);
  let buf = fs.readFileSync(src);
  if (buf.includes("/ByteRange")) {
    fs.writeFileSync(dest, buf);
    return;
  }
  const untag = untagDocument(buf);
  if (untag.untagged) console.log(`removed structure tree tagging in ${name}`);
  const mergeRes = mergeHybridFields(untag.buffer);
  if (mergeRes.merged.length > 0) {
    console.log(`merged hybrid form fields in ${name}: widgets ${mergeRes.merged.join(", ")}`);
  }
  const { buffer, prepared } = prepareSignatureFields(mergeRes.buffer);
  fs.writeFileSync(dest, buffer);
  if (prepared) console.log(`prepared signature fields in ${name}`);
}

function removeValueToken(dict) {
  const idx = dict.search(/\/V\s*[(/]/);
  if (idx === -1) return null;
  let i = dict.indexOf("V", idx) + 1;
  while (dict[i] === " " || dict[i] === "\n" || dict[i] === "\r") i++;
  let end;
  if (dict[i] === "(") {
    let depth = 0;
    end = i;
    while (end < dict.length) {
      const c = dict[end];
      if (c === "\\") { end += 2; continue; }
      if (c === "(") depth++;
      if (c === ")") { depth--; if (depth === 0) { end++; break; } }
      end++;
    }
  } else if (dict[i] === "/") {
    end = i + 1;
    while (end < dict.length && !/[\s/<>\[\]()]/.test(dict[end])) end++;
  } else {
    return null;
  }
  return dict.slice(0, idx) + dict.slice(end);
}

function normalizeFillRevision(buffer, prevPath) {
  if (!fs.existsSync(prevPath)) return { buffer, normalized: [] };
  const prev = fs.readFileSync(prevPath);
  if (buffer.length <= prev.length) return { buffer, normalized: [] };
  if (!buffer.slice(0, prev.length).equals(prev)) return { buffer, normalized: [] };

  const tail = buffer.slice(prev.length).toString("latin1");
  if (tail.includes("/ByteRange")) return { buffer, normalized: [] };

  const tailObjects = {};
  const order = [];
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = re.exec(tail)) !== null) {
    const num = parseInt(m[1], 10);
    const start = m.index + m[0].length;
    const end = tail.indexOf("endobj", start);
    if (end === -1) continue;
    if (!(num in tailObjects)) order.push(num);
    tailObjects[num] = tail.slice(start, end).trim();
  }
  if (order.length === 0) return { buffer, normalized: [] };

  const normalized = [];
  for (const num of order) {
    const body = tailObjects[num];
    const isPureWidget =
      /\/Subtype\s*\/Widget/.test(body) &&
      /\/Parent\s+\d+\s+\d+\s+R/.test(body) &&
      !/\/FT\s*\//.test(body);
    if (isPureWidget && /\/V\s*[(/]/.test(body)) {
      const cleaned = removeValueToken(body);
      if (cleaned) {
        tailObjects[num] = cleaned;
        normalized.push(num);
      }
    }
  }
  if (normalized.length === 0) return { buffer, normalized: [] };

  const baseText = prev.toString("latin1");
  const out = appendIncrement(baseText, tailObjects);
  return { buffer: Buffer.from(out, "latin1"), normalized };
}

const MESSAGE_DIGEST_OID = Buffer.from("06092a864886f70d010904", "hex");

function verifySignatures(buffer) {
  const text = buffer.toString("latin1");
  const results = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [b0, l0, b1, l1] = [1, 2, 3, 4].map((i) => parseInt(m[i], 10));
    const entry = { byteRange: [b0, l0, b1, l1], coveredEnd: b1 + l1 };
    if (b0 !== 0 || b1 < l0 || b1 + l1 > buffer.length) {
      entry.status = "invalid";
      entry.reason = "byte range out of bounds";
      results.push(entry);
      continue;
    }
    const hexRegion = text.slice(l0, b1);
    const hexMatch = hexRegion.match(/^\s*<([0-9A-Fa-f]+)>\s*$/);
    if (!hexMatch) {
      entry.status = "invalid";
      entry.reason = "contents placeholder does not exactly fill the byte range gap";
      results.push(entry);
      continue;
    }
    const der = Buffer.from(hexMatch[1], "hex");
    const digest = crypto
      .createHash("sha256")
      .update(buffer.slice(b0, b0 + l0))
      .update(buffer.slice(b1, b1 + l1))
      .digest();
    let found = false;
    let idx = der.indexOf(MESSAGE_DIGEST_OID);
    while (idx !== -1 && !found) {
      const window = der.slice(idx, idx + 96);
      const marker = window.indexOf(Buffer.from("0420", "hex"));
      if (marker !== -1 && window.slice(marker + 2, marker + 34).equals(digest)) found = true;
      idx = der.indexOf(MESSAGE_DIGEST_OID, idx + 1);
    }
    entry.status = found ? "valid" : "invalid";
    if (!found) entry.reason = "sha256 digest does not match the signed messageDigest attribute";
    results.push(entry);
  }
  const missing = findMissingObjects(text);
  return {
    signatures: results,
    allValid: results.every((r) => r.status === "valid"),
    danglingObjects: missing
  };
}

function safeDocPath(id) {
  const name = path.basename(id);
  if (!name.toLowerCase().endsWith(".pdf")) return null;
  return path.join(STORAGE_DIR, name);
}

app.get("/api/documents/:id/file", (req, res) => {
  const p = safeDocPath(req.params.id);
  if (!p || !fs.existsSync(p)) return res.status(404).end();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  res.send(fs.readFileSync(p));
});

app.post(
  "/api/documents/:id/file",
  express.raw({ type: "application/pdf", limit: "100mb" }),
  (req, res) => {
    const p = safeDocPath(req.params.id);
    if (!p) return res.status(400).json({ error: "invalid document id" });
    if (fs.existsSync(p)) {
      const histDir = path.join(HISTORY_DIR, path.basename(p));
      fs.mkdirSync(histDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(p, path.join(histDir, `${stamp}.pdf`));
    }
    const norm = normalizeFillRevision(req.body, p);
    if (norm.normalized.length > 0) {
      console.log(`normalized ${path.basename(p)}: removed stray /V from widgets ${norm.normalized.join(", ")}`);
    }
    const { buffer, repaired } = repairPdf(norm.buffer);
    if (repaired.length > 0) {
      console.log(`repaired ${path.basename(p)}: added missing objects ${repaired.join(", ")}`);
    }
    const check = verifySignatures(buffer);
    if (!check.allValid) {
      console.error(`rejected save of ${path.basename(p)}:`, JSON.stringify(check.signatures));
      return res.status(422).json({
        error: "signature verification failed, document not saved",
        verification: check
      });
    }
    fs.writeFileSync(p, buffer);
    console.log(
      `saved ${path.basename(p)}: ${check.signatures.length} signature(s) verified` +
      (check.danglingObjects.length ? `, dangling refs: ${check.danglingObjects.join(",")}` : "")
    );
    res.json({ ok: true, size: buffer.length, repaired, verification: check });
  }
);

app.post("/api/documents/:id/reset", (req, res) => {
  const name = path.basename(req.params.id);
  const src = path.join(INPUT_DIR, name);
  if (!safeDocPath(name) || !fs.existsSync(src)) return res.status(404).json({ error: "no seed copy" });
  seedDocument(name);
  res.json({ ok: true });
});

for (const f of fs.readdirSync(INPUT_DIR)) {
  if (!f.toLowerCase().endsWith(".pdf")) continue;
  if (!fs.existsSync(path.join(STORAGE_DIR, f))) seedDocument(f);
}

app.listen(PORT, () => {
  console.log(`Multi-signature PoC running at http://localhost:${PORT}`);
});
