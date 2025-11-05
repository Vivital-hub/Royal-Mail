// server.js — full drop-in
import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
const { Pool } = pg;

// If you’re using the External DB URL and hit SSL issues, uncomment next line:
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Create table on boot ---
async function init() {
  const sql = `
    CREATE TABLE IF NOT EXISTS shipments (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      email TEXT NOT NULL,
      tracking_number TEXT NOT NULL UNIQUE,
      carrier TEXT NOT NULL,
      status TEXT DEFAULT 'in_transit',
      delivered_at TIMESTAMPTZ,
      processed_delivered BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ship_not_done ON shipments(processed_delivered, status);
  `;
  await pool.query(sql);
  console.log("DB ready");
}

// --- Klaviyo helper (correct headers + payload shape) ---
async function sendKlaviyoDelivered(email, orderId, tracking) {
  const payload = {
    data: {
      type: "event",
      attributes: {
        metric: { name: "Order Delivered" },
        properties: { tracking_number: tracking, order_id: orderId },
        profile: { data: { type: "profile", attributes: { email } } },
        time: new Date().toISOString()
      }
    }
  };

  const r = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_KEY}`,
      revision: "2024-06-15",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Klaviyo ${r.status}: ${text}`);
  }
}

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// Health
app.get("/", (_req, res) => res.send("OK"));

// --- WEBHOOK 1: Shopify fulfillment -> save tracking numbers ---
app.post("/shopify-fulfillment", async (req, res) => {
  try {
    const f = req.body;

    const order_id = String(f.order_id || f?.order?.id || "");
    const email =
      f?.email ||
      f?.shipping_address?.email ||
      f?.recipient?.email ||
      f?.order?.email ||
      "";
    const carrier = String(f?.tracking_company || "royalmail").toLowerCase();
    const nums = Array.isArray(f?.tracking_numbers) ? f.tracking_numbers : [];

    let saved = 0;
    for (const tracking_number of nums.filter(Boolean)) {
      await pool.query(
        `INSERT INTO shipments (order_id,email,tracking_number,carrier,status,updated_at)
         VALUES ($1,$2,$3,$4,'in_transit',now())
         ON CONFLICT (tracking_number)
         DO UPDATE SET order_id=EXCLUDED.order_id,
                       email=EXCLUDED.email,
                       carrier=EXCLUDED.carrier,
                       updated_at=now()`,
        [order_id, email, tracking_number, carrier]
      );
      saved++;
    }
    res.json({ ok: true, saved });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "fulfillment handler failed" });
  }
});

// --- WEBHOOK 2: Royal Mail delivered -> send Klaviyo + mark delivered ---
app.post("/royalmail-webhook", async (req, res) => {
  try {
    const status = String(req.body?.status || "").toLowerCase();
    const tn = String(req.body?.tracking_number || "").trim();
    if (!tn) return res.status(400).json({ ok: false, error: "missing tracking_number" });
    if (status !== "delivered") return res.status(204).end();

    const { rows } = await pool.query(
      `SELECT * FROM shipments WHERE tracking_number=$1`,
      [tn]
    );
    if (!rows.length) return res.status(204).end();
    const row = rows[0];

    if (!row.processed_delivered) {
      await sendKlaviyoDelivered(row.email, row.order_id, tn);
      await pool.query(
        `UPDATE shipments
           SET status='delivered',
               delivered_at=now(),
               processed_delivered=true,
               updated_at=now()
         WHERE id=$1`,
        [row.id]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "royalmail handler failed" });
  }
});

const port = process.env.PORT || 8080;
init().then(() => app.listen(port, () => console.log("Listening on", port)));
