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

// minutes before a vehicle is considered offline if no ping
const PING_TIMEOUT_MINUTES = Number(process.env.PING_TIMEOUT_MINUTES || 10);
const OFFLINE_TIMEOUT_MS   = PING_TIMEOUT_MINUTES * 60 * 1000;

// --- Middleware
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * Store per callsign:
 *   {
 *     lastPingAt: ISO string,     // last ping (Status / ShiftChange / HackneyLocation)
 *     updatedAt: ISO string,      // last update time
 *     driverStatus: string | null,// "Busy (Cash)" / "Busy (Account)" / "Clear" / etc.
 *     explicitOnline: boolean|null// hard override from ShiftChange (true/false)
 *   }
 *
 * Online is derived from lastPingAt + timeout, PLUS explicitOnline if set.
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

/**
 * Compute effective online:
 *  1. If explicitOnline === false → always OFFLINE (dot red).
 *  2. If no lastPingAt → OFFLINE.
 *  3. If lastPingAt older than timeout → OFFLINE.
 *  4. If explicitOnline === true → ONLINE.
 *  5. Else, recent ping and no explicit flag → ONLINE.
 */
function computeOnline(rec) {
  if (!rec) return false;

  if (rec.explicitOnline === false) return false;

  if (!rec.lastPingAt) return false;
  const t = new Date(rec.lastPingAt).getTime();
  if (!Number.isFinite(t)) return false;

  const age = Date.now() - t;
  if (age > OFFLINE_TIMEOUT_MS) return false;

  if (rec.explicitOnline === true) return true;

  return true;
}

