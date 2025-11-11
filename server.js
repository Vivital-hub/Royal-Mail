// server.js — full drop-in
import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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
    CREATE INDEX IF NOT EXISTS idx_ship_not_done
      ON shipments(processed_delivered, status);
  `;
  await pool.query(sql);
  console.log("DB ready");
}

// --- Klaviyo helper (correct headers + payload shape + real errors) ---
async function sendKlaviyoDelivered(email, orderId, tracking) {
  if (!process.env.KLAVIYO_PRIVATE_KEY) {
    throw new Error("KLAVIYO_PRIVATE_KEY is not set");
  }
  if (!email) {
    throw new Error("Missing email for Klaviyo event");
  }

  const payload = {
    data: {
      type: "event",
      attributes: {
        metric: { name: "Order Delivered" },
        properties: {
          tracking_number: tracking,
          order_id: orderId,
        },
        profile: {
          data: {
            type: "profile",
            attributes: { email },
          },
        },
        time: new Date().toISOString(),
      },
    },
  };

  const r = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_KEY}`,
      revision: "2024-06-15",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();

  if (!r.ok) {
    console.error("Klaviyo error:", r.status, text);
    throw new Error(`Klaviyo ${r.status}: ${text}`);
  }

  console.log("Klaviyo event sent:", { email, orderId, tracking, text });
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

    const carrier = String(
      f?.tracking_company || "royalmail"
    ).toLowerCase();

    const nums = Array.isArray(f?.tracking_numbers)
      ? f.tracking_numbers
      : [];

    if (!order_id || !email || nums.length === 0) {
      console.warn("Incomplete fulfillment payload", {
        order_id,
        email,
        tracking_numbers: nums,
      });
    }

    let saved = 0;
    for (const tracking_number of nums.filter(Boolean)) {
      await pool.query(
        `INSERT INTO shipments (order_id, email, tracking_number, carrier, status, updated_at)
         VALUES ($1,$2,$3,$4,'in_transit',now())
         ON CONFLICT (tracking_number)
         DO UPDATE SET
           order_id = EXCLUDED.order_id,
           email = EXCLUDED.email,
           carrier = EXCLUDED.carrier,
           updated_at = now()`,
        [order_id, email, tracking_number, carrier]
      );
      saved++;
    }

    return res.json({ ok: true, saved });
  } catch (e) {
    console.error("/shopify-fulfillment error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "fulfillment handler failed" });
  }
});

// --- WEBHOOK 2: Royal Mail delivered -> send Klaviyo + mark delivered ---
app.post("/royalmail-webhook", async (req, res) => {
  try {
    const status = String(req.body?.status || "").toLowerCase();
    const tn = String(req.body?.tracking_number || "").trim();

    if (!tn) {
      return res
        .status(400)
        .json({ ok: false, error: "missing tracking_number" });
    }

    // Only act on delivered
    if (status !== "delivered") {
      console.log("Non-delivered status received, ignoring", {
        tn,
        status,
      });
      return res.status(204).end();
    }

    const { rows } = await pool.query(
      `SELECT * FROM shipments WHERE tracking_number = $1`,
      [tn]
    );

    if (!rows.length) {
      console.warn("No shipment found for tracking", tn);
      return res.status(204).end();
    }

    const row = rows[0];

    if (!row.processed_delivered) {
      await sendKlaviyoDelivered(row.email, row.order_id, tn);

      await pool.query(
        `UPDATE shipments
           SET status = 'delivered',
               delivered_at = now(),
               processed_delivered = true,
               updated_at = now()
         WHERE id = $1`,
        [row.id]
      );

      console.log("Marked delivered + processed for", tn);
    } else {
      console.log(
        "Already processed_delivered, skipping Klaviyo for",
        tn
      );
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("royalmail-webhook error:", e);
    // expose real reason to curl + logs
    return res
      .status(502)
      .json({ ok: false, error: String(e.message || e) });
  }
});

const port = process.env.PORT || 8080;

init()
  .then(() => {
    app.listen(port, () =>
      console.log("Listening on", port)
    );
  })
  .catch((e) => {
    console.error("Fatal init error", e);
    process.exit(1);
  });
