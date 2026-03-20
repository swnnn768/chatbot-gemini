import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const app = express();
const port = Number(process.env.PORT) || 3000;
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const sessionSecret = process.env.SESSION_SECRET;

if (!apiKey) {
  console.error("Erreur : GEMINI_API_KEY est manquante dans .env");
  process.exit(1);
}

if (!sessionSecret || sessionSecret.length < 32) {
  console.error("Erreur : SESSION_SECRET doit faire au moins 32 caractères.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");

async function ensureDb() {
  await mkdir(dataDir, { recursive: true });

  try {
    await readFile(dbPath, "utf8");
  } catch {
    const initialDb = {
      users: [],
    };
    await writeFile(dbPath, JSON.stringify(initialDb, null, 2), "utf8");
  }
}

async function readDb() {
  const raw = await readFile(dbPath, "utf8");
  const parsed = JSON.parse(raw);

  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
  };
}

async function writeDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(derivedKey).toString("hex")}`;
}

async function verifyPassword(password, storedValue) {
  try {
    const [salt, storedHashHex] = String(storedValue).split(":");
    if (!salt || !storedHashHex) return false;

    const derivedKey = await scrypt(password, salt, 64);
    const storedHash = Buffer.from(storedHashHex, "hex");
    const candidateHash = Buffer.from(derivedKey);

    if (storedHash.length !== candidateHash.length) return false;

    return timingSafeEqual(storedHash, candidateHash);
  } catch {
    return false;
  }
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.role === "string" &&
        typeof item.content === "string" &&
        ["user", "assistant"].includes(item.role)
    )
    .map((item) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: item.content.trim().slice(0, 2500) }],
    }))
    .filter((item) => item.parts[0].text.length > 0)
    .slice(-12);
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(express.json({ limit: "1mb" }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Trop de requêtes. Réessaie dans quelques minutes.",
    },
  })
);

app.use(
  session({
    name: "nova.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    provider: "Gemini",
    model,
  });
});

app.get("/api/auth/me", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({ authenticated: false, user: null });
    }

    const db = await readDb();
    const user = db.users.find((u) => u.id === req.session.userId);

    if (!user) {
      await destroySession(req).catch(() => {});
      return res.json({ authenticated: false, user: null });
    }

    res.json({
      authenticated: true,
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error("Erreur /api/auth/me :", error);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (name.length < 2 || name.length > 60) {
      return res.status(400).json({ error: "Nom invalide." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Email invalide." });
    }

    if (password.length < 8 || password.length > 100) {
      return res.status(400).json({
        error: "Le mot de passe doit contenir au moins 8 caractères.",
      });
    }

    const db = await readDb();
    const alreadyExists = db.users.some((u) => u.email === email);

    if (alreadyExists) {
      return res.status(409).json({
        error: "Un compte existe déjà avec cet email.",
      });
    }

    const passwordHash = await hashPassword(password);

    const newUser = {
      id: randomUUID(),
      name,
      email,
      passwordHash,
      createdAt: new Date().toISOString(),
    };

    db.users.push(newUser);
    await writeDb(db);

    await regenerateSession(req);
    req.session.userId = newUser.id;

    res.status(201).json({
      message: "Compte créé avec succès.",
      user: sanitizeUser(newUser),
    });
  } catch (error) {
    console.error("Erreur register :", error);
    res.status(500).json({
      error: "Erreur serveur pendant l'inscription.",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ error: "Identifiants invalides." });
    }

    const db = await readDb();
    const user = db.users.find((u) => u.email === email);

    if (!user) {
      return res.status(401).json({
        error: "Email ou mot de passe incorrect.",
      });
    }

    const isValid = await verifyPassword(password, user.passwordHash);

    if (!isValid) {
      return res.status(401).json({
        error: "Email ou mot de passe incorrect.",
      });
    }

    await regenerateSession(req);
    req.session.userId = user.id;

    res.json({
      message: "Connexion réussie.",
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error("Erreur login :", error);
    res.status(500).json({
      error: "Erreur serveur pendant la connexion.",
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    await destroySession(req);
    res.clearCookie("nova.sid");
    res.json({ message: "Déconnexion réussie." });
  } catch (error) {
    console.error("Erreur logout :", error);
    res.status(500).json({
      error: "Impossible de se déconnecter.",
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const message =
      typeof req.body.message === "string" ? req.body.message.trim() : "";
    const history = cleanHistory(req.body.history);

    if (!message) {
      return res.status(400).json({ error: "Le message est vide." });
    }

    if (message.length > 3000) {
      return res.status(400).json({
        error: "Le message est trop long (3000 caractères max).",
      });
    }

    let userName = null;

    if (req.session.userId) {
      const db = await readDb();
      const user = db.users.find((u) => u.id === req.session.userId);
      if (user) userName = user.name;
    }

    const contents = [
      ...history,
      {
        role: "user",
        parts: [{ text: message }],
      },
    ];

    const systemInstruction = `
Tu es Nova Assistant, un assistant premium, professionnel et moderne.

Règles :
- Réponds toujours en français, sauf si l'utilisateur écrit dans une autre langue.
- Adopte un ton clair, fluide, sérieux et naturel.
- Structure les réponses de façon lisible et élégante.
- Donne des réponses précises, utiles et concrètes.
- N'invente jamais d'informations.
- Si une information est incertaine, dis-le honnêtement.
- Quand l'utilisateur demande du code, fournis un code propre, moderne, complet et prêt à l'emploi.
- Quand l'utilisateur demande une explication, sois pédagogique sans être lourd.
- Garde une présentation professionnelle et agréable à lire.
${userName ? `L'utilisateur connecté s'appelle ${userName}.` : ""}
`.trim();
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction,
      },
    });

    const reply = response.text?.trim();

    if (!reply) {
      return res.status(502).json({
        error: "Aucune réponse exploitable n'a été générée.",
      });
    }

    res.json({ reply });
  } catch (error) {
    console.error("Erreur Gemini :", error);
    res.status(500).json({
      error: "Erreur serveur pendant l'appel à Gemini.",
    });
  }
});

async function start() {
  await ensureDb();

  app.listen(port, () => {
    console.log(`Serveur lancé sur http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Impossible de démarrer le serveur :", error);
  process.exit(1);
});