function extractCallsignGeneric(obj) {
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

// Generic helper to turn various payload shapes into an array
function coercePayloadToArray(body) {
  const b = body || {};
  if (Array.isArray(b)) return b;
  if (Array.isArray(b.data)) return b.data;
  if (Array.isArray(b.items)) return b.items;
  if (Array.isArray(b.VehicleTracks)) return b.VehicleTracks;
  if (Array.isArray(b.Shifts)) return b.Shifts;
  if (Array.isArray(b.Events)) return b.Events;
  return [b];
}

// Map VehicleStatus to human-friendly text
function mapVehicleStatus(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const lower = s.toLowerCase();

  if (lower.startsWith("busy")) {
    if (lower.includes("account")) return "Busy (Account)";
    if (lower.includes("cash"))    return "Busy (Cash)";
    return "Busy";
  }

  if (lower.includes("clear") || lower.includes("free")) return "Clear";

  // fallback to raw string
  return s;
}

// Infer explicitOnline from ShiftChange status strings
function inferOnlineFromShift(statusText, subType, eventType) {
  const s = (statusText || "").toString().toLowerCase();
  const sub = (subType || "").toString().toLowerCase();
  const evt = (eventType || "").toString().toLowerCase();

  // online-ish words
  if (
    s.includes("start") || s.includes("on") || s.includes("open") ||
    s.includes("logged in") || s.includes("loggedon") || s.includes("signed on") ||
    sub === "started" || evt.includes("shiftstart")
  ) {
    return true;
  }

  // offline-ish words
  if (
    s.includes("end") || s.includes("off") || s.includes("closed") ||
    s.includes("logged out") || s.includes("loggedoff") || s.includes("signed off") ||
    sub === "ended" || evt.includes("shiftend")
  ) {
    return false;
  }

  return null;
}

// --- Static files
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
    online: computeOnline(v),
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

function sseBroadcastUpdate(callsign, rec) {
  const payload = {
    callsign,
    online: computeOnline(rec),
    updatedAt: rec.updatedAt || null,
    driverStatus: rec.driverStatus || null,
  };
  const msg = `event: status\ndata:${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {/* ignore */}
  }
}

// --- Webhook auth helper
function checkWebhookAuth(req, res) {
  if (!WEBHOOK_TOKEN) return true;
  const provided = req.headers["x-webhook-token"];
  if (provided !== WEBHOOK_TOKEN) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

// --- Webhook: HackneyLocation (simple ping, no status)
app.post("/webhook/HackneyLocation", (req, res) => {
  try {
    if (!checkWebhookAuth(req, res)) return;

    const items = coercePayloadToArray(req.body);
    let updates = 0;
    const nowIso = new Date().toISOString();

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const cs = extractCallsignGeneric(item);
      if (!cs) continue;
      const key = normKey(cs);

      const ts = item.Timestamp || item.timestamp || item.time || nowIso;

      const existing = onlineMap.get(key) || {};
      const rec = {
        ...existing,
        lastPingAt: ts,
        updatedAt: ts,
        // location ping strongly suggests online
        explicitOnline: existing.explicitOnline ?? true,
      };

      onlineMap.set(key, rec);
      updates++;
      sseBroadcastUpdate(key, rec);
    }

    if (updates > 0) {
      saveStatusToDisk();
      console.log(`HackneyLocation webhook: updated ${updates} vehicles`);
    }

    res.json({ ok: true, updates });
  } catch (e) {
    console.error("HackneyLocation webhook error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Webhook: Status — VehicleTracksChanged (BUSY / CLEAR + ping)
app.post("/webhook/Status", (req, res) => {
  try {
    if (!checkWebhookAuth(req, res)) return;

    const body = req.body || {};
    // Autocab payload: { EventType: "VehicleTracksChanged", VehicleTracks: [ ... ] }
    const tracks = Array.isArray(body.VehicleTracks)
      ? body.VehicleTracks
      : coercePayloadToArray(body);

    let updates = 0;

    for (const track of tracks) {
      if (!track || typeof track !== "object") continue;

      const vehicle = track.Vehicle || {};
      const driver  = track.Driver  || {};

      const cs =
        vehicle.Callsign ||
        driver.Callsign ||
        extractCallsignGeneric(track) ||
        null;

      if (!cs) continue;

      const key = normKey(cs);
      const ts  = track.Timestamp || track.timestamp || new Date().toISOString();

      const rawStatus  = track.VehicleStatus || track.vehicleStatus || null;
      const pretty     = mapVehicleStatus(rawStatus);

      const existing = onlineMap.get(key) || {};
      const rec = {
        ...existing,
        lastPingAt: ts,              // treat this as a ping
        updatedAt: ts,
        driverStatus: pretty ?? existing.driverStatus ?? null,
        // on a job → definitely online
        explicitOnline: true,
      };

      onlineMap.set(key, rec);
      updates++;
      sseBroadcastUpdate(key, rec);
    }

    if (updates > 0) {
      saveStatusToDisk();
      console.log(`Status webhook (VehicleTracksChanged): updated ${updates} vehicles`);
    }

    res.json({ ok: true, updates });
  } catch (e) {
    console.error("Status webhook error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Webhook: ShiftChange — logon/logoff, treat as ping + explicit online/offline
app.post("/webhook/ShiftChange", (req, res) => {
  try {
    if (!checkWebhookAuth(req, res)) return;

    const items = coercePayloadToArray(req.body);
    let updates = 0;

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const vehicle = item.Vehicle || {};
      const driver  = item.Driver  || {};
      const cs =
        vehicle.Callsign ||
        driver.Callsign ||
        extractCallsignGeneric(item) ||
        null;

      if (!cs) continue;
      const key = normKey(cs);

      const ts =
        item.Timestamp ||
        item.timestamp ||
        item.ModifiedDate ||
        item.EventTime ||
        new Date().toISOString();

      const rawStatus =
        item.ShiftStatus ??
        item.shiftStatus ??
        item.Status ??
        item.status ??
        item.DriverStatus ??
        item.driverStatus ??
        null;

      const eventType = item.EventType || item.Event || null;
      const subType   = item.SubEventType || item.subEventType || null;

      const explicit = inferOnlineFromShift(rawStatus, subType, eventType);

      const existing = onlineMap.get(key) || {};
      const rec = {
        ...existing,
        lastPingAt: ts,             // treat ShiftChange as activity
        updatedAt: ts,
        driverStatus: (rawStatus ? String(rawStatus) : existing.driverStatus) || null,
        explicitOnline: explicit !== null ? explicit : existing.explicitOnline ?? null,
      };

      onlineMap.set(key, rec);
      updates++;
      sseBroadcastUpdate(key, rec);

      console.log(
        `ShiftChange: ${key} ts=${ts} rawStatus=${rawStatus} explicitOnline=${rec.explicitOnline}`
      );
    }

    if (updates > 0) {
      saveStatusToDisk();
      console.log(`ShiftChange webhook: updated ${updates} vehicles`);
    }

    res.json({ ok: true, updates });
  } catch (e) {
    console.error("ShiftChange webhook error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- API used by frontend
app.get("/api/status", (_req, res) => {
  try {
    const arr = Array.from(onlineMap.entries()).map(([k, v]) => ({
      callsign: k,
      online: computeOnline(v),
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
  console.log(`ONLINE timeout set to ${PING_TIMEOUT_MINUTES} minute(s).`);
});
