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

// HOW LONG a ping keeps a vehicle ONLINE (minutes) before timing out
const PING_TIMEOUT_MINUTES = Number(process.env.PING_TIMEOUT_MINUTES || 10);
const OFFLINE_TIMEOUT_MS   = PING_TIMEOUT_MINUTES * 60 * 1000;

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * onlineMap: callsign -> {
 *   lastPingAt: ISO,
 *   updatedAt: ISO,
 *   driverStatusCode: string | null,   // raw VehicleStatus (BusyMeterOff, …)
 *   driverStatusLabel: string | null,  // friendly label for UI
 *   driverStatus: string | null,       // alias of driverStatusLabel (backwards compat)
 *   explicitOnline: boolean|null       // true = on shift / tracking, false = off shift
 * }
 */
let onlineMap = new Map();

// --- DEBUG: store last webhook payloads ---
let lastHackneyLocationPayload = null;
let lastStatusPayload = null;
let lastShiftChangePayload = null;

function debugLog(label, payload) {
  console.log(`\n===== ${label} @ ${new Date().toISOString()} =====`);
  try {
    const str = JSON.stringify(payload, null, 2);
    if (str.length > 5000) {
      console.log(str.substring(0, 5000) + " ... [TRUNCATED]");
    } else {
      console.log(str);
    }
  } catch (err) {
    console.log("Could not stringify payload:", err.message);
    console.log(payload);
  }
}

// ---------- Persistence ----------
function loadStatusFromDisk() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
      onlineMap = new Map(raw.map(([k, v]) => [k, v]));
      console.log(`Loaded ${onlineMap.size} records from ${STATUS_FILE}`);
    } else {
      console.log(`No ${STATUS_FILE}, starting clean`);
    }
  } catch (e) {
    console.warn("loadStatusFromDisk failed:", e.message);
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
      console.warn("saveStatusToDisk failed:", e.message);
    }
  }, 500);
}

loadStatusFromDisk();

const normKey = (s) => String(s || "").trim().toUpperCase();

// Helper: is incoming timestamp newer than existing?
function isNewerTimestamp(incomingIso, existingIso) {
  if (!incomingIso) return false;
  const inMs = Date.parse(incomingIso);
  if (!Number.isFinite(inMs)) return false;
  if (!existingIso) return true;
  const exMs = Date.parse(existingIso);
  if (!Number.isFinite(exMs)) return true;
  return inMs >= exMs;
}

// ---------- ONLINE LOGIC ----------
//
// Rules:
// - If status code/label maps to "Not Working" / off shift → ALWAYS offline.
// - Otherwise, driver is only "online" if explicitOnline === true
//   AND (optional) lastPingAt is recent.
//
function computeOnline(rec) {
  if (!rec) return false;

  const code = rec.driverStatusCode || "";
  const statusLower = (
    rec.driverStatusLabel ||
    rec.driverStatus ||
    ""
  ).toString().toLowerCase();

  if (
    code === "NotWorking" ||
    statusLower.includes("not working") ||
    statusLower.includes("off shift") ||
    statusLower.includes("off-duty") ||
    statusLower.includes("off duty") ||
    statusLower.includes("logged off") ||
    statusLower.includes("signed off") ||
    statusLower.includes("not on shift")
  ) {
    return false;
  }

  // must have an explicit "online" flag from Status / ShiftChange / HackneyLocation
  if (rec.explicitOnline !== true) return false;

  // Optional timeout for stale pings
  if (rec.lastPingAt) {
    const t = new Date(rec.lastPingAt).getTime();
    if (Number.isFinite(t)) {
      const age = Date.now() - t;
      if (age > OFFLINE_TIMEOUT_MS) return false;
    }
  }

  return true;
}

// ---------- Common helpers ----------
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

function coercePayloadToArray(body) {
  const b = body || {};
  if (Array.isArray(b)) return b;
  if (Array.isArray(b.VehicleTracks)) return b.VehicleTracks;
  if (Array.isArray(b.data)) return b.data;
  if (Array.isArray(b.items)) return b.items;
  if (Array.isArray(b.Shifts)) return b.Shifts;
  if (Array.isArray(b.Events)) return b.Events;
  return [b];
}

