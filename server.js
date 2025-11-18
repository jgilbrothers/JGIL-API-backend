// server.js
// J GIL Image Studio backend – SDXL-Turbo via Hugging Face Inference API
// Enforces 10 images per user per month (in-memory, per-IP).

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT: set this in Render as an environment variable
const HF_TOKEN = process.env.HF_TOKEN;

// Max images each user (IP) can generate per calendar month
const MAX_IMAGES_PER_MONTH = parseInt(process.env.MAX_IMAGES_PER_MONTH || "10", 10);

// In-memory usage store: { [userKey]: { monthKey: "YYYY-M", count: number } }
const usageByUser = {};

// Basic safety check
if (!HF_TOKEN) {
  console.warn(
    "WARNING: HF_TOKEN environment variable is not set. The API will not work until this is configured in Render."
  );
}

app.use(
  cors({
    origin: true, // allow your site + local testing
    credentials: false
  })
);
app.use(express.json({ limit: "1mb" }));

/**
 * Get a user identifier.
 * For now we use IP address. Later you can swap this for user ID / email.
 */
function getUserKey(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

/**
 * Get or reset usage for this user for the current calendar month.
 */
function getUserUsage(userKey) {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth()}`; // e.g., "2025-10"

  const existing = usageByUser[userKey];
  if (!existing || existing.monthKey !== monthKey) {
    usageByUser[userKey] = { monthKey, count: 0 };
  }
  return usageByUser[userKey];
}

/**
 * Main generate endpoint.
 * POST /generate
 * Body: { prompt: string, mode?: string, size?: string, detail?: string }
 */
app.post("/generate", async (req, res) => {
  try {
    if (!HF_TOKEN) {
      return res.status(500).json({
        error: "Backend not configured: missing HF_TOKEN.",
        detail: "Set HF_TOKEN in Render environment variables."
      });
    }

    const { prompt, mode, size, detail } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({
        error: "Prompt is required.",
        field: "prompt"
      });
    }

    const userKey = getUserKey(req);
    const usage = getUserUsage(userKey);

    if (usage.count >= MAX_IMAGES_PER_MONTH) {
      const remaining = 0;
      return res.status(429).json({
        error: "Monthly limit reached.",
        code: "LIMIT_REACHED",
        usage: {
          used: usage.count,
          remaining,
          limit: MAX_IMAGES_PER_MONTH,
          period: "calendar_month"
        },
        message:
          "You’ve hit your free image limit for this month. Check back next month or upgrade when plans are available."
      });
    }

    // Call Hugging Face Inference API for SDXL-Turbo
    const hfUrl =
      "https://api-inference.huggingface.co/models/stabilityai/sdxl-turbo";

    const payload = {
      inputs: prompt
      // Later you can pass generation parameters here if you want:
      // parameters: { guidance_scale: 0.0, num_inference_steps: 2, width: 1024, height: 1024 }
    };

    const hfResponse = await axios.post(hfUrl, payload, {
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      responseType: "arraybuffer",
      timeout: 60000 // 60 seconds
    });

    const contentType =
      hfResponse.headers["content-type"] || "image/png";

    // Convert binary image data to base64 data URL
    const base64Image =
      "data:" +
      contentType +
      ";base64," +
      Buffer.from(hfResponse.data, "binary").toString("base64");

    // Update usage
    usage.count += 1;
    const remaining = Math.max(0, MAX_IMAGES_PER_MONTH - usage.count);

    return res.json({
      image: base64Image,
      usage: {
        used: usage.count,
        remaining,
        limit: MAX_IMAGES_PER_MONTH,
        period: "calendar_month"
      },
      meta: {
        mode: mode || "artwork",
        size: size || "square",
        detail: detail || "balanced"
      }
    });
  } catch (err) {
    console.error(
      "Error in /generate:",
      err?.response?.status,
      err?.message
    );

    if (err.response) {
      const status = err.response.status;

      if (status === 503) {
        return res.status(503).json({
          error: "Model is warming up or temporarily unavailable.",
          code: "MODEL_BUSY"
        });
      }

      if (status === 429) {
        return res.status(429).json({
          error:
            "Hugging Face rate limit reached. Try again later or reduce usage.",
          code: "HF_RATE_LIMIT"
        });
      }
    }

    return res.status(500).json({
      error: "Unexpected error while generating image.",
      code: "SERVER_ERROR"
    });
  }
});

// Simple health check
app.get("/", (req, res) => {
  res.send("J GIL Image Backend is running.");
});

app.listen(PORT, () => {
  console.log(`J GIL Image Backend listening on port ${PORT}`);
});
