// Runs: fetch orders -> make PDF -> send via Microsoft Graph (no SMTP needed)

import { DateTime } from "luxon";
import PDFDocument from "pdfkit";

// ---------- Config via ENV ----------
const {
  // Royal Mail / Click & Drop API
  RM_API_BASE,            // e.g. https://api.parcel.royalmail.com
  RM_API_TOKEN,           // Bearer token for Click & Drop

  // Email (Graph)
  MS_TENANT_ID,           // Entra tenant ID
  MS_CLIENT_ID,           // App (client) ID
  MS_CLIENT_SECRET,       // Client secret
  MAIL_FROM,              // licensed mailbox to send from (e.g. dispatch@yourdomain.co.uk)
  RECIPIENT_EMAIL,        // where to send the PDF

  BRAND_NAME = "Vivital",

  // Utility
  SIMULATE = "0",         // "1" to use fake orders (no RM API call)
  SINCE_HOURS = "24",     // pull last 24 hours by default
  ORDER_REF_PREFIX        // e.g. "VIV-" to filter only Vivital orders
} = process.env;

// Optional: accept a CLI --since=ISO override (useful for manual tests)
const sinceArg = process.argv.find(a => a.startsWith("--since="));
const sinceISO = sinceArg ? sinceArg.split("=")[1] : null;

// Europe/London time for subject/timestamps
const nowUK = DateTime.now().setZone("Europe/London");
const sinceUK = sinceISO
  ? DateTime.fromISO(sinceISO).setZone("Europe/London")
  : nowUK.minus({ hours: Number(SINCE_HOURS) });

// ---------------- FETCH ORDERS ----------------
async function fetchOrdersFromClickAndDrop(sinceISO) {
  if (SIMULATE === "1") {
    // Fake data for testing without API
    return [
      {
        orderNumber: "VIV-10001",
        orderReference: "VIV-10001",
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
        orderNumber: "JD-20001",
        orderReference: "JD-20001",
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

  // Normalize to standard shape
  return (data.orders || []).map(o => ({
    orderNumber: o.orderNumber,
    orderReference: o.orderReference ?? o.orderNumber,
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
}

// ---------------- PDF GENERATOR ----------------
async function generateOrderPDF(orders, { sinceUK, nowUK }) {
  const doc = new PDFDocument({ margin: 36 }); // 0.5" margins
  const chunks = [];
  doc.on("data", c => chunks.push(c));

  // Header
  doc.fontSize(18).text(`${BRAND_NAME} — Royal Mail Orders`, { align: "center" });
  doc.moveDown(0.2);
  doc.fontSize(11).text(
    `Window: ${sinceUK.toFormat("dd LLL yyyy HH:mm")} → ${nowUK.toFormat("dd LLL yyyy HH:mm")} (Europe/London)`,
    { align: "center" }
  );
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

// ---------------- GRAPH EMAIL (no SMTP) ----------------
async function sendEmailViaGraph({ pdfBuffer, subject }) {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM, RECIPIENT_EMAIL } = process.env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET || !MAIL_FROM || !RECIPIENT_EMAIL) {
    throw new Error("Missing Graph email env vars (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM, RECIPIENT_EMAIL)");
  }

  // 1) Get access token
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

  // 2) Build email with PDF attachment
  const base64PDF = pdfBuffer.toString("base64");
  const message = {
    message: {
      subject,
      from: { emailAddress: { address: MAIL_FROM } },
      toRecipients: [{ emailAddress: { address: RECIPIENT_EMAIL } }],
      body: { contentType: "Text", content: "Attached: Click & Drop orders PDF." },
      attachments: [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "orders.pdf",
          contentBytes: base64PDF
        }
      ]
    },
    saveToSentItems: "false"
  };

  // 3) Send
  const sendRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_FROM)}/sendMail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    throw new Error(`Graph sendMail failed: ${sendRes.status} ${errText}`);
  }
}

// ---------------- MAIN ----------------
(async function run() {
  try {
    const sinceISO_utc = sinceUK.setZone("UTC").toISO();
    const orders = await fetchOrdersFromClickAndDrop(sinceISO_utc);

    // --- Vivital-only filter (prefix like "VIV-") ---
    const prefix = (ORDER_REF_PREFIX || "").trim();
    const filtered = prefix
      ? orders.filter(o => {
          const ref = (o.orderReference || o.orderNumber || "").toString();
          return ref.startsWith(prefix);
        })
      : orders;

    const pdf = await generateOrderPDF(filtered, { sinceUK, nowUK });
    const subject = `${BRAND_NAME} — Royal Mail Orders — ${nowUK.toFormat("dd LLL yyyy HH:mm")}`;

    await sendEmailViaGraph({ pdfBuffer: pdf, subject });

    console.log(
      `Sent ${filtered.length} orders (from ${orders.length} total). Window ${sinceUK.toISO()} -> ${nowUK.toISO()} Prefix=${prefix || "(none)"}`
    );
  } catch (err) {
    console.error("FAILED:", err);
    process.exitCode = 1;
  }
})();
