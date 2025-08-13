import express from "express";
import axios from "axios";
import FormData from "form-data";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Health check route
app.get("/", (req, res) => {
res.send({ ok: true, service: "JGIL API Backend" });
});

// Generate image route
app.post("/generate", async (req, res) => {
try {
const { prompt, userId } = req.body || {};
if (!prompt) return res.status(400).json({ error: "Missing prompt" });

const STABILITY_API_KEY = process.env.STABILITY_API_KEY;
const STABILITY_API_URL = process.env.STABILITY_API_URL;

if (!STABILITY_API_KEY || !STABILITY_API_URL) {
return res.status(500).json({ error: "Server not configured (API key or URL missing)" });
}

// Call Stability AI with multipart/form-data
const fd = new FormData();
fd.append("prompt", prompt);
fd.append("output_format", "png");

const stabilityResp = await axios.post(STABILITY_API_URL, fd, {
headers: {
Authorization: `Bearer ${STABILITY_API_KEY}`,
Accept: "image/*",
...fd.getHeaders()
},
responseType: "arraybuffer"
});

// Convert image to base64 data URL (temporary solution)
const b64 = Buffer.from(stabilityResp.data, "binary").toString("base64");
const imageUrl = `data:image/png;base64,${b64}`;

console.log({ userId, prompt, createdAt: new Date().toISOString() });
res.json({ imageUrl });
} catch (err) {
const code = err?.response?.status;
const body = err?.response?.data?.toString?.() || err?.message;
console.error("Stability error:", code, body);
res.status(500).json({ error: "Generation failed", details: code || body });
}
});

// Listen on Render's assigned port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`JGIL API Backend running on ${PORT}`));
