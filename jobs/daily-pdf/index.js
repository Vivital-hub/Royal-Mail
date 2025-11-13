// Per-order pack sheet: top despatch note + bottom postage label (same A4 page)
// Sends via Microsoft Graph (no SMTP).
// If an order has labelPdfUrl we use it; otherwise, if RM_LABELS_PDF_URL returns a batch PDF,
// we map pages to orders by index.

import { DateTime } from "luxon";
import PDFDocument from "pdfkit";
import { PDFDocument as PDFLib } from "pdf-lib";

// ---------- Config via ENV ----------
const {
  RM_API_BASE,
  RM_API_TOKEN,
  RM_LABELS_PDF_URL, // optional batch labels PDF

  MS_TENANT_ID,
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MAIL_FROM,
  RECIPIENT_EMAIL,

  BRAND_NAME = "Vivital",

  SIMULATE = "0",
  SINCE_HOURS = "24",
  ORDER_REF_PREFIX,
  LABEL_ROTATE_DEG = "90" // 0, 90, 180, 270
} = process.env;

// Optional CLI --since=ISO
const sinceArg = process.argv.find(a => a.startsWith("--since="));
const sinceISO = sinceArg ? sinceArg.split("=")[1] : null;

const nowUK = DateTime.now().setZone("Europe/London");
const sinceUK = sinceISO
  ? DateTime.fromISO(sinceISO).setZone("Europe/London")
  : nowUK.minus({ hours: Number(SINCE_HOURS) });

