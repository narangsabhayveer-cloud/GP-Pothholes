
// A Hole Lot Cleaner - server
// The server does three jobs:
//   1. Sends the web pages to the browser
//   2. Saves and loads pothole reports (the "API")
//   3. Checks the admin password for admin-only actions

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || "AHOLELOTCLEANER123";
const DATABASE_URL = process.env.DATABASE_URL;

const STATUSES = ["Reported", "Under review", "Team assigned", "Repaired"];
const SEVERITIES = ["Small", "Medium", "Large / dangerous"];

// Counts every homepage request
let dailyVisitors = 0;

/* ------------------------------------------------------------------
   DAILY VISIT REPORT
   Prints the total once at midnight (IST)
------------------------------------------------------------------- */

function getISTDate() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
}

function scheduleDailyReport() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(p => [p.type, p.value])
  );

  const secondsPassed =
    Number(parts.hour) * 3600 +
    Number(parts.minute) * 60 +
    Number(parts.second);

  const millisecondsUntilMidnight =
    (86400 - secondsPassed) * 1000 - now.getMilliseconds();

  setTimeout(() => {
    console.log(
      `[DAILY REPORT] date=${getISTDate()} total_visits=${dailyVisitors}`
    );

    dailyVisitors = 0;
    scheduleDailyReport();
  }, millisecondsUntilMidnight);
}

scheduleDailyReport();

/* ------------------------------------------------------------------
   STORAGE
------------------------------------------------------------------- */

let db;

