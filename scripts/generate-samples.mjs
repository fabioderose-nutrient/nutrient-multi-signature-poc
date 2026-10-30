// Generates the sample documents of the demo in ./input-docs:
//
//   service-agreement.pdf                   one-page form: text fields, a
//                                           dropdown, a radio group, two check
//                                           boxes and one signature field per
//                                           signer (Signature-alice, -bob, -carol)
//   service-agreement-with-attachments.pdf  the same form with two embedded
//                                           files (a CSV and a text file)
//
// All names, companies and figures are made up. The output is deterministic,
// so the committed PDFs only change when this script changes.
//
//   npm run generate-samples
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from "pdf-lib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "input-docs");
const FIXED_DATE = new Date("2026-01-15T09:00:00Z");

// Same signers and colors as server.js.
const SIGNERS = [
  { id: "alice", name: "Alice", role: "Requester", color: [0.294, 0.482, 0.925] },
  { id: "bob", name: "Bob", role: "Reviewer", color: [0.125, 0.749, 0.42] },
  { id: "carol", name: "Carol", role: "Approver", color: [0.969, 0.569, 0.239] },
];

const INK = rgb(0.11, 0.12, 0.14);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.85, 0.87, 0.9);

async function buildForm({ attachments = false } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(attachments ? "Service agreement with attachments (sample)" : "Service agreement (sample)");
  pdf.setAuthor("Nutrient multi-signature demo");
  pdf.setSubject("Fictitious form for a three-signer approval workflow");
  pdf.setCreator("scripts/generate-samples.mjs");
  pdf.setProducer("pdf-lib");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([612, 792]); // US Letter
  const form = pdf.getForm();
  const left = 56;
  const right = 556;
  let y = 736;

  const text = (str, x, yy, size = 10, font = regular, color = INK) => page.drawText(str, { x, y: yy, size, font, color });
  const heading = (str) => {
    y -= 30;
    text(str, left, y, 11, bold);
    page.drawLine({ start: { x: left, y: y - 6 }, end: { x: right, y: y - 6 }, thickness: 0.6, color: LINE });
    y -= 42;
  };
  const textField = (name, label, x, width, value = "") => {
    text(label, x, y + 22, 8, regular, MUTED);
    const field = form.createTextField(name);
    if (value) field.setText(value);
    field.addToPage(page, { x, y, width, height: 18, font: regular, borderColor: rgb(0.7, 0.72, 0.76), borderWidth: 1 });
    field.setFontSize(10);
    return field;
  };

  text("SERVICE AGREEMENT", left, y, 18, bold);
  y -= 18;
  text("Sample document for the Nutrient multi-signature demo. All names and data are fictitious.", left, y, 9, regular, MUTED);
  if (attachments) {
    y -= 13;
    text("This version carries two attachments: a price list (CSV) and a service description (TXT).", left, y, 9, regular, MUTED);
  }

  heading("1. Parties");
  text("Supplier", left, y + 22, 8, regular, MUTED);
  text("Example Supplies Ltd., 1 Sample Street, Anytown", left, y + 5, 10);
  y -= 44;
  textField("customer_company", "Customer company", left, 240);
  textField("contact_name", "Contact name", left + 260, 240);
  y -= 44;
  textField("contact_email", "Contact email", left, 240);

  heading("2. Service");
  text("Plan", left, y + 22, 8, regular, MUTED);
  const plan = form.createDropdown("plan");
  plan.addOptions(["Basic", "Standard", "Premium"]);
  plan.addToPage(page, { x: left, y, width: 150, height: 18, font: regular, borderColor: rgb(0.7, 0.72, 0.76), borderWidth: 1 });
  plan.setFontSize(10);
  textField("start_date", "Start date (YYYY-MM-DD)", left + 170, 150);
  textField("seats", "Number of seats", left + 340, 160);
  y -= 40;
  text("Billing", left, y + 4, 8, regular, MUTED);
  const billing = form.createRadioGroup("billing");
  [["Monthly", left + 50], ["Yearly", left + 140]].forEach(([label, x]) => {
    billing.addOptionToPage(label, page, { x, y, width: 12, height: 12, borderColor: rgb(0.45, 0.47, 0.52), borderWidth: 1 });
    text(label, x + 18, y + 2, 10);
  });

  heading("3. Terms");
  const terms = [
    "The Supplier provides its hosted document service for the plan and number of seats selected above.",
    "Fees are invoiced in advance for each billing period. Either party may end this agreement with 30 days",
    "written notice. This document is a sample and has no legal effect.",
  ];
  terms.forEach((line) => {
    text(line, left, y + 6, 9.5);
    y -= 14;
  });
  y -= 10;
  const check = (name, label) => {
    const box = form.createCheckBox(name);
    box.addToPage(page, { x: left, y, width: 12, height: 12, borderColor: rgb(0.45, 0.47, 0.52), borderWidth: 1 });
    text(label, left + 20, y + 2, 9.5);
    y -= 22;
  };
  check("accept_terms", "I have read and accept the terms of this agreement.");
  check("accept_privacy", "I agree that the contact details above are stored to manage this agreement.");

  heading("4. Approvals");
  text("Each person fills in their fields, then signs in this order: Alice, Bob, Carol.", left, y + 6, 9.5);

  // Signature fields, one per signer, named the way server.js and app.js expect.
  const w = 150;
  const h = 55;
  const gap = 25;
  const startX = (612 - (SIGNERS.length * w + (SIGNERS.length - 1) * gap)) / 2;
  const sigY = 120;
  SIGNERS.forEach((s, i) => {
    const x0 = startX + i * (w + gap);
    const ref = pdf.context.register(
      pdf.context.obj({
        FT: "Sig",
        T: PDFString.of(`Signature-${s.id}`),
        Type: "Annot",
        Subtype: "Widget",
        Rect: [x0, sigY, x0 + w, sigY + h],
        P: page.ref,
        F: 4,
        MK: { BC: s.color, BW: 2 },
        BS: { W: 2, S: "S" },
      })
    );
    page.node.addAnnot(ref);
    form.acroForm.addField(ref);
    text(`${s.name}, ${s.role}`, x0, sigY - 16, 9, bold);
    text("Digital signature", x0, sigY - 29, 8, regular, MUTED);
  });
  form.acroForm.dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));

  page.drawLine({ start: { x: left, y: 60 }, end: { x: right, y: 60 }, thickness: 0.6, color: LINE });
  text("Example Supplies Ltd. - Service agreement - Page 1 of 1", left, 46, 8, regular, MUTED);

  if (attachments) {
    const csv = [
      "item,description,unit,price_usd",
      "BASIC,Basic plan per seat,month,12.00",
      "STANDARD,Standard plan per seat,month,24.00",
      "PREMIUM,Premium plan per seat,month,39.00",
      "ONBOARD,Onboarding session,once,450.00",
      "",
    ].join("\n");
    const description = [
      "SERVICE DESCRIPTION (SAMPLE)",
      "",
      "Example Supplies Ltd. provides a hosted document service with the following features:",
      "- Secure storage of documents in a single region",
      "- Business-hours support by email",
      "- Monthly usage report",
      "",
      "This file is fictitious and only used to demonstrate PDF attachments.",
      "",
    ].join("\n");
    await pdf.attach(Buffer.from(csv, "utf8"), "price-list.csv", {
      mimeType: "text/csv",
      description: "Price list (sample)",
      creationDate: FIXED_DATE,
      modificationDate: FIXED_DATE,
    });
    await pdf.attach(Buffer.from(description, "utf8"), "service-description.txt", {
      mimeType: "text/plain",
      description: "Service description (sample)",
      creationDate: FIXED_DATE,
      modificationDate: FIXED_DATE,
    });
  }

  // No object streams: server.js reads and updates the PDF structure as plain
  // text (signature field preparation and save checks).
  return pdf.save({ useObjectStreams: false });
}

await fs.mkdir(outDir, { recursive: true });
for (const [file, opts] of [
  ["service-agreement.pdf", {}],
  ["service-agreement-with-attachments.pdf", { attachments: true }],
]) {
  const bytes = await buildForm(opts);
  await fs.writeFile(path.join(outDir, file), bytes);
  console.log(`Wrote input-docs/${file} (${(bytes.length / 1024).toFixed(0)} KB)`);
}
