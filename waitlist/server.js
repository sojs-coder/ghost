const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false"
        ? false
        : { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.static(__dirname));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post("/api/waitlist", async (req, res) => {
    const email = (req.body?.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ error: "Invalid email" });
    }
    try {
        const result = await pool.query(
            `INSERT INTO waitlist (email)
             VALUES ($1)
             ON CONFLICT (email) DO NOTHING
             RETURNING id`,
            [email],
        );
        const countRes = await pool.query("SELECT COUNT(*)::int AS n FROM waitlist");
        res.json({
            ok: true,
            alreadyJoined: result.rowCount === 0,
            count: countRes.rows[0].n,
        });
    } catch (err) {
        console.error("waitlist insert failed", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.get("/api/waitlist/count", async (_req, res) => {
    try {
        const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM waitlist");
        res.json({ count: rows[0].n });
    } catch (err) {
        console.error("count failed", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
    console.log(`Ghost waitlist listening on :${port}`);
});