if (DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes(".render.com")
      ? { rejectUnauthorized: false }
      : false,
  });

  db = {
    async setup() {
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
      await pool.query(
        "ALTER TABLE reports ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''"
      );
    },
    async getAll() {
      const result = await pool.query("SELECT * FROM reports ORDER BY id DESC");
      return result.rows.map((row) => ({
        id: Number(row.id),
        before: row.before_photo,
        after: row.after_photo,
        location: row.location,
        area: row.area,
        phone: row.phone,
        severity: row.severity,
        details: row.details,
        status: row.status,
        created: row.created,
      }));
    },
    async add(r) {
      await pool.query(
        `INSERT INTO reports (id, before_photo, location, area, phone, severity, details, status, created)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.id, r.before, r.location, r.area, r.phone, r.severity, r.details, r.status, r.created]
      );
    },
    async update(id, status, after) {
      const result = await pool.query(
        "UPDATE reports SET status = COALESCE($1, status), after_photo = COALESCE($2, after_photo) WHERE id = $3",
        [status, after, id]
      );
      return result.rowCount > 0;
    },
    async remove(id) {
      const result = await pool.query("DELETE FROM reports WHERE id = $1", [id]);
      return result.rowCount > 0;
    },
  };
} else {
  const FILE = path.join(__dirname, "data", "reports.json");
  fs.mkdirSync(path.dirname(FILE), { recursive: true });

  const readList = () =>
    fs.existsSync(FILE)
      ? JSON.parse(fs.readFileSync(FILE, "utf8"))
      : [];

  const writeList = (list) =>
    fs.writeFileSync(FILE, JSON.stringify(list));

  db = {
    async setup() {},
    async getAll() {
      return readList();
    },
    async add(r) {
      const list = readList();
      list.unshift(r);
      writeList(list);
    },
    async update(id, status, after) {
      const list = readList();
      const r = list.find((x) => x.id === id);
      if (!r) return false;
      if (status) r.status = status;
      if (after) r.after = after;
      writeList(list);
      return true;
    },
    async remove(id) {
      const list = readList();
      const remaining = list.filter((x) => x.id !== id);
      writeList(remaining);
      return remaining.length !== list.length;
    },
  };
}

/* ------------------------------------------------------------------
   HELPERS
------------------------------------------------------------------- */

function reply(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 12 * 1024 * 1024)
        reject(new Error("Upload too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(text || "{}"));
      } catch {
        reject(new Error("Bad request"));
      }
    });
  });
}

const isAdmin = (req) => req.headers["x-admin-pass"] === ADMIN_PASS;
const isImage = (text) =>
  typeof text === "string" && text.startsWith("data:image/");
const clean = (text, maxLength) =>
  String(text || "").trim().slice(0, maxLength);

const PAGES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/admin.html": "admin.html",
  "/style.css": "style.css",
  "/common.js": "common.js",
};

const FILE_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
};

/* ------------------------------------------------------------------
   THE SERVER
------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // Count EVERY homepage request, even repeated requests from the same IP
  const isPageView =
    req.method === "GET" &&
    (url === "/" || url === "/index.html");

  if (isPageView) {
    dailyVisitors++;
  }

  try {
    // 1. Web pages
    if (req.method === "GET" && PAGES[url]) {
      const file = PAGES[url];
      res.writeHead(200, {
        "Content-Type": FILE_TYPES[path.extname(file)],
      });
      return res.end(fs.readFileSync(path.join(__dirname, file)));
    }

    // 2. Admin login check
    if (req.method === "POST" && url === "/api/login") {
      const body = await readBody(req);
      if (body.password === ADMIN_PASS)
        return reply(res, 200, { ok: true });
      return reply(res, 401, { error: "Incorrect passcode" });
    }

    // 3. Anyone can submit a report
    if (req.method === "POST" && url === "/api/reports") {
      const body = await readBody(req);
      const phone = clean(body.phone, 20);

      if (!isImage(body.before))
        return reply(res, 400, { error: "A photo is required" });
      if (!clean(body.location, 180))
        return reply(res, 400, { error: "Location is required" });
      if (!/^[0-9 +()-]{7,20}$/.test(phone))
        return reply(res, 400, { error: "A valid phone number is required" });

      const report = {
        id: Date.now(),
        before: body.before,
        after: "",
        location: clean(body.location, 180),
        area: clean(body.area, 100),
        phone: phone,
        severity: SEVERITIES.includes(body.severity)
          ? body.severity
          : "Medium",
        details: clean(body.details, 800),
        status: "Reported",
        created: new Date().toISOString(),
      };

      await db.add(report);
      return reply(res, 201, { id: report.id });
    }

    // Everything below this line is admin-only
    const isReportsUrl =
      url === "/api/reports" || /^\/api\/reports\/\d+$/.test(url);

    if (isReportsUrl && !isAdmin(req))
      return reply(res, 401, { error: "Not authorised" });

    // 4. Admin: see all reports
    if (req.method === "GET" && url === "/api/reports") {
      return reply(res, 200, await db.getAll());
    }

    // 5. Admin: change status / add after photo, or delete
    const match = url.match(/^\/api\/reports\/(\d+)$/);

    if (match) {
      const id = Number(match[1]);

      if (req.method === "PATCH") {
        const body = await readBody(req);

        if (body.status && !STATUSES.includes(body.status))
          return reply(res, 400, { error: "Bad status" });

        if (body.after && !isImage(body.after))
          return reply(res, 400, { error: "Bad image" });

        const found = await db.update(
          id,
          body.status || null,
          body.after || null
        );

        return found
          ? reply(res, 200, { ok: true })
          : reply(res, 404, { error: "Report not found" });
      }

      if (req.method === "DELETE") {
        const found = await db.remove(id);

        return found
          ? reply(res, 200, { ok: true })
          : reply(res, 404, { error: "Report not found" });
      }
    }

    reply(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    reply(res, 400, { error: error.message });
  }
});

db.setup()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        "A Hole Lot Cleaner is running on http://localhost:" + PORT
      );
      console.log(
        "Storage: " +
          (DATABASE_URL ? "Postgres" : "local file (data/reports.json)")
      );
    });
  })
  .catch((error) => {
    console.error("Could not start:", error.message);
    process.exit(1);
  });

 
