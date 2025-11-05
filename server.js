import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

app.get("/", (_req,res)=>res.send("OK"));

// Shopify fulfillment webhook
app.post("/shopify-fulfillment", async (req,res)=>{
  try {
    const f = req.body;
    const order_id = String(f.order_id || f?.order?.id || "");
    const email = f?.email || f?.shipping_address?.email || f?.recipient?.email || f?.order?.email || "";
    const carrier = String(f?.tracking_company || "royalmail").toLowerCase();
    const nums = Array.isArray(f?.tracking_numbers) ? f.tracking_numbers : [];
    let saved = 0;
    for (const tracking_number of nums.filter(Boolean)) {
      await pool.query(
        `INSERT INTO shipments (order_id,email,tracking_number,carrier,status,updated_at)
         VALUES ($1,$2,$3,$4,'in_transit',now())
         ON CONFLICT (tracking_number)
         DO UPDATE SET order_id=EXCLUDED.order_id,email=EXCLUDED.email,carrier=EXCLUDED.carrier,updated_at=now()`,
        [order_id, email, tracking_number, carrier]
      );
      saved++;
    }
    res.json({ ok:true, saved });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:"fulfillment handler failed" });
  }
});

// Royal Mail delivered webhook
app.post("/royalmail-webhook", async (req,res)=>{
  try {
    const status = String(req.body?.status || "").toLowerCase();
    const tn = String(req.body?.tracking_number || "").trim();
    if (!tn) return res.status(400).json({ ok:false, error:"missing tracking_number" });
    if (status !== "delivered") return res.status(204).end();

    const { rows } = await pool.query(`SELECT * FROM shipments WHERE tracking_number=$1`, [tn]);
    if (!rows.length) return res.status(204).end();
    const row = rows[0];

    if (!row.processed_delivered) {
      const payload = {
        data: { type: "event",
          attributes: {
            metric: { name: "Order Delivered" },
            properties: { tracking_number: tn, order_id: row.order_id },
            profile: { email: row.email }
          }
        }
      };
      const r = await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Klaviyo-API-Key": process.env.KLAVIYO_PRIVATE_KEY },
        body: JSON.stringify(payload)
      });
      if (!r.ok) return res.status(502).json({ ok:false, error:"klaviyo_failed" });

      await pool.query(
        `UPDATE shipments SET status='delivered', delivered_at=now(), processed_delivered=true, updated_at=now() WHERE id=$1`,
        [row.id]
      );
    }
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:"royalmail handler failed" });
  }
});

const port = process.env.PORT || 8080;
init().then(()=>app.listen(port, ()=>console.log("Listening on", port)));
