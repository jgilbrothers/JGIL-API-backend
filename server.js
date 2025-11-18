// server.js
// J GIL Image Studio backend – SDXL-Turbo via Hugging Face Inference API
// - Enforce 20 images per month per IP (for normal users)
// - Allow unlimited images for admin IPs (configured via ADMIN_IPS env var)

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // from package.json

const app = express();
const PORT = process.env.PORT || 3000;

// Hugging Face config
const HF_API_KEY = process.env.HF_API_KEY;
const HF_MODEL_ID = process.env.HF_MODEL_ID || "stabilityai/sdxl-turbo";
const HF_API_URL =
  process.env.HF_API_URL ||
  `https://api-inference.huggingface.co/models/${HF_MODEL_ID}`;

// Usage limits
// Normal users: 20 images / month, per IP (you can tweak this later)
const MAX_IMAGES_PER_MONTH = parseInt(
  process.env.MAX_IMAGES_PER_MONTH || "20",
  10
);

// Admin IPs (comma-separated list in ADMIN_IPS env var)
// Requests from these IPs have no monthly limit (for your own testing).
function getAdminIps() {
  const raw = process.env.ADMIN_IPS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// In-memory usage store: { [ip]: countThisMonth }
let usageByIp = new Map();
let currentMonthKey = getMonthKey();

function getMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
}

function ensureUsageWindow() {
  const key = getMonthKey();
  if (key !== currentMonthKey) {
    usageByIp.clear();
    currentMonthKey = key;
  }
}

// Basic logging so we can see requests in Render logs
app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path} from ${
      getClientIp(req) || "unknown"
    }`
  );
  next();
});

// CORS: allow your website to call the backend
app.use(
  cors({
    origin: true, // you can tighten this later to "https://jgilbrothers.com"
    methods: ["GET", "POST", "OPTIONS"],
  })
);

// JSON body parsing
app.use(express.json({ limit: "2mb" }));

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    model: HF_MODEL_ID,
    limitPerIpPerMonth: MAX_IMAGES_PER_MONTH,
  });
});

// Main generation endpoint
app.post("/generate", async (req, res) => {
  ensureUsageWindow();

  const { prompt, mode, size, detail } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Prompt is required." });
  }

  if (!HF_API_KEY) {
    return res.status(500).json({
      error:
        "HF_API_KEY is not configured on the server. Please set it in Render environment variables.",
    });
  }

  const clientIp = getClientIp(req);
  const adminIps = getAdminIps();
  const isAdmin = adminIps.includes(clientIp);

  let usageInfo;

  if (!isAdmin) {
    const previous = usageByIp.get(clientIp) || 0;

    if (previous >= MAX_IMAGES_PER_MONTH) {
      usageInfo = {
        period: "per_ip_month",
        limit: MAX_IMAGES_PER_MONTH,
        used: previous,
        remaining: 0,
      };
      return res.status(429).json({
        error:
          "Monthly image limit reached for this device / connection. Try again next month or upgrade access.",
        usage: usageInfo,
      });
    }

    const used = previous + 1;
    const remaining = Math.max(MAX_IMAGES_PER_MONTH - used, 0);
    usageByIp.set(clientIp, used);

    usageInfo = {
      period: "per_ip_month",
      limit: MAX_IMAGES_PER_MONTH,
      used,
      remaining,
    };
  } else {
    // Admin IP – no monthly limit
    usageInfo = {
      period: "admin_unlimited",
    };
  }

  try {
    const hfResponse = await fetch(HF_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: buildHuggingFaceParams({ mode, size, detail }),
        options: {
          wait_for_model: true,
        },
      }),
    });

    if (!hfResponse.ok) {
      const errText = await hfResponse.text();
      console.error("Hugging Face error:", hfResponse.status, errText);
      return res.status(502).json({
        error: "Image generation failed upstream.",
        detail: errText.slice(0, 500),
        usage: usageInfo,
      });
    }

    const arrayBuffer = await hfResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const dataUrl = `data:image/png;base64,${base64}`;

    return res.json({
      image: dataUrl,
      usage: usageInfo,
    });
  } catch (err) {
    console.error("Error calling Hugging Face:", err);
    return res.status(500).json({
      error: "Server error while generating image.",
      usage: usageInfo,
    });
  }
});

// Helper: build SDXL-Turbo parameters from UI choices
function buildHuggingFaceParams({ mode, size, detail }) {
  const params = {};

  const d = (detail || "").toLowerCase();
  if (d.includes("fast")) {
    params.num_inference_steps = 2;
    params.guidance_scale = 0.0;
  } else if (d.includes("high")) {
    params.num_inference_steps = 6;
    params.guidance_scale = 2.5;
  } else {
    // balanced
    params.num_inference_steps = 4;
    params.guidance_scale = 1.0;
  }

  const s = (size || "").toLowerCase();
  let width = 1024;
  let height = 1024;

  if (s === "portrait") {
    width = 768;
    height = 1024;
  } else if (s === "landscape") {
    width = 1024;
    height = 768;
  }

  params.width = width;
  params.height = height;

  if (mode === "brand") {
    params.guidance_scale = (params.guidance_scale || 1.0) + 0.5;
  }

  return params;
}

// Helper: extract client IP (Render will usually set x-forwarded-for)
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    return xf.split(",")[0].trim();
  }
  if (Array.isArray(xf) && xf.length > 0) {
    return xf[0].split(",")[0].trim();
  }
  return (
    req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    "unknown"
  );
}

// Start server
app.listen(PORT, () => {
  console.log(`J GIL Image Studio backend listening on port ${PORT}`);
  console.log(`Model: ${HF_MODEL_ID}`);
});
