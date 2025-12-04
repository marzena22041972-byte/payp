import express from "express";
import Cap from "@cap.js/server";

export const cap = new Cap({
  difficulty: 4,  // optional
  expires: 5 * 60 * 1000, // 5 min
});

const router = express.Router();

// ✅ Create challenge
router.post("/challenge", async (req, res) => {
  try {
    const challenge = await cap.createChallenge();
    res.json(challenge);
  } catch (err) {
    console.error("CAPTCHA generation error:", err);
    res.status(500).json({ error: "Failed to create challenge" });
  }
});

// ✅ Redeem challenge
router.post("/redeem", async (req, res) => {
  try {
    const { token, solutions } = req.body;
    if (!token || !solutions) {
      return res.status(400).json({ success: false, error: "Missing token or solutions" });
    }

    const result = await cap.redeemChallenge({ token, solutions });

    if (result.success) {
      req.session.capVerified = true; // Mark user as verified
    }

    res.json(result);
  } catch (err) {
    console.error("CAPTCHA verification error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/verify", async (req, res) => {
	
  try {
    if (req.session.capVerified) {
       return res.json({ verified: true });
    } else {
      return res.status(400).json({ verified: false });
    }
  } catch (err) {
    console.error("CAP redeem error:", err);
    res.status(500).json({ error: err.message });
  }
});

export function requireCap(req, res, next) {
  if (req.session?.capVerified) return next();
  res.sendFile("capcheck.html", { root: "views/user" });
}

export default router;