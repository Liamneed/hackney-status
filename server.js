// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const AUTOCAB_KEY = process.env.AUTOCAB_KEY;

// --- Middleware
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// --- In-memory store for online/offline by callsign
let onlineMap = new Map();

// --- Optional: persist to disk
const STATUS_FILE = process.env.STATUS_FILE || "./status.json";
function loadStatusFromDisk() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
      onlineMap = new Map(raw.map(([k, v]) => [k, v]));
      console.log(`Loaded ${onlineMap.size} status records from disk.`);
    }
  } catch (e) {
    console.warn("Could not load status.json:", e.message);
  }
}
function saveStatusToDisk() {
  try {
    const arr = Array.from(onlineMap.entries());
    fs.writeFileSync(STATUS_FILE, JSON.stringify(arr), "utf8");
  } catch (e) {
    console.warn("Could not save status.json:", e.message);
  }
}
loadStatusFromDisk();

const normKey = (s) => String(s || "").trim().toUpperCase();

// --- Extractors / inference
function extractCallsign(obj) {
  // Top-level first
  const direct =
    obj?.callsign ?? obj?.callSign ?? obj?.code ?? obj?.mdtId ?? obj?.mdtID ??
    obj?.vehicleCode ?? obj?.driverCode ?? null;
  if (direct) return direct;

  // Common nested spots (Autocab ShiftChange style)
  const d = obj?.Driver || obj?.driver || {};
  const v = obj?.Vehicle || obj?.vehicle || {};
  return (
    d?.Callsign ?? d?.callsign ?? d?.callSign ??
    v?.Callsign ?? v?.callsign ?? v?.callSign ?? null
  );
}

function inferOnline(obj) {
  // Explicit boolean
  if (typeof obj?.online === "boolean") return obj.online;

  // Generic string fields
  const s = (obj?.status ?? obj?.shift ?? obj?.state ?? obj?.availability ?? "")
    .toString()
    .toLowerCase();
  if (["on", "online", "active", "started", "loggedin", "open", "available", "true", "1"].includes(s)) return true;
  if (["off", "offline", "inactive", "ended", "loggedout", "closed", "unavailable", "false", "0"].includes(s)) return false;

  // Autocab style: SubEventType: "Started" | "Ended"
  const sub = (obj?.SubEventType ?? obj?.subEventType ?? "").toString().toLowerCase();
  if (sub === "started") return true;
  if (sub === "ended") return false;

  // Presence of StartedDate / EndedDate (heuristic)
  if (obj?.StartedDate && !obj?.EndedDate) return true;
  if (obj?.EndedDate && !obj?.StartedDate) return false;

  // Nested Driver/Vehicle shift hints (future-proof)
  const d = obj?.Driver || obj?.driver || {};
  const v = obj?.Vehicle || obj?.vehicle || {};
  const dShift = (d?.ShiftStatus ?? d?.status ?? "").toString().toLowerCase();
  const vShift = (v?.ShiftStatus ?? v?.status ?? "").toString().toLowerCase();
  if (["on", "online", "started", "active"].includes(dShift)) return true;
  if (["off", "offline", "ended", "inactive"].includes(dShift)) return false;
  if (["on", "online", "started", "active"].includes(vShift)) return true;
  if (["off", "offline", "ended", "inactive"].includes(vShift)) return false;

  return null;
}

function coercePayloadToArray(body) {
  let b = body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch { /* ignore */ }
  }
  if (Array.isArray(b)) return b;
  if (Array.isArray(b?.data)) return b.data;
  if (Array.isArray(b?.payload)) return b.payload;
  return [b];
}

// --- SSE wiring for instant pushes to browser
let sseClients = new Set();

app.get("/api/status/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Initial snapshot
  const snapshot = Array.from(onlineMap.entries()).map(([k, v]) => ({
    callsign: k, online: !!v.online, updatedAt: v.updatedAt || null
  }));
  res.write(`event: snapshot\ndata:${JSON.stringify({ data: snapshot })}\n\n`);

  sseClients.add(res);
  req.on("close", () => { sseClients.delete(res); });
});

function sseBroadcast(event, payload) {
  const msg = `event: ${event}\ndata:${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { /* ignore broken pipes */ }
  }
}

// --- Webhook receiver
app.post("/webhook/ShiftChange", (req, res) => {
  try {
    const items = coercePayloadToArray(req.body);
    let updates = 0;

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const cs = extractCallsign(item);
      const online = inferOnline(item);

      if (!cs) {
        console.log("Webhook received but no callsign found", item);
        continue;
      }
      if (online === null) {
        console.log(`Webhook for ${cs} but could not infer online/offline`, item);
        continue;
      }

      const rec = {
        online,
        updatedAt:
          item?.ModifiedDate ||
          item?.updatedAt ||
          item?.timestamp ||
          new Date().toISOString(),
      };

      onlineMap.set(normKey(cs), rec);
      updates++;

      // Log + push to connected browsers immediately
      console.log(`Status set: callsign ${cs} -> ${online ? "ONLINE" : "OFFLINE"} @ ${rec.updatedAt}`);
      sseBroadcast("status", { callsign: normKey(cs), ...rec });
    }

    if (updates > 0) saveStatusToDisk();
    res.status(200).json({ ok: true, updates });
  } catch (e) {
    console.error("ShiftChange handler error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Public read endpoint
app.get("/api/status", (_req, res) => {
  const arr = Array.from(onlineMap.entries()).map(([k, v]) => ({
    callsign: k,
    online: !!v.online,
    updatedAt: v.updatedAt || null,
  }));
  res.json({ data: arr, count: arr.length, ts: new Date().toISOString() });
});

// --- Proxy Autocab Vehicles API
app.get("/api/vehicles", async (_req, res) => {
  try {
    if (!AUTOCAB_KEY) {
      return res.status(500).json({ error: "Missing AUTOCAB_KEY in .env" });
    }

    const url = "https://autocab-api.azure-api.net/vehicle/v1/vehicles";
    const r = await fetch(url, {
      headers: {
        "Ocp-Apim-Subscription-Key": AUTOCAB_KEY,
        "Cache-Control": "no-cache",
      },
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).send(txt || `Upstream error: ${r.statusText}`);
    }

    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error("Proxy /api/vehicles error:", e);
    res.status(500).json({ error: e.message });
  }
});

process.on("SIGTERM", () => { try { saveStatusToDisk(); } finally { process.exit(0); } });
process.on("SIGINT",  () => { try { saveStatusToDisk(); } finally { process.exit(0); } });

// --- Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- Static
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
