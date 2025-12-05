// middleware/frontblock.js
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { getReqClientIP } from "../utils.js"; // adapt to your utils location

// ESM-compatible dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to blacklist JSON file
const blacklistPath = path.join(__dirname, 'blacklist.json');

// -------------------- blacklist helpers --------------------
function loadBlacklist() {
  try {
    if (!fs.existsSync(blacklistPath)) {
      fs.writeFileSync(blacklistPath, '[]', 'utf8');
      return [];
    }
    const content = fs.readFileSync(blacklistPath, 'utf8').trim();
    if (!content) {
      fs.writeFileSync(blacklistPath, '[]', 'utf8');
      return [];
    }
    return JSON.parse(content);
  } catch (e) {
    console.error('Error reading blacklist file:', e);
    try { fs.writeFileSync(blacklistPath, '[]', 'utf8'); } catch (_) {}
    return [];
  }
}

function saveBlacklist(list) {
  try {
    fs.writeFileSync(blacklistPath, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing blacklist file:', e);
  }
}

// initialize (in-memory)
let blacklist = loadBlacklist();

// -------------------- middleware export --------------------
export function blacklistMiddleware(req, res, next) {
  // Only apply blacklist for GET requests
  if (req.method !== 'GET') {
    return next();
  }

  const ip = getReqClientIP(req);
  const ua = req.headers['user-agent'] || 'unknown_ua';

  const found = blacklist.find(entry => {
  if (entry.type === "auto_ip") {
    return entry.ip === ip;
  }
  if (entry.type === "manual_ip_ua") {
    return entry.ip === ip && entry.userAgent === ua;
  }
  return false;
});

  if (found) {
    console.warn(`[Bot Blocked] ${ip} (${ua})`);
    return res.status(403).json({ error: 'Access denied: bot detected' });
  }

  next();
}



export function removeFromBlacklist(userId) {
  try {
    // Remove only the specific user's entry
    blacklist = blacklist.filter(entry => entry.userId !== userId);

    saveBlacklist(blacklist);

    console.log(`[Blacklist] Removed userId: ${userId}`);
    return true;
  } catch (err) {
    console.error("Error removing from blacklist:", err);
    return false;
  }
}

export function addToBlacklist(ip, ua, userId) {
  try {
    // Prevent duplicate same-user block
    const exists = blacklist.some(
      e =>
        e.userId === userId &&
        e.ip === ip &&
        e.userAgent === ua
    );

    if (exists) {
      console.log(`[Blacklist] Already exists for userId ${userId}`);
      return false;
    }

    const entry = {
      type: "manual_ip_ua_user",
      userId,
      ip,
      userAgent: ua,
      timestamp: new Date().toISOString()
    };

    blacklist.push(entry);
    saveBlacklist(blacklist);

    console.log(`[Blacklist] Added userId ${userId} (IP: ${ip}, UA: ${ua})`);
    return true;
  } catch (err) {
    console.error("Error adding manual block:", err);
    return false;
  }
}

// -------------------- router factory (inject db + io) --------------------
export function createBotRouter(db /* sqlite handle */, io /* socket.io server, optional */) {
  const router = express.Router();

  // POST /bot-events
  router.post('/bot-events', async (req, res) => {
    const payload = req.body || {};
    const ip = getReqClientIP(req);
    const ua = req.headers['user-agent'] || 'unknown_ua';
    
    // Update user status in DB if payload includes user id (preferred)
    const userId = payload.userId || payload.user_id || payload.userid || null;


    // detect suspicious events (your logic)
    const suspicious = Array.isArray(payload.events)
      ? payload.events.some(
          (ev) =>
            ev.t === 'fast_form_submit_flag' ||
            ev.t === 'fast_scroll' ||
            (ev.t === 'mouse_summary' && ev.payload?.linearityScore > 0.9)
        )
      : false;

    if (suspicious) {
      try {
        const exists = blacklist.some(
          (entry) => entry.ip === ip && entry.userAgent === ua
        );

        if (!exists) {
          const entry = {
            type: "auto_ip",
            userId,
            ip,
            userAgent: ua,
            fingerprint: payload.fingerprint || null,
            timestamp: new Date().toISOString(),
          };

          // add to in-memory blacklist and persist
          blacklist.push(entry);
          saveBlacklist(blacklist);
          console.log(`[Bot Detection] Added to blacklist: ${ip} — ${ua}`);

          
          if (db) {
			  if (userId) {
			    try {
			      await db.run(
			        "UPDATE users SET status = 'blocked' WHERE id = ?",
			        [userId]
			      );
			      console.log(`[Bot Detection] Marked user ${userId} as blocked in DB`);
			    } catch (err) {
			      console.error("Failed to update user status in DB:", err);
			    }
			  } else {
			    // Fallback: find user by IP
			    try {
			      const row = await db.get("SELECT id FROM users WHERE ip = ? LIMIT 1", [ip]);
			      if (row?.id) {
			        await db.run(
			          "UPDATE users SET status = 'blocked' WHERE id = ?",
			          [row.id]
			        );
			        console.log(`[Bot Detection] Marked user ${row.id} as blocked by IP`);
			      }
			    } catch (err) {
			      console.error("Failed to update user status to blocked by IP:", err);
			    }
			  }
			}

          // Optionally notify admins in real-time via socket.io if provided
          if (io) {
            try {
            	
              io.emit("admin:blacklistAdded", { ip: ip, status: "blocked", userId });
              console.log("emited admin blacklist");
            } catch (err) {
              console.warn("Failed to emit admin:blacklistAdded:", err);
            }
          }
        } // end !exists
      } catch (err) {
        console.error("Error handling suspicious event:", err);
      }
    } // end suspicious

    // Always respond 204 (no content) quickly
    return res.status(204).end();
  });

  // Admin endpoints (session-protected should be enforced at higher layer or here)
  router.get('/admin/blacklist', async (req, res) => {
    // requireAdmin or session check could be used here; keep simple:
    if (!req.session?.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    
    return res.json({ count: blacklist.length, entries: blacklist });
  });

  router.delete('/admin/blacklist', async (req, res) => {
    if (!req.session?.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    blacklist = [];
    saveBlacklist(blacklist);
    try {
		  const result = await db.run(
		    `UPDATE users
		     SET status = 'offline'
		     WHERE status = 'blocked'`
		  );
		
		  console.log(`✅ Updated ${result.changes} blocked users to offline`);
		} catch (err) {
		  console.error("❌ Error updating blocked users:", err);
		}
    console.log('[Admin] Blacklist cleared');
    return res.json({ message: 'Blacklist cleared successfully' });
  });
  
  router.post("/unblock", async (req, res) => {
  const { userId } = req.body;

  try {
    const user = await db.get(
      "SELECT ip, userAgent FROM users WHERE id = ?",
      [userId]
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Update user status
    await db.run("UPDATE users SET status = 'offline' WHERE id = ?", [userId]);

    // Remove *only this user* from blacklist
    removeFromBlacklist(userId);

    console.log(`✅ Unblocked user ${userId}`);
    res.json({ success: true });

  } catch (err) {
    console.error("Failed to unblock user:", err);
    res.status(500).json({ error: "Failed to unblock user" });
  }
});

router.post("/block", async (req, res) => {
  try {
    const { userId } = req.body;

    const ip = getReqClientIP(req);
    const ua = req.headers['user-agent'] || 'unknown_ua';

    // Update user status
    await db.run("UPDATE users SET status = 'blocked' WHERE id = ?", [userId]);

    console.log("about to add to blacklist");

    // Add to blacklist with userId
    addToBlacklist(ip, ua, userId);

    console.log(`🚫 Blocked user ${userId}`);
    res.json({ success: true });

  } catch (err) {
    console.error("Failed to block user:", err);
    res.status(500).json({ error: "Failed to block user" });
  }
});

  return router;
} 
