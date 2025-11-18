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
const AUTOCAB_KEY = process.env.AUTOCAB_KEY || "";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
// Use a persistent disk on Render, e.g. set STATUS_FILE=/data/status.json
const STATUS_FILE = process.env.STATUS_FILE || "./status.json";

// How long until we force a vehicle offline if we hear nothing (from ANY webhook)
const OFFLINE_AFTER_MINUTES = Number(process.env.OFFLINE_AFTER_MINUTES || 8);
const OFFLINE_AFTER_MS = OFFLINE_AFTER_MINUTES * 60 * 1000;

// --- Middleware
app.set("trust proxy", 1);
app.use(cors()); // tighten with origin: [] if desired
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * Each record in onlineMap is:
 * {
 *   online: boolean,
 *   updatedAt: ISO string,
 *   lastPingAt: ISO string | null,
 *   lastLocationAt: ISO string | null,
 *   lastStatusAt: ISO string | null,
 *   driverStatus: string | null
 * }
 */
let onlineMap = new Map();

// --- Persist to disk (debounced)
function loadStatusFromDisk() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
      onlineMap = new Map(
        raw.map(([k, v]) => {
          // Backwards-compat for old simple shape { online, updatedAt }
          const rec = {
            online: !!v.online,
            updatedAt: v.updatedAt || new Date().toISOString(),
            lastPingAt: v.lastPingAt || v.updatedAt || null,
            lastLocationAt: v.lastLocationAt || null,
            lastStatusAt: v.lastStatusAt || null,
            driverStatus: v.driverStatus || null,
          };
          return [k, rec];
        })
      );
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

// --- Extractors / inference
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
    d?.Callsign ??
    d?.callsign ??
    d?.callSign ??
    v?.Callsign ??
    v?.callsign ??
    v?.callSign ??
    null
  );
}

// Generic inference used for legacy ShiftChange etc.
function inferOnline(obj) {
  if (typeof obj?.online === "boolean") return obj.online;

  const s = (obj?.status ?? obj?.shift ?? obj?.state ?? obj?.availability ?? "")
    .toString()
    .toLowerCase();
  if (["on","online","active","started","loggedin","open","available","true","1"].includes(s)) return true;
  if (["off","offline","inactive","ended","loggedout","closed","unavailable","false","0"].includes(s)) return false;

  const sub = (obj?.SubEventType ?? obj?.subEventType ?? "").toString().toLowerCase();
  if (sub === "started") return true;
  if (sub === "ended") return false;

  if (obj?.StartedDate && !obj?.EndedDate) return true;
  if (obj?.EndedDate && !obj?.StartedDate) return false;

  const d = obj?.Driver || obj?.driver || {};
  const v = obj?.Vehicle || obj?.vehicle || {};
  const dShift = (d?.ShiftStatus ?? d?.status ?? "").toString().toLowerCase();
  const vShift = (v?.ShiftStatus ?? v?.status ?? "").toString().toLowerCase();
  if (["on","online","started","active"].includes(dShift)) return true;
  if (["off","offline","ended","inactive"].includes(dShift)) return false;
  if (["on","online","started","active"].includes(vShift)) return true;
  if (["off","offline","ended","inactive"].includes(vShift)) return false;

  return null;
}

// More opinionated inference specifically for driver "Status" webhook
function inferOnlineFromDriverStatus(statusStr) {
  if (!statusStr) return null;
  const s = statusStr.toString().toLowerCase();

  // Treat "clear", "busy", "on job" etc as ONLINE
  const onlineKeywords = [
    "clear",
    "busy",
    "onjob",
    "on job",
    "prebooked",
    "pre-booked",
    "stacked",
    "allocation",
    "working",
    "available"
  ];
  if (onlineKeywords.some((k) => s.includes(k))) return true;

  // Treat explicit offline/off shift states as OFFLINE
  const offlineKeywords = [
    "offline",
    "off shift",
    "offshift",
    "no pda",
    "nopda",
    "logged off",
    "logoff",
    "log off",
    "off-duty",
    "off duty"
  ];
  if (offlineKeywords.some((k) => s.includes(k))) return false;

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
  if (b == null || b === "") return [];
  return [b];
}

// Ensure a record exists
function getOrCreateRecord(key) {
  const nowIso = new Date().toISOString();
  const existing = onlineMap.get(key);
  if (existing) return existing;
  const rec = {
    online: false,
    updatedAt: nowIso,
    lastPingAt: null,
    lastLocationAt: null,
    lastStatusAt: null,
    driverStatus: null,
  };
  onlineMap.set(key, rec);
  return rec;
}