// VehicleStatus → friendly label (backend only; frontend now does its own shortening)
function vehicleStatusLabel(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  if (raw === "Clear") return "Clear";

  if (raw === "BusyMeterOff" || raw === "BusyMeterOffAccount") {
    return "Dispatched";
  }
  if (raw === "BusyMeterOnFromMeterOffCash" || raw === "BusyMeterOnFromMeterOffAccount") {
    return "Picked up";
  }
  if (raw === "BusyMeterOnFromClear") {
    return "Street Booking";
  }
  if (raw === "JobOffered") {
    return "Offering Job";
  }

  const lower = s.toLowerCase();
  if (lower.startsWith("busy")) {
    return "Busy";
  }

  return s; // fallback
}

// Simple label for shift change driverStatus
function shiftStatusLabel(rawStatus, eventType, subType, item) {
  const s   = (rawStatus || "").toString().toLowerCase();
  const evt = (eventType || "").toString().toLowerCase();
  const sub = (subType || "").toString().toLowerCase();

  const onShiftBool =
    typeof item?.IsOnShift === "boolean" ? item.IsOnShift :
    typeof item?.OnShift   === "boolean" ? item.OnShift   :
    typeof item?.onShift   === "boolean" ? item.onShift   :
    null;

  if (onShiftBool === true)  return "On Shift";
  if (onShiftBool === false) return "Off Shift";

  if (s.includes("break")) return "On Break";

  if (
    s.includes("start") ||
    s.includes("on shift") ||
    s.includes("logged in") ||
    s.includes("loggedon") ||
    s.includes("signed on") ||
    evt.includes("shiftstart") ||
    sub === "started"
  ) {
    return "On Shift";
  }

  if (
    s.includes("end") ||
    s.includes("off shift") ||
    s.includes("logged out") ||
    s.includes("loggedoff") ||
    s.includes("signed off") ||
    (s.includes("off") && !s.includes("offline status ignored")) ||
    evt.includes("shiftend") ||
    sub === "ended"
  ) {
    return "Off Shift";
  }

  if (rawStatus) return String(rawStatus);
  if (evt)       return `Shift: ${eventType}`;
  if (sub)       return `Shift: ${subType}`;
  return null;
}

// Infer explicit online/offline from ShiftChange strings + flags
function inferExplicitOnlineFromShift(rawStatus, eventType, subType, item) {
  const s   = (rawStatus || "").toString().toLowerCase();
  const evt = (eventType || "").toString().toLowerCase();
  const sub = (subType || "").toString().toLowerCase();

  const onShiftBool =
    typeof item?.IsOnShift === "boolean" ? item.IsOnShift :
    typeof item?.OnShift   === "boolean" ? item.OnShift   :
    typeof item?.onShift   === "boolean" ? item.onShift   :
    null;
  if (onShiftBool !== null) return onShiftBool;

  if (
    s.includes("start") ||
    s.includes("on shift") ||
    s.includes("logged in") ||
    s.includes("loggedon") ||
    s.includes("signed on") ||
    evt.includes("shiftstart") ||
    sub === "started"
  ) return true;

  if (
    s.includes("end") ||
    s.includes("off shift") ||
    s.includes("logged out") ||
    s.includes("loggedoff") ||
    s.includes("signed off") ||
    (s.includes("off") && !s.includes("offline status ignored")) ||
    evt.includes("shiftend") ||
    sub === "ended"
  ) return false;

  return null;
}