// ------------- helpers -------------
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function fetchBuffer(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ------------- orders -------------
async function fetchOrdersFromClickAndDrop(sinceISO) {
  if (SIMULATE === "1") {
    return [
      {
        orderNumber: "VIV-10001",
        orderReference: "VIV-10001",
        recipient: { name: "Hannah Levine" },
        address: { line1: "6 Legat Close, Wadhurst", city: "East Sussex", postcode: "TN5 6FE" },
        createdAt: DateTime.now().minus({ hours: 2 }).toISO(),
        channelRef: "57681838260419536",
        items: [
          { sku: "TS1200", name: "Street Kingz Premium 1200GSM Heavy Duty Car Drying Towel - Ultra-Absorbent, 60x90cm - Twisted Loop Technology", quantity: 1 },
          { sku: "FSP01", name: "Microfibre Scrub Pad - Soft Microfibre/Rough Bristles - Perfect For Interior Cleaning", quantity: 1 }
        ],
        // labelPdfUrl: "https://example.com/test-label.pdf"
      }
    ];
  }

  const url = `${RM_API_BASE}/orders?since=${encodeURIComponent(sinceISO)}`;
  const data = await fetchJson(url, {
    headers: { Authorization: `Bearer ${RM_API_TOKEN}`, "Content-Type": "application/json" }
  });

  return (data.orders || []).map(o => ({
    orderNumber: o.orderNumber,
    orderReference: o.orderReference ?? o.orderNumber,
    recipient: { name: o.recipient?.name || "" },
    address: {
      line1: o.address?.line1 || "",
      city: o.address?.city || "",
      postcode: o.address?.postcode || ""
    },
    createdAt: o.createdAt,
    channelRef: o.channelRef || o.marketplaceRef || "",
    items: (o.items || []).map(it => ({
      sku: it.sku || it.SKU || "",
      name: it.name || it.title || "",
      quantity: Number(it.quantity ?? it.qty ?? 1)
    })),
    labelPdfUrl: o.labelPdfUrl || o.labelUrl || null
  }));
}

// ------------- build per-order pack page (despatch note) -------------
function renderPackSheetTopToBuffer(order) {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const chunks = [];
    doc.on("data", c => chunks.push(c));

    // Header
    doc.fontSize(18).text(`${BRAND_NAME} Ltd`, { align: "right" });
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor("#666")
      .text("Unit 4 Rockhaven Business Centre, Westbury, Wiltshire, BA13 4FZ, United Kingdom", { align: "right" });
    doc.fillColor("#000").moveDown();

    // Shipping Address
    doc.fontSize(12).text("Shipping Address", 36, doc.y);
    doc.fontSize(11).moveDown(0.2);
    doc.text(order.recipient?.name || "");
    const addrLines = [order.address?.line1, order.address?.city, order.address?.postcode, "United Kingdom"].filter(Boolean);
    addrLines.forEach(l => doc.text(l));
    doc.moveDown();

    // Meta info
    const created = order.createdAt ? DateTime.fromISO(order.createdAt).setZone("Europe/London") : nowUK;
    doc.fontSize(10);
    doc.text(`Order Number: ${order.orderNumber || order.orderReference || ""}`);
    if (order.channelRef) doc.text(`Channel Ref: ${order.channelRef}`);
    doc.text(`Despatch Date: ${nowUK.toFormat("dd/LL/yyyy")}`);
    doc.moveDown(0.6);

    // ===== Items table =====
    doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor("#ccc").stroke().strokeColor("#000");
    doc.moveDown(0.4);

    // Fixed columns
    const X_QTY = 36,  W_QTY = 30;
    const X_SKU = 72,  W_SKU = 70;
    const X_NAME = 148, W_NAME = 411;
    const ROW_H = 12;

    // Headers
    doc.fontSize(11);
    doc.text("Qty",  X_QTY,  doc.y, { width: W_QTY,  lineBreak: false });
    doc.text("SKU",  X_SKU,  doc.y, { width: W_SKU,  lineBreak: false });
    doc.text("Name", X_NAME, doc.y, { width: W_NAME, lineBreak: false });
    doc.moveDown(0.2);
    doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor("#ccc").stroke().strokeColor("#000");
    doc.moveDown(0.3);
    doc.fontSize(10);

    // Rows – SINGLE LINE with ellipsis
    for (const it of (order.items || [])) {
      const y = doc.y;
      doc.text(String(it.quantity ?? 1), X_QTY,  y, { width: W_QTY,  height: ROW_H, lineBreak: false });
      doc.text(it.sku || "—",            X_SKU,  y, { width: W_SKU,  height: ROW_H, lineBreak: false });
      doc.text(it.name || "—",           X_NAME, y, { width: W_NAME, height: ROW_H, lineBreak: false, ellipsis: true });
      doc.y = y + ROW_H;
      doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor("#eee").stroke().strokeColor("#000");
    }

    // Divider for label
    const labelTopY = 842 - 380;
    doc.moveTo(36, labelTopY).lineTo(559, labelTopY).strokeColor("#ddd").stroke();

    doc.end();
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// ------------- labels fetch -------------
async function fetchLabelsForOrders(orders, sinceISO_utc) {
  // Prefer per-order URLs
  const perOrder = await Promise.all(orders.map(async o => {
    if (!o.labelPdfUrl) return null;
    try {
      const buf = await fetchBuffer(o.labelPdfUrl, { headers: { Authorization: `Bearer ${RM_API_TOKEN}` } });
      return { ref: o.orderReference || o.orderNumber, buffer: buf };
    } catch { return null; }
  }));

  const havePerOrder = perOrder.length && perOrder.every(x => x);
  if (havePerOrder) return perOrder;

  // Fallback: batch labels PDF
  if (RM_LABELS_PDF_URL) {
    const url = RM_LABELS_PDF_URL.includes("{{since}}")
      ? RM_LABELS_PDF_URL.replace("{{since}}", encodeURIComponent(sinceISO_utc))
      : RM_LABELS_PDF_URL;
    try {
      const batchBuf = await fetchBuffer(url, { headers: { Authorization: `Bearer ${RM_API_TOKEN}` } });
      const pdf = await PDFLib.load(batchBuf);
      const out = [];
      for (let i = 0; i < Math.min(pdf.getPageCount(), orders.length); i++) {
        const single = await PDFLib.create();
        const [p] = await single.copyPages(pdf, [i]);
        single.addPage(p);
        out.push({ ref: orders[i].orderReference || orders[i].orderNumber, buffer: Buffer.from(await single.save()) });
      }
      return out;
    } catch {
      console.warn("No labels found in batch PDF");
    }
  }
  return orders.map(o => ({ ref: o.orderReference || o.orderNumber, buffer: null }));
}

// ------------- compose final PDF -------------
async function buildPackSheetsPDF(orders, labels) {
  const merged = await PDFLib.create();
  const labelMap = new Map(labels.map(l => [String(l.ref || ""), l.buffer]));

  for (const o of orders) {
    const topBuf = await renderPackSheetTopToBuffer(o);
    const topDoc = await PDFLib.load(topBuf);
    const [topPage] = await merged.copyPages(topDoc, [0]);
    merged.addPage(topPage);

    const page = merged.getPage(merged.getPageCount() - 1);
    const labelBuf = labelMap.get(String(o.orderReference || o.orderNumber));
    if (labelBuf) {
      try {
        const src = await PDFLib.load(labelBuf);
        const labelPage = await merged.embedPage(src.getPage(0));

        const pageWidth = page.getWidth();
        const pageHeight = page.getHeight();
        const margin = 36;
        const availWidth = pageWidth - margin * 2;
        const availHeight = 360;
        const rotate = Number(LABEL_ROTATE_DEG || 0);

        let { width, height } = labelPage.size();
        const rotated = (rotate % 180) !== 0;
        if (rotated) [width, height] = [height, width];

        const scale = Math.min(availWidth / width, availHeight / height);
        const drawWidth = width * scale;
        const drawHeight = height * scale;
        const x = margin + (availWidth - drawWidth) / 2;
        const y = margin + (pageHeight - margin - drawHeight) - 10;

        page.drawPage(labelPage, {
          x, y, xScale: scale, yScale: scale,
          rotate: rotate ? { type: "degrees", angle: rotate } : undefined
        });
      } catch (e) {
        console.warn("Label embed failed for", o.orderReference, e.message);
      }
    }
  }
  return Buffer.from(await merged.save());
}

// ------------- Graph email -------------
async function sendEmailViaGraph({ subject, attachments }) {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM, RECIPIENT_EMAIL } = process.env;

  const tokenRes = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials"
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token)
    throw new Error(`Failed to get Graph token: ${tokenRes.status}`);

  const graphAttachments = attachments.map(a => ({
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.name,
    contentBytes: a.buffer.toString("base64")
  }));

  const message = {
    message: {
      subject,
      from: { emailAddress: { address: MAIL_FROM } },
      toRecipients: [{ emailAddress: { address: RECIPIENT_EMAIL } }],
      body: { contentType: "Text", content: "Attached: Pack sheets (despatch note + label)." },
      attachments: graphAttachments
    },
    saveToSentItems: "false"
  };

  const sendRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_FROM)}/sendMail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });

  if (!sendRes.ok) throw new Error(`Graph sendMail failed: ${await sendRes.text()}`);
}

