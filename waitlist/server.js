const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");

const app = express();
const port = process.env.PORT || 3000;

app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));
app.disable("x-powered-by");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false"
        ? false
        : { rejectUnauthorized: false },
});

app.use(express.json({ limit: "2kb" }));
app.use(express.static(__dirname));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;

const signupLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Try again later." },
});

const countLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests." },
});

app.post("/api/waitlist", signupLimiter, async (req, res) => {
    if (req.body?.website) {
        // Honeypot field — silently accept
        return res.json({ ok: true, alreadyJoined: true });
    }
    const raw = typeof req.body?.email === "string" ? req.body.email : "";
    const email = raw.trim().toLowerCase();
    if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: "Invalid email" });
    }
    try {
        const result = await pool.query(
            `INSERT INTO waitlist (email, ip)
             VALUES ($1, $2)
             ON CONFLICT (email) DO NOTHING
             RETURNING id`,
            [email, req.ip || null],
        );
        const countRes = await pool.query(
            "SELECT COUNT(*)::int AS n FROM waitlist",
        );
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

app.get("/api/waitlist/count", countLimiter, async (_req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT COUNT(*)::int AS n FROM waitlist",
        );
        res.set("Cache-Control", "public, max-age=30");
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
