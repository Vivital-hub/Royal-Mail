// Per-order pack sheet: top despatch note + bottom postage label (same A4 page)
// Sends via Microsoft Graph (no SMTP).
// If an order has labelPdfUrl we use it; otherwise, if RM_LABELS_PDF_URL returns a batch PDF,
// we map pages to orders by index.

import { DateTime } from "luxon";
import PDFDocument from "pdfkit";
import { PDFDocument as PDFLib } from "pdf-lib";

// ---------- Config via ENV ----------
const {
  // Royal Mail / Click & Drop API
  RM_API_BASE,
  RM_API_TOKEN,
  RM_LABELS_PDF_URL,           // optional batch labels PDF

  // Graph email
  MS_TENANT_ID,
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MAIL_FROM,
  RECIPIENT_EMAIL,

  BRAND_NAME = "Vivital",

  // Utility
  SIMULATE = "0",
  SINCE_HOURS = "24",
  ORDER_REF_PREFIX,
  LABEL_ROTATE_DEG = "90",      // 0, 90, 180, 270 (as needed)
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
        // labelPdfUrl: "https://example.com/label1.pdf"
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
    const doc = new PDFDocument({ size: "A4", margin: 36 }); // 595 x 842pt
    const chunks = [];
    doc.on("data", c => chunks.push(c));

    // Company heading (simple)
    doc.fontSize(18).text(`${BRAND_NAME} Ltd`, { align: "right" });
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor("#666").text("Unit 4 Rockhaven Business Centre, Westbury, Wiltshire, BA13 4FZ, United Kingdom", { align: "right" });
    doc.fillColor("#000").moveDown();

    // Shipping Address
    doc.fontSize(12).text("Shipping Address", 36, doc.y);
    doc.fontSize(11).moveDown(0.2);
    doc.text(order.recipient?.name || "");
    const addrLines = [order.address?.line1, order.address?.city, order.address?.postcode, "United Kingdom"]
      .filter(Boolean);
    addrLines.forEach(l => doc.text(l));
    doc.moveDown();

    // Meta: order no, channel ref, despatch date
    const created = order.createdAt ? DateTime.fromISO(order.createdAt).setZone("Europe/London") : nowUK;
    doc.fontSize(10);
    doc.text(`Order Number: ${order.orderNumber || order.orderReference || ""}`);
    if (order.channelRef) doc.text(`Channel Ref: ${order.channelRef}`);
    doc.text(`Despatch Date: ${nowUK.toFormat("dd/LL/yyyy")}`);
    doc.moveDown(0.6);

    // Items table
    doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor("#ccc").stroke().strokeColor("#000");
    doc.moveDown(0.4);
    doc.fontSize(11).text("Qty", 36, doc.y, { width: 40, continued: true });
    doc.text("SKU", { width: 90, continued: true });
    doc.text("Name", { width: 393 });
    doc.moveDown(0.2);
    doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor("#ccc").stroke().strokeColor("#000");
    doc.moveDown(0.3);
    doc.fontSize(10);

    for (const it of (order.items || [])) {
      const y = doc.y;
      doc.text(String(it.quantity ?? 1), 36, y, { width: 40, continued: true });
      doc.text(it.sku || "—", { width: 90, continued: true });
      doc.text(it.name || "—", { width: 393 });
      doc.moveDown(0.2);
    }

    // Leave bottom ~380pt clear for the label panel
    // Draw a faint divider where label will start (visual aid)
    const labelTopY = 842 - 380; // approx 462pt
    doc.moveTo(36, labelTopY).lineTo(559, labelTopY).strokeColor("#ddd").stroke().strokeColor("#000");

    doc.end();
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// ------------- labels fetch -------------
async function fetchLabelsForOrders(orders, sinceISO_utc) {
  // Prefer per-order URLs
  const perOrder = await Promise.all(orders.map(async (o) => {
    if (!o.labelPdfUrl) return null;
    try {
      const buf = await fetchBuffer(o.labelPdfUrl, { headers: { Authorization: `Bearer ${RM_API_TOKEN}` } });
      return { ref: o.orderReference || o.orderNumber, buffer: buf };
    } catch { return null; }
  }));

  const havePerOrder = perOrder.every(x => x); // all found
  if (havePerOrder) return perOrder;

  // Fall back to batch labels PDF mapped by index
  if (RM_LABELS_PDF_URL) {
    const url = RM_LABELS_PDF_URL.includes("{{since}}")
      ? RM_LABELS_PDF_URL.replace("{{since}}", encodeURIComponent(sinceISO_utc))
      : RM_LABELS_PDF_URL;
    try {
      const batchBuf = await fetchBuffer(url, { headers: { Authorization: `Bearer ${RM_API_TOKEN}` } });
      // Split pages
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
      // no labels available
    }
  }
  return orders.map(o => ({ ref: o.orderReference || o.orderNumber, buffer: null }));
}

// ------------- compose final per-order pages -------------
async function buildPackSheetsPDF(orders, labels) {
  const merged = await PDFLib.create();

  // Build a quick map by ref for per-order label lookup
  const labelMap = new Map(labels.map(l => [String(l.ref || ""), l.buffer]));

  for (const o of orders) {
    // 1) render the top section with pdfkit
    const topBuf = await renderPackSheetTopToBuffer(o);
    const topDoc = await PDFLib.load(topBuf);
    const [topPage] = await merged.copyPages(topDoc, [0]);
    merged.addPage(topPage);

    // 2) if we have a label PDF for this order, embed it into the bottom area of the same page
    const idx = merged.getPageCount() - 1;
    const page = merged.getPage(idx);
    const pageWidth = page.getWidth();   // 595
    const pageHeight = page.getHeight(); // 842

    const labelBuf = labelMap.get(String(o.orderReference || o.orderNumber));
    if (labelBuf) {
      try {
        const src = await PDFLib.load(labelBuf);
        const labelPage = await merged.embedPage(src.getPage(0));
        // available area at bottom
        const margin = 36;
        const availWidth = pageWidth - margin * 2;       // ~523
        const availHeight = 360;                          // ~360pt panel
        const rotate = Number(LABEL_ROTATE_DEG || 0);

        // Natural dims of the embedded page
        let { width, height } = labelPage.size();
        // If rotation requested, swap logical dims
        const rotated = (rotate % 180) !== 0;
        if (rotated) [width, height] = [height, width];

        // Scale to fit inside avail area
        const scale = Math.min(availWidth / width, availHeight / height);
        const drawWidth = width * scale;
        const drawHeight = height * scale;

        const x = margin + (availWidth - drawWidth) / 2;
        const y = margin + (pageHeight - margin - drawHeight) - 10; // stick to bottom panel

        page.drawPage(labelPage, {
          x, y, xScale: scale, yScale: scale,
          rotate: rotate ? { type: "degrees", angle: rotate } : undefined
        });
      } catch (e) {
        // if embedding fails, just continue
        console.warn("Embed label failed for", o.orderReference || o.orderNumber, e.message);
      }
    }
  }

  return Buffer.from(await merged.save());
}

// ------------- Graph email -------------
async function sendEmailViaGraph({ subject, attachments }) {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM, RECIPIENT_EMAIL } = process.env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET || !MAIL_FROM || !RECIPIENT_EMAIL) {
    throw new Error("Missing Graph email env vars");
  }

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
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(`Failed to get Microsoft Graph token: ${tokenRes.status} ${JSON.stringify(tokenData)}`);
  }

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
      body: { contentType: "Text", content: "Attached: Pack sheets (despatch note + label) ready to print." },
      attachments: graphAttachments
    },
    saveToSentItems: "false"
  };

  const sendRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_FROM)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(message)
  });
  if (!sendRes.ok) {
    const errText = await sendRes.text();
    throw new Error(`Graph sendMail failed: ${sendRes.status} ${errText}`);
  }
}