// ------------- main -------------
(async function run() {
  try {
    const sinceISO_utc = sinceUK.setZone("UTC").toISO();
    const allOrders = await fetchOrdersFromClickAndDrop(sinceISO_utc);

    const prefix = (ORDER_REF_PREFIX || "").trim();
    const orders = prefix
      ? allOrders.filter(o => ((o.orderReference || o.orderNumber || "") + "").startsWith(prefix))
      : allOrders;

    if (!orders.length) {
      const empty = await buildPackSheetsPDF([], []);
      const subjectEmpty = `${BRAND_NAME} — Pack Sheets — ${nowUK.toFormat("dd LLL yyyy HH:mm")} (No orders)`;
      await sendEmailViaGraph({
        subject: subjectEmpty,
        attachments: [{ name: "pack-sheets.pdf", buffer: empty }]
      });
      console.log("No orders; sent empty pack sheet.");
      return;
    }

    const labels = await fetchLabelsForOrders(orders, sinceISO_utc);
    const pdf = await buildPackSheetsPDF(orders, labels);
    const subject = `${BRAND_NAME} — Pack Sheets — ${nowUK.toFormat("dd LLL yyyy HH:mm")}`;

    await sendEmailViaGraph({
      subject,
      attachments: [{ name: "pack-sheets.pdf", buffer: pdf }]
    });

    console.log(`Sent ${orders.length} pack sheets.`);
  } catch (err) {
    console.error("FAILED:", err);
    process.exitCode = 1;
  }
})();
