// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

const AUTOCAB_KEY    = process.env.AUTOCAB_KEY || "";
const WEBHOOK_TOKEN  = process.env.WEBHOOK_TOKEN || "";
const STATUS_FILE    = process.env.STATUS_FILE || "./status.json";

// minutes before a vehicle is considered offline if no activity
const PING_TIMEOUT_MINUTES = Number(process.env.PING_TIMEOUT_MINUTES || 5);
const OFFLINE_TIMEOUT_MS   = PING_TIMEOUT_MINUTES * 60 * 1000;

// --- Middleware
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * Store:
 *  callsign -> {
 *    online: boolean | null,     // last explicit online/offline we saw
 *    updatedAt: ISO string,      // last updated (any source)
 *    lastPingAt: ISO string,     // last HackneyLocation ping
 *    lastStatusAt: ISO string,   // last Status webhook hit
 *    driverStatus: string | null // clear / busy / etc.
 *  }
 */
let onlineMap = new Map();

// --- Persist to disk (debounced)
function loadStatusFromDisk() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
      onlineMap = new Map(raw.map(([k, v]) => [k, v]));
      console.log(`Loaded ${onlineMap.size} status records from ${STATUS_FILE}.`);
    } else {
      console.log(`No ${STATUS_FILE} found; starting fresh.`);
    }
  } catch (e) {
    console.warn("Could not load status file:", e.message);
  }
}

let saveTimer;
function saveStatusToDisk() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const arr = Array.from(onlineMap.entries());
      fs.writeFileSync(STATUS_FILE, JSON.stringify(arr), "utf8");
    } catch (e) {
      console.warn("Could not save status file:", e.message);
    }
  }, 500);
}
loadStatusFromDisk();

const normKey = (s) => String(s || "").trim().toUpperCase();

// --- Helpers for webhook payloads
function coercePayloadToArray(body) {
  let b = body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch { /* ignore */ }
  }
  if (Array.isArray(b)) return b;
  if (Array.isArray(b?.data)) return b.data;
  if (Array.isArray(b?.payload)) return b.payload;
  if (b == null || b === "") return [];
  return [b];
}

function extractCallsign(obj) {
  const direct =
    obj?.callsign ??
    obj?.callSign ??
    obj?.code ??
    obj?.mdtId ??
    obj?.mdtID ??
    obj?.vehicleCode ??
    obj?.driverCode ??
    null;

  if (direct) return direct;

  const d = obj?.Driver || obj?.driver || {};
  const v = obj?.Vehicle || obj?.vehicle || {};

  return (
    d?.Callsign ?? d?.callsign ?? d?.callSign ??
    v?.Callsign ?? v?.callsign ?? v?.callSign ??
    null
  );
}

// Interpret Autocab-ish online/offline from status webhook
function inferOnlineFromStatus(obj) {
  if (typeof obj?.online === "boolean") return obj.online;

  const s = (
    obj?.status ??
    obj?.Status ??
    obj?.shift ??
    obj?.state ??
    obj?.State ??
    obj?.availability ??
    obj?.Availability ??
    ""
  ).toString().toLowerCase();

  if (["on", "online", "active", "started", "loggedin", "open", "available", "true", "1", "clear"].includes(s)) return true;
  if (["off", "offline", "inactive", "ended", "loggedout", "closed", "unavailable", "false", "0"].includes(s)) return false;

  const sub = (obj?.SubEventType ?? obj?.subEventType ?? "").toString().toLowerCase();
  if (sub === "started") return true;
  if (sub === "ended")  return false;

  return null;
}

// friendly text for driver status column
function extractDriverStatus(obj) {
  const candidates = [
    obj?.driverStatus,
    obj?.DriverStatus,
    obj?.statusText,
    obj?.StatusText,
    obj?.stateText,
    obj?.StateText,
    obj?.driver_state,
    obj?.DriverState,
    obj?.currentStatus,
    obj?.CurrentStatus,
    obj?.activity,
    obj?.Activity,
    obj?.status,
    obj?.Status,
    obj?.availability,
    obj?.Availability,
  ];

  for (const val of candidates) {
    if (val !== undefined && val !== null) {
      const s = String(val).trim();
      if (s) return s;
    }
  }

  return "";
}

/**
 * Effective online:
 * 1. If we have explicit online === false, it's OFFLINE.
 * 2. Else, if lastSeen (ping or status) is older than timeout, OFFLINE.
 * 3. Else, if explicit online === true, ONLINE.
 * 4. Else, null (unknown).
 */
function computeEffectiveOnline(rec) {
  if (!rec) return null;

  // 1. explicit offline wins
  if (rec.online === false) return false;

  // last time we saw *anything*
  const iso = rec.lastPingAt || rec.lastStatusAt || rec.updatedAt;
  if (iso) {
    const t = new Date(iso).getTime();
    if (Number.isFinite(t)) {
      const age = Date.now() - t;
      if (age > OFFLINE_TIMEOUT_MS) {
        return false;
      }
    }
  }

  // 3. explicit online
  if (rec.online === true) return true;

  // 4. don't know
  return null;
}

