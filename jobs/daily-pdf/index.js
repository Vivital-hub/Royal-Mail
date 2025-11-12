// Runs: fetch orders -> make PDF -> email it
// Works in SIMULATE mode if you don't have API yet.

import { DateTime } from "luxon";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";

// ---------- Config via ENV ----------
const {
  // Royal Mail / Click & Drop API
  RM_API_BASE,            // e.g. https://api.clickanddrop.royalmail.com (placeholder)
  RM_API_TOKEN,           // Bearer token for Click & Drop
  // Email
  MAIL_HOST,
  MAIL_PORT,
  MAIL_USER,
  MAIL_PASS,
  RECIPIENT_EMAIL,        // where to send the PDF
  BRAND_NAME = "Vivital",
  // Utility
  SIMULATE = "0",         // "1" to use fake orders (no RM API call)
  SINCE_HOURS = "24"      // pull last 24 hours by default
} = process.env;

// Optional: accept a CLI --since=ISO override (useful for manual tests)
const sinceArg = process.argv.find(a => a.startsWith("--since="));
const sinceISO = sinceArg ? sinceArg.split("=")[1] : null;

// Europe/London time for subject/timestamps
const nowUK = DateTime.now().setZone("Europe/London");
const sinceUK = sinceISO
  ? DateTime.fromISO(sinceISO).setZone("Europe/London")
  : nowUK.minus({ hours: Number(SINCE_HOURS) });

async function fetchOrdersFromClickAndDrop(sinceISO) {
  if (SIMULATE === "1") {
    // Fake data for testing without API
    return [
      {
        orderNumber: "CND-10001",
        recipient: { name: "Jess Example" },
        address: {
          line1: "2 Higher Hall Cottages, Norbury Town Lane",
          city: "Whitchurch",
          postcode: "SY13 4HT"
        },
        trackingNumber: "RMTEST123456GB",
        service: "Royal Mail Tracked 24",
        createdAt: DateTime.now().minus({ hours: 2 }).toISO()
      },
      {
        orderNumber: "CND-10002",
        recipient: { name: "Alex Customer" },
        address: {
          line1: "10 Baker Street",
          city: "London",
          postcode: "NW1 6XE"
        },
        trackingNumber: "RMTEST654321GB",
        service: "Royal Mail Tracked 48",
        createdAt: DateTime.now().minus({ hours: 4 }).toISO()
      }
    ];
  }

  // ----- Replace this block with the real Click & Drop API call you use -----
  // Example structure (pseudocode – fill in your real endpoint/params):
  const url = `${RM_API_BASE}/orders?since=${encodeURIComponent(sinceISO)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${RM_API_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`C&D fetch failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  // Normalize to the shape used below:
  return (data.orders || []).map(o => ({
    orderNumber: o.orderNumber,
    recipient: { name: o.recipient?.name || "" },
    address: {
      line1: o.address?.line1 || "",
      city: o.address?.city || "",
      postcode: o.address?.postcode || ""
    },
    trackingNumber: o.trackingNumber || "",
    service: o.service || "",
    createdAt: o.createdAt
  }));
  // -------------------------------------------------------------------------
}

async function generateOrderPDF(orders, { sinceUK, nowUK }) {
  const doc = new PDFDocument({ margin: 36 }); // 0.5" margins
  const chunks = [];
  doc.on("data", c => chunks.push(c));

  // Header
  doc.fontSize(18).text(`${BRAND_NAME} — Royal Mail Orders`, { align: "center" });
  doc.moveDown(0.2);
  doc.fontSize(11).text(`Window: ${sinceUK.toFormat("dd LLL yyyy HH:mm")} → ${nowUK.toFormat("dd LLL yyyy HH:mm")} (Europe/London)`, { align: "center" });
  doc.moveDown();

  // Table headers
  doc.fontSize(12).text("Order", 36, doc.y, { continued: true, width: 100 });
  doc.text("Recipient", { continued: true, width: 160 });
  doc.text("Address", { continued: true, width: 220 });
  doc.text("Tracking / Service", { width: 160 });
  doc.moveDown(0.2);
  doc.moveTo(36, doc.y).lineTo(559, doc.y).stroke();
  doc.moveDown(0.2);

  if (!orders.length) {
    doc.moveDown().fontSize(12).text("No orders found in this window.", { align: "center" });
    doc.end();
    return Buffer.concat(chunks);
  }

  // Rows
  doc.fontSize(10);
  for (const o of orders) {
    const line1 = `${o.orderNumber || ""}`;
    const line2 = `${o.recipient?.name || ""}`;
    const addr = `${o.address?.line1 || ""}, ${o.address?.city || ""}, ${o.address?.postcode || ""}`.replace(/(^, |, ,)/g, "");
    const track = `${o.trackingNumber || "—"}\n${o.service || ""}`;

    const startY = doc.y;
    doc.text(line1, 36, startY, { width: 100, continued: true });
    doc.text(line2, { width: 160, continued: true });
    doc.text(addr, { width: 220, continued: true });
    doc.text(track, { width: 160 });
    doc.moveDown(0.4);
    doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor("#999").stroke().strokeColor("#000");
  }

  doc.end();
  return new Promise(resolve => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function sendEmail({ pdfBuffer, subject }) {
  const transporter = nodemailer.createTransport({
    host: MAIL_HOST,
    port: Number(MAIL_PORT || 587),
    secure: false,
    auth: { user: MAIL_USER, pass: MAIL_PASS }
  });

  await transporter.sendMail({
    from: `"${BRAND_NAME} Dispatch" <${MAIL_USER}>`,
    to: RECIPIENT_EMAIL,
    subject,
    text: "Attached: Click & Drop orders PDF.",
    attachments: [{ filename: "orders.pdf", content: pdfBuffer }]
  });
}

(async function run() {
  try {
    const sinceISO_utc = sinceUK.setZone("UTC").toISO();
    const orders = await fetchOrdersFromClickAndDrop(sinceISO_utc);
    const pdf = await generateOrderPDF(orders, { sinceUK, nowUK });
    const subject = `${BRAND_NAME} — Royal Mail Orders — ${nowUK.toFormat("dd LLL yyyy HH:mm")}`;
    await sendEmail({ pdfBuffer: pdf, subject });
    console.log(`Sent ${orders.length} orders. Window ${sinceUK.toISO()} -> ${nowUK.toISO()}`);
  } catch (err) {
    console.error("FAILED:", err);
    process.exitCode = 1;
  }
})();
