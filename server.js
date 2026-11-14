// PotholePatrol server
// - On your laptop: saves reports to data/reports.json (no database needed)
// - On Render: set DATABASE_URL and it saves reports in Postgres instead
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || "123456";
const DATABASE_URL = process.env.DATABASE_URL || "";

/* ---------------- Storage ---------------- */
let store;

if (DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes(".render.com") ? { rejectUnauthorized: false } : false,
  });

  const toReport = (row) => ({
    id: Number(row.id),
    before: row.before_photo,
    after: row.after_photo,
    location: row.location,
    area: row.area,
    severity: row.severity,
    details: row.details,
    status: row.status,
    created: new Date(row.created).toISOString(),
  });

  store = {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS reports (
          id BIGINT PRIMARY KEY,
          before_photo TEXT NOT NULL,
          after_photo TEXT NOT NULL DEFAULT '',
          location TEXT NOT NULL,
          area TEXT NOT NULL DEFAULT '',
          severity TEXT NOT NULL DEFAULT 'Medium',
          details TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'Reported',
          created TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    },
    async list() {
      const r = await pool.query("SELECT * FROM reports ORDER BY id DESC");
      return r.rows.map(toReport);
    },
    async add(rep) {
      await pool.query(
        `INSERT INTO reports (id, before_photo, location, area, severity, details, status, created)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [rep.id, rep.before, rep.location, rep.area, rep.severity, rep.details, rep.status, rep.created]
      );
    },
    async update(id, fields) {
      const sets = [], vals = [];
      if (fields.status !== undefined) { vals.push(fields.status); sets.push("status=$" + vals.length); }
      if (fields.after !== undefined) { vals.push(fields.after); sets.push("after_photo=$" + vals.length); }
      if (!sets.length) return true;
      vals.push(id);
      const r = await pool.query(
        "UPDATE reports SET " + sets.join(", ") + " WHERE id=$" + vals.length,
        vals
      );
      return r.rowCount > 0;
    },
  };
} else {
  const DATA_FILE = path.join(__dirname, "data", "reports.json");
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]");
  const load = () => {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
    catch (e) { return []; }
  };
  const save = (r) => fs.writeFileSync(DATA_FILE, JSON.stringify(r));

  store = {
    async init() {},
    async list() { return load(); },
    async add(rep) { const all = load(); all.unshift(rep); save(all); },
    async update(id, fields) {
      const all = load();
      const r = all.find((x) => x.id === id);
      if (!r) return false;
      if (fields.status !== undefined) r.status = fields.status;
      if (fields.after !== undefined) r.after = fields.after;
      save(all);
      return true;
    },
  };
}

/* ---------------- Helpers ---------------- */
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "", size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) { reject(new Error("Upload too large")); req.destroy(); return; }
      text += chunk;
    });
    req.on("end", () => {
      try { resolve(JSON.parse(text || "{}")); }
      catch (e) { reject(new Error("Bad request")); }
    });
  });
}

const isAdmin = (req) => req.headers["x-admin-pass"] === ADMIN_PASS;
const isImage = (s) => typeof s === "string" && s.startsWith("data:image/");
const clip = (s, n) => String(s || "").trim().slice(0, n);
const STATUSES = ["Reported", "Under review", "Team assigned", "Repaired"];
const SEVERITIES = ["Small", "Medium", "Large / dangerous"];

/* ---------------- Server ---------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  try {
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    }
    if (req.method === "GET" && url === "/admin.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(__dirname, "admin.html")));
    }

    if (req.method === "POST" && url === "/api/login") {
      const b = await readBody(req);
      return b.password === ADMIN_PASS
        ? send(res, 200, { ok: true })
        : send(res, 401, { error: "Incorrect passcode" });
    }

    if (req.method === "POST" && url === "/api/reports") {
      const b = await readBody(req);
      if (!isImage(b.before)) return send(res, 400, { error: "A photo is required" });
      if (!clip(b.location, 180)) return send(res, 400, { error: "Location is required" });

      const report = {
        id: Date.now(),
        before: b.before,
        after: "",
        location: clip(b.location, 180),
        area: clip(b.area, 100),
        severity: SEVERITIES.includes(b.severity) ? b.severity : "Medium",
        details: clip(b.details, 800),
        status: "Reported",
        created: new Date().toISOString(),
      };
      await store.add(report);
      return send(res, 201, { id: report.id });
    }

    if (req.method === "GET" && url === "/api/reports") {
      if (!isAdmin(req)) return send(res, 401, { error: "Not authorised" });
      return send(res, 200, await store.list());
    }

    const m = url.match(/^\/api\/reports\/(\d+)$/);
    if (req.method === "PATCH" && m) {
      if (!isAdmin(req)) return send(res, 401, { error: "Not authorised" });
      const b = await readBody(req);
      const fields = {};
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return send(res, 400, { error: "Bad status" });
        fields.status = b.status;
      }
      if (b.after !== undefined) {
        if (!isImage(b.after)) return send(res, 400, { error: "Bad image" });
        fields.after = b.after;
      }
      const ok = await store.update(Number(m[1]), fields);
      return ok ? send(res, 200, { ok: true }) : send(res, 404, { error: "Report not found" });
    }

    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    send(res, 400, { error: e.message || "Error" });
  }
});

store.init().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log("\nPotholePatrol is running!");
    console.log("Storage: " + (DATABASE_URL ? "Postgres database" : "local file (data/reports.json)"));
    console.log("\n  On this computer:   http://localhost:" + PORT);
    console.log("  Admin dashboard:    http://localhost:" + PORT + "/admin.html");
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list) {
        if (n.family === "IPv4" && !n.internal) {
          console.log("  Others on your Wi-Fi: http://" + n.address + ":" + PORT);
        }
      }
    }
    console.log("\nPress Ctrl+C to stop.\n");
  });
}).catch((e) => {
  console.error("Could not start (database problem?):", e.message);
  process.exit(1);
});
