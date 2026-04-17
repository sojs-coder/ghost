const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL not set");
        process.exit(1);
    }
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === "false"
            ? false
            : { rejectUnauthorized: false },
    });
    const dir = path.join(__dirname, "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
        const sql = fs.readFileSync(path.join(dir, f), "utf8");
        console.log(`→ ${f}`);
        await pool.query(sql);
    }
    await pool.end();
    console.log("migrations complete");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