// When we get a ping, update the timestamps and maybe online flag
function updatePing(rec, { kind, ts, driverStatus, onlineHint }) {
  const t = ts || new Date().toISOString();
  rec.updatedAt = t;

  if (kind === "location") {
    rec.lastLocationAt = t;
  }
  if (kind === "status") {
    rec.lastStatusAt = t;
  }

  // lastPingAt = most recent of both
  const lastLoc = rec.lastLocationAt ? new Date(rec.lastLocationAt).getTime() : 0;
  const lastStat = rec.lastStatusAt ? new Date(rec.lastStatusAt).getTime() : 0;
  const latest = Math.max(lastLoc, lastStat, new Date(t).getTime());
  rec.lastPingAt = new Date(latest).toISOString();

  if (driverStatus !== undefined) {
    rec.driverStatus = driverStatus;
  }

  // If webhook provides a clear online/offline hint, apply it
  if (typeof onlineHint === "boolean") {
    rec.online = onlineHint;
  } else {
    // If we get *any* ping and nothing is saying offline, assume online
    if (rec.online === false) {
      rec.online = true;
    }
  }
}

// Force offline if no pings for OFFLINE_AFTER_MINUTES
function applyOfflineTimeout(rec) {
  if (!rec.lastPingAt) {
    rec.online = false;
    return;
  }
  const age = Date.now() - new Date(rec.lastPingAt).getTime();
  if (age > OFFLINE_AFTER_MS) {
    rec.online = false;
  }
}

// --- Static FIRST (UI)
app.use(express.static(path.join(__dirname, "public")));

// --- SSE
let sseClients = new Set();

app.get("/api/status/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const snapshot = Array.from(onlineMap.entries()).map(([k, v]) => ({
    callsign: k,
    online: !!v.online,
    updatedAt: v.updatedAt || null,
    driverStatus: v.driverStatus || null,
  }));
  res.write(`event: snapshot\ndata:${JSON.stringify({ data: snapshot })}\n\n`);

  sseClients.add(res);
  req.on("close", () => { sseClients.delete(res); });
});

// Heartbeat
const HEARTBEAT_MS = 25000;
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(`:heartbeat ${Date.now()}\n\n`); } catch {}
  }
}, HEARTBEAT_MS);