// --- Static files
app.use(express.static(path.join(__dirname, "public")));

// --- SSE support
let sseClients = new Set();

app.get("/api/status/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const snapshot = Array.from(onlineMap.entries()).map(([k, v]) => ({
    callsign: k,
    online: computeEffectiveOnline(v),
    updatedAt: v.updatedAt || null,
    driverStatus: v.driverStatus || null,
  }));
  res.write(`event: snapshot\ndata:${JSON.stringify({ data: snapshot })}\n\n`);

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

const HEARTBEAT_MS = 25000;
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(`:heartbeat ${Date.now()}\n\n`);
    } catch {/* ignore */}
  }
}, HEARTBEAT_MS);

function sseBroadcast(event, payload) {
  const msg = `event: ${event}\ndata:${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {/* ignore */}
  }
}

// --- Webhook: Location pings (GPS / keep-alive)
app.post("/webhook/HackneyLocation", (req, res) => {
  try {
    if (WEBHOOK_TOKEN) {
      const provided = req.headers["x-webhook-token"];
      if (provided !== WEBHOOK_TOKEN) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }
    }

    const items = coercePayloadToArray(req.body);
    let updates = 0;
    const nowIso = new Date().toISOString();

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const cs = extractCallsign(item);
      if (!cs) continue;

      const key = normKey(cs);
      const existing = onlineMap.get(key) || {};

      const rec = {
        ...existing,
        online: true,                          // ping always means "seen alive"
        lastPingAt: item?.timestamp || item?.time || nowIso,
        updatedAt: nowIso,
      };

      onlineMap.set(key, rec);
      updates++;

      sseBroadcast("status", {
        callsign: key,
        online: computeEffectiveOnline(rec),
        updatedAt: rec.updatedAt,
        driverStatus: rec.driverStatus || null,
      });
    }

    if (updates > 0) {
      saveStatusToDisk();
      console.log(`HackneyLocation: updated ${updates} records`);
    }

    res.json({ ok: true, updates });
  } catch (e) {
    console.error("HackneyLocation webhook error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Webhook: Driver status (clear / busy / etc.)
app.post("/webhook/Status", (req, res) => {
  try {
    if (WEBHOOK_TOKEN) {
      const provided = req.headers["x-webhook-token"];
      if (provided !== WEBHOOK_TOKEN) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }
    }

    const items = coercePayloadToArray(req.body);
    let updates = 0;
    const nowIso = new Date().toISOString();

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const cs = extractCallsign(item);
      if (!cs) continue;
      const key = normKey(cs);

      const existing = onlineMap.get(key) || {};
      const driverStatus = extractDriverStatus(item);
      const inferredOnline = inferOnlineFromStatus(item);

      const rec = {
        ...existing,
        updatedAt: item?.ModifiedDate || item?.updatedAt || item?.timestamp || existing.updatedAt || nowIso,
        lastStatusAt: item?.ModifiedDate || item?.updatedAt || item?.timestamp || nowIso,
        driverStatus: driverStatus || existing.driverStatus || null,
      };

      // Allow status webhook to set online/offline explicitly
      if (inferredOnline !== null) {
        rec.online = inferredOnline;
      }

      onlineMap.set(key, rec);
      updates++;

      sseBroadcast("status", {
        callsign: key,
        online: computeEffectiveOnline(rec),
        updatedAt: rec.updatedAt,
        driverStatus: rec.driverStatus || null,
      });
    }

    if (updates > 0) {
      saveStatusToDisk();
      console.log(`Status webhook: updated ${updates} records`);
    }

    res.json({ ok: true, updates });
  } catch (e) {
    console.error("Status webhook error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Read endpoints used by the frontend
app.get("/api/status", (_req, res) => {
  try {
    const arr = Array.from(onlineMap.entries()).map(([k, v]) => ({
      callsign: k,
      online: computeEffectiveOnline(v),
      updatedAt: v.updatedAt || null,
      driverStatus: v.driverStatus || null,
    }));
    res.json({ data: arr, count: arr.length, ts: new Date().toISOString() });
  } catch (e) {
    console.error("/api/status error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Proxy to Autocab for vehicle list
app.get("/api/vehicles", async (_req, res) => {
  try {
    if (!AUTOCAB_KEY) {
      return res.status(500).json({ error: "Missing AUTOCAB_KEY in environment" });
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
      console.error("Upstream /vehicle error:", r.status, txt);
      return res.status(r.status).send(txt || `Upstream error: ${r.statusText}`);
    }

    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error("Proxy /api/vehicles error:", e);
    res.status(500).json({ error: e.message });
  }
});

// --- Health & Root
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// --- Graceful shutdown
process.on("SIGTERM", () => {
  try { saveStatusToDisk(); } finally { process.exit(0); }
});
process.on("SIGINT", () => {
  try { saveStatusToDisk(); } finally { process.exit(0); }
});

// --- Start
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`PING timeout set to ${PING_TIMEOUT_MINUTES} minute(s).`);
});