// ---------- SSE ----------
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
    driverStatus: v.driverStatus || v.driverStatusLabel || null,
    driverStatusCode: v.driverStatusCode || null,
  }));
  res.write(`event: snapshot\ndata:${JSON.stringify({ data: snapshot })}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

const HEARTBEAT_MS = 25000;
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(`:heartbeat ${Date.now()}\n\n`); } catch {}
  }
}, HEARTBEAT_MS);

function broadcastStatus(callsign, rec) {
  const payload = {
    callsign,
    online: computeOnline(rec),
    updatedAt: rec.updatedAt || null,
    driverStatus: rec.driverStatus || rec.driverStatusLabel || null,
    driverStatusCode: rec.driverStatusCode || null,
  };
  const msg = `event: status\ndata:${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

// ---------- Webhook auth ----------
function checkWebhookAuth(req, res) {
  if (!WEBHOOK_TOKEN) return true;
  const provided = req.headers["x-webhook-token"];
  if (provided !== WEBHOOK_TOKEN) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------- HackneyLocation: simple ping (now can mark online) ----------
app.post("/webhook/HackneyLocation", (req, res) => {
  try {
    if (!checkWebhookAuth(req, res)) return;

    lastHackneyLocationPayload = req.body;
    debugLog("WEBHOOK HIT: HackneyLocation", req.body);

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

      // 🔑 Only update if this ping is newer than what we already have
      if (!isNewerTimestamp(ts, existing.updatedAt || existing.lastPingAt || null)) {
        continue;
      }

      // NEW LOGIC:
      // - If we already know they are explicitly OFF (false), keep them off.
      // - Otherwise (undefined/null/true), treat a location ping as "working / online".
      let explicitOnline = existing.explicitOnline;
      if (explicitOnline === undefined || explicitOnline === null) {
        explicitOnline = true;
      }

      const rec = {
        ...existing,
        lastPingAt: ts,
        updatedAt: ts,
        explicitOnline,
      };

      onlineMap.set(key, rec);
      updates++;
      broadcastStatus(key, rec);
    }

    if (updates > 0) saveStatusToDisk();
    res.json({ ok: true, updates });
  } catch (e) {
    console.error("HackneyLocation error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------- Status: VehicleTracksChanged ----------
app.post("/webhook/Status", (req, res) => {
  try {
    if (!checkWebhookAuth(req, res)) return;

    lastStatusPayload = req.body;
    debugLog("WEBHOOK HIT: Status / VehicleTracks", req.body);

    const body = req.body || {};
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
      const ts  =
        track.Timestamp ||
        track.timestamp ||
        track.time ||
        new Date().toISOString();

      const rawCode = track.VehicleStatus || track.vehicleStatus || null;
      const label   = vehicleStatusLabel(rawCode);

      const existing = onlineMap.get(key) || {};

      // 🔑 Only update if this status is newer than what we already have
      if (!isNewerTimestamp(ts, existing.updatedAt || null)) {
        continue;
      }

      const rec = {
        ...existing,
        lastPingAt: existing.lastPingAt || ts, // keep old ping if newer comes from location
        updatedAt: ts,
        driverStatusCode: rawCode || existing.driverStatusCode || null,
        driverStatusLabel: label ?? existing.driverStatusLabel ?? rawCode ?? null,
        explicitOnline: true, // tracking → definitely on/working
      };
      rec.driverStatus = rec.driverStatusLabel;

      onlineMap.set(key, rec);
      updates++;
      broadcastStatus(key, rec);
    }

    if (updates > 0) {
      console.log(`Status webhook: updated ${updates} tracks`);
      saveStatusToDisk();
    }

    res.json({ ok: true, updates });
  } catch (e) {
    console.error("Status webhook error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------- ShiftChange: logon/logoff ----------
app.post("/webhook/ShiftChange", (req, res) => {
  try {
    if (!checkWebhookAuth(req, res)) return;

    lastShiftChangePayload = req.body;
    debugLog("WEBHOOK HIT: ShiftChange", req.body);

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

      const label = shiftStatusLabel(rawStatus, eventType, subType, item);
      let explicit = inferExplicitOnlineFromShift(rawStatus, eventType, subType, item);

      if (explicit === null && label) {
        const l = label.toLowerCase();
        if (
          l.includes("off shift") ||
          l.includes("off duty") ||
          l.includes("logged off") ||
          l.includes("signed off")
        ) {
          explicit = false;
        } else if (
          l.includes("on shift") ||
          l.includes("on duty") ||
          l.includes("logged on") ||
          l.includes("logged in") ||
          l.includes("signed on")
        ) {
          explicit = true;
        }
      }

      const existing = onlineMap.get(key) || {};

      // 🔑 Only update if this shift change is newer than what we already have
      if (!isNewerTimestamp(ts, existing.updatedAt || null)) {
        continue;
      }

      let rec = {
        ...existing,
        updatedAt: ts,
        lastPingAt: existing.lastPingAt || null,
        driverStatusLabel: label ?? existing.driverStatusLabel ?? existing.driverStatus ?? null,
        driverStatusCode: existing.driverStatusCode ?? null,
        explicitOnline: existing.explicitOnline ?? null,
      };
      rec.driverStatus = rec.driverStatusLabel;

      if (explicit === true) {
        rec.explicitOnline = true;
        rec.lastPingAt = ts;
      } else if (explicit === false) {
        rec.explicitOnline = false;
        rec.lastPingAt = null;
      }

      onlineMap.set(key, rec);
      updates++;
      broadcastStatus(key, rec);

      console.log(
        `ShiftChange: callsign=${key} ts=${ts} rawStatus=${rawStatus} eventType=${eventType} subType=${subType} explicitOnline=${rec.explicitOnline} driverStatus=${rec.driverStatusLabel}`
      );
    }

    if (updates > 0) {
      console.log(`ShiftChange webhook: updated ${updates} vehicles`);
      saveStatusToDisk();
    }

    res.json({ ok: true, updates });
  } catch (e) {
    console.error("ShiftChange webhook error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------- DEBUG INSPECTION ENDPOINTS ----------
app.get("/debug/last-hackney", (_req, res) => {
  res.json({
    received: !!lastHackneyLocationPayload,
    timestamp: new Date().toISOString(),
    payload: lastHackneyLocationPayload,
  });
});

app.get("/debug/last-status", (_req, res) => {
  res.json({
    received: !!lastStatusPayload,
    timestamp: new Date().toISOString(),
    payload: lastStatusPayload,
  });
});

app.get("/debug/last-shiftchange", (_req, res) => {
  res.json({
    received: !!lastShiftChangePayload,
    timestamp: new Date().toISOString(),
    payload: lastShiftChangePayload,
  });
});

// ---------- Public API ----------
app.get("/api/status", (_req, res) => {
  const arr = Array.from(onlineMap.entries()).map(([k, v]) => ({
    callsign: k,
    online: computeOnline(v),
    updatedAt: v.updatedAt || null,
    driverStatus: v.driverStatus || v.driverStatusLabel || null,
    driverStatusCode: v.driverStatusCode || null,
  }));
  res.json({ data: arr, count: arr.length, ts: new Date().toISOString() });
});

// Proxy vehicles from Autocab (and ensure isSuspended is always present/boolean)
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
      console.error("Upstream /vehicles error:", r.status, txt);
      return res.status(r.status).send(txt || `Upstream error: ${r.statusText}`);
    }

    const data = await r.json();

    // ---- NEW: normalize/guarantee isSuspended boolean ----
    // Autocab vehicles include isSuspended; we ensure it is always a boolean for frontend logic.
    const list =
      Array.isArray(data) ? data :
      Array.isArray(data?.items) ? data.items :
      Array.isArray(data?.results) ? data.results :
      Array.isArray(data?.vehicles) ? data.vehicles :
      Array.isArray(data?.data) ? data.data :
      null;

    if (Array.isArray(list)) {
      const normalized = list.map(v => ({
        ...v,
        isSuspended: v?.isSuspended === true,
      }));

      if (Array.isArray(data)) {
        return res.json(normalized);
      }

      // preserve original envelope shape
      if (Array.isArray(data?.items))    return res.json({ ...data, items: normalized });
      if (Array.isArray(data?.results))  return res.json({ ...data, results: normalized });
      if (Array.isArray(data?.vehicles)) return res.json({ ...data, vehicles: normalized });
      if (Array.isArray(data?.data))     return res.json({ ...data, data: normalized });

      return res.json({ ...data, items: normalized });
    }

    // if upstream shape is unknown, just passthrough
    res.json(data);
  } catch (e) {
    console.error("/api/vehicles error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Health & root ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

process.on("SIGTERM", () => {
  try { saveStatusToDisk(); } finally { process.exit(0); }
});
process.on("SIGINT", () => {
  try { saveStatusToDisk(); } finally { process.exit(0); }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`PING timeout: ${PING_TIMEOUT_MINUTES} minute(s).`);
});