function sseBroadcast(event, payload) {
  const msg = `event: ${event}\ndata:${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

// --- Webhook auth helper
function checkWebhookAuth(req, res) {
  if (!WEBHOOK_TOKEN) return true; // auth disabled
  const provided = req.headers["x-webhook-token"];
  if (provided !== WEBHOOK_TOKEN) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

// --- HackneyLocation webhook (location pings)
// Live Autocab config: https://hackney.needacabapis.co.uk/webhook/HackneyLocation
app.post("/webhook/HackneyLocation", (req, res) => {
  if (!checkWebhookAuth(req, res)) return;

  try {
    const items = coercePayloadToArray(req.body);
    let updates = 0;

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const cs = extractCallsign(item);
      if (!cs) { console.log("[HackneyLocation] No callsign in item", item); continue; }

      const key = normKey(cs);
      const rec = getOrCreateRecord(key);
      const ts = item?.ModifiedDate || item?.updatedAt || item?.timestamp || new Date().toISOString();

      // Location ping => treat as online (unless Status says otherwise later)
      updatePing(rec, { kind: "location", ts, onlineHint: true });

      applyOfflineTimeout(rec); // just in case clocks are weird
      onlineMap.set(key, rec);
      updates++;

      console.log(`[HackneyLocation] ${key} ping @ ${rec.lastLocationAt} -> online=${rec.online}`);
      sseBroadcast("status", {
        callsign: key,
        online: rec.online,
        updatedAt: rec.updatedAt,
        driverStatus: rec.driverStatus || null,
      });
    }

    if (updates > 0) saveStatusToDisk();
    res.status(200).json({ ok: true, updates });
  } catch (e) {
    console.error("HackneyLocation handler error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Status webhook (driver status: clear, busy etc.)
// Live Autocab config: https://hackney.needacabapis.co.uk/webhook/Status
app.post("/webhook/Status", (req, res) => {
  if (!checkWebhookAuth(req, res)) return;

  try {
    const items = coercePayloadToArray(req.body);
    let updates = 0;

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const cs = extractCallsign(item);
      if (!cs) { console.log("[Status] No callsign in item", item); continue; }

      const key = normKey(cs);
      const rec = getOrCreateRecord(key);
      const ts = item?.ModifiedDate || item?.updatedAt || item?.timestamp || new Date().toISOString();

      const rawStatus =
        item?.Status ??
        item?.status ??
        item?.DriverStatus ??
        item?.driverStatus ??
        null;

      const onlineFromDriver = inferOnlineFromDriverStatus(rawStatus);
      const onlineGeneric = inferOnline(item);
      const onlineHint = onlineFromDriver !== null ? onlineFromDriver : onlineGeneric;

      updatePing(rec, {
        kind: "status",
        ts,
        driverStatus: rawStatus != null ? String(rawStatus) : rec.driverStatus,
        onlineHint,
      });

      applyOfflineTimeout(rec);
      onlineMap.set(key, rec);
      updates++;

      console.log(
        `[Status] ${key} -> online=${rec.online}, driverStatus=${rec.driverStatus}, lastPingAt=${rec.lastPingAt}`
      );

      sseBroadcast("status", {
        callsign: key,
        online: rec.online,
        updatedAt: rec.updatedAt,
        driverStatus: rec.driverStatus || null,
      });
    }

    if (updates > 0) saveStatusToDisk();
    res.status(200).json({ ok: true, updates });
  } catch (e) {
    console.error("Status handler error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Legacy ShiftChange webhook (optional, keep if anything still points at it)
app.post("/webhook/ShiftChange", (req, res) => {
  if (!checkWebhookAuth(req, res)) return;

  try {
    const items = coercePayloadToArray(req.body);
    let updates = 0;

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const cs = extractCallsign(item);
      const onlineHint = inferOnline(item);
      if (!cs) { console.log("[ShiftChange] No callsign in item", item); continue; }
      if (onlineHint === null) { console.log(`[ShiftChange] Cannot infer online for ${cs}`, item); continue; }

      const key = normKey(cs);
      const rec = getOrCreateRecord(key);
      const ts = item?.ModifiedDate || item?.updatedAt || item?.timestamp || new Date().toISOString();

      updatePing(rec, { kind: "status", ts, onlineHint });
      applyOfflineTimeout(rec);
      onlineMap.set(key, rec);
      updates++;

      console.log(`[ShiftChange] ${key} -> online=${rec.online} @ ${rec.updatedAt}`);
      sseBroadcast("status", {
        callsign: key,
        online: rec.online,
        updatedAt: rec.updatedAt,
        driverStatus: rec.driverStatus || null,
      });
    }

    if (updates > 0) saveStatusToDisk();
    res.status(200).json({ ok: true, updates });
  } catch (e) {
    console.error("ShiftChange handler error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Background sweep: force offline after timeout ---
setInterval(() => {
  const now = Date.now();
  let changed = 0;

  for (const [key, rec] of onlineMap.entries()) {
    const before = rec.online;
    applyOfflineTimeout(rec);
    if (rec.online !== before) {
      rec.updatedAt = new Date(now).toISOString();
      onlineMap.set(key, rec);
      changed++;
      console.log(`[SWEEP] ${key} -> online=${rec.online}`);
      sseBroadcast("status", {
        callsign: key,
        online: rec.online,
        updatedAt: rec.updatedAt,
        driverStatus: rec.driverStatus || null,
      });
    }
  }

  if (changed > 0) saveStatusToDisk();
}, 60 * 1000);

// --- Read endpoints
app.get("/api/status", (_req, res) => {
  const arr = Array.from(onlineMap.entries()).map(([k, v]) => ({
    callsign: k,
    online: !!v.online,
    updatedAt: v.updatedAt || null,
    driverStatus: v.driverStatus || null,
  }));
  res.json({ data: arr, count: arr.length, ts: new Date().toISOString() });
});

app.get("/api/vehicles", async (_req, res) => {
  try {
    if (!AUTOCAB_KEY) {
      return res.status(500).json({ error: "Missing AUTOCAB_KEY in .env" });
    }
    const url = "https://autocab-api.azure-api.net/vehicle/v1/vehicles";
    const r = await fetch(url, {
      headers: { "Ocp-Apim-Subscription-Key": AUTOCAB_KEY, "Cache-Control": "no-cache" },
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

// --- Health & Root
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// --- Graceful shutdown
process.on("SIGTERM", () => { try { saveStatusToDisk(); } finally { process.exit(0); } });
process.on("SIGINT",  () => { try { saveStatusToDisk(); } finally { process.exit(0); } });

// --- Start
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Offline timeout: ${OFFLINE_AFTER_MINUTES} minutes with no pings.`);
});