// ------------- main -------------
(async function run() {
  try {
    const sinceISO_utc = sinceUK.setZone("UTC").toISO();

    // 1) orders
    const allOrders = await fetchOrdersFromClickAndDrop(sinceISO_utc);

    // 2) VIV- only
    const prefix = (ORDER_REF_PREFIX || "").trim();
    const orders = prefix
      ? allOrders.filter(o => ((o.orderReference || o.orderNumber || "") + "").startsWith(prefix))
      : allOrders;

    if (!orders.length) {
      // still send an empty doc so you know it ran
      const empty = await buildPackSheetsPDF([], []);
      const subjectEmpty = `${BRAND_NAME} — Pack Sheets — ${nowUK.toFormat("dd LLL yyyy HH:mm")} (No orders)`;
      await sendEmailViaGraph({ subject: subjectEmpty, attachments: [{ name: "pack-sheets.pdf", buffer: empty }] });
      console.log("No orders; sent empty pack sheet.");
      return;
    }

    // 3) labels (per-order or batch)
    const labels = await fetchLabelsForOrders(orders, sinceISO_utc);

    // 4) compose per-order pages
    const pdf = await buildPackSheetsPDF(orders, labels);

    // 5) email
    const subject = `${BRAND_NAME} — Pack Sheets — ${nowUK.toFormat("dd LLL yyyy HH:mm")}`;
    await sendEmailViaGraph({ subject, attachments: [{ name: "pack-sheets.pdf", buffer: pdf }] });

    console.log(`Sent ${orders.length} pack sheets. Window ${sinceUK.toISO()} -> ${nowUK.toISO()} Prefix=${prefix || "(none)"}`);
  } catch (err) {
    console.error("FAILED:", err);
    process.exitCode = 1;
  }
})();
