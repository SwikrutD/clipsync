const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // encrypted payloads are base64(iv + AES-GCM ciphertext) wrapping an
  // already-base64 dataURL for files, so there's real overhead here -
  // 12MB gives headroom for the ~4.5MB file cap after that expansion
  maxHttpBufferSize: 12 * 1024 * 1024,
  // Defaults are 25s/20s, so a dead connection went unnoticed for ~45s and the
  // presence indicator kept claiming everything was fine. 10s/10s halves that
  // at a negligible traffic cost for a handful of sockets per room.
  pingInterval: 10000,
  pingTimeout: 10000
});

const PORT = process.env.PORT || 4173;
// Opt-in, never automatic. Honouring X-Forwarded-For unconditionally would let
// any client spoof its own source address and walk straight past the per-IP
// rate limiter below, so this only turns on when the operator confirms there
// really is a proxy in front of this process.
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ""));
// Opt out of persistence deliberately. Without this, an unwritable data
// directory is a fatal startup error rather than something to shrug at.
const EPHEMERAL = /^(1|true|yes)$/i.test(String(process.env.CLIPSYNC_EPHEMERAL || ""));
const DATA_FILE = path.join(__dirname, "data", "rooms.json");
const MAX_ITEMS_PER_ROOM = 30;
const ROOM_TTL_MS = 1000 * 60 * 60 * 24 * 3; // rooms idle 3 days get pruned
const MAX_ROOMS = 250;
const MAX_ENC_LEN = 10 * 1024 * 1024; // guard against abuse independent of the socket.io frame cap
// Item count alone is not a disk budget: 30 items x 10MB of ciphertext would be
// 300MB for a single room, and rooms.json is rewritten whole on every change.
// Cap the bytes too and drop the oldest items to stay under it.
const MAX_ROOM_BYTES = 32 * 1024 * 1024;

// --- rate limits ------------------------------------------------------
// Token buckets: {capacity, refillPerMs}. Capacity is the burst a normal user
// is allowed; refill is the sustained rate. Numbers are deliberately far above
// anything a person does by hand and far below what a script needs to be a
// nuisance.
const LIMITS = {
  // Per socket.
  join:  { capacity: 12,  refillPerMs: 1 / 3000 },   // ~20/min sustained
  watch: { capacity: 12,  refillPerMs: 1 / 3000 },
  push:  { capacity: 20,  refillPerMs: 1 / 2000 },   // ~30/min sustained
  clear: { capacity: 5,   refillPerMs: 1 / 10000 },
  // Per socket, counted in bytes of ciphertext rather than messages, so one
  // client cannot rebroadcast 10MB blobs as fast as the message limit allows.
  bytes: { capacity: 48 * 1024 * 1024, refillPerMs: 1024 * 1024 / 1000 }, // 1MB/s
  // Per IP. This is the one that matters for secrecy: `join` tells you whether
  // a room code exists and hands you its contents, so it is an oracle for
  // guessing codes - and a guesser would otherwise just open a fresh socket
  // per attempt and sail past any per-socket limit.
  ipJoin: { capacity: 30, refillPerMs: 1 / 2000 }    // ~30/min sustained
};
const MAX_TRACKED_IPS = 20000;

// --- persistence -----------------------------------------------------
let rooms = {}; // { code: { items: [...], lastActive } }

function loadRooms() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      rooms = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (e) {
    // Starting fresh throws away every room on the server. Move the unreadable
    // file aside first so it is at least recoverable by hand instead of being
    // silently overwritten by the next save.
    const quarantine = DATA_FILE + ".corrupt-" + Date.now();
    try {
      fs.renameSync(DATA_FILE, quarantine);
      console.error("rooms.json is unreadable (" + e.message + "); moved to " + quarantine);
    } catch (e2) {
      console.error("rooms.json is unreadable and could not be set aside:", e.message);
    }
    rooms = {};
  }
}

// Write to a sibling temp file and rename over the target. Rename is atomic
// within a filesystem, so a crash mid-save leaves the previous rooms.json
// intact rather than a half-written one that loadRooms() would have to discard.
function saveRoomsNow() {
  if (EPHEMERAL) return;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rooms));
  fs.renameSync(tmp, DATA_FILE);
}

let saveTimer = null;
function saveRoomsSoon() {
  if (saveTimer) return; // already scheduled; coalesce rather than push the write back
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveRoomsNow();
    } catch (e) {
      console.error("Could not save rooms.json:", e.message);
    }
  }, 500);
}

function pruneRooms() {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    if (now - (rooms[code].lastActive || 0) > ROOM_TTL_MS) {
      delete rooms[code];
    }
  }
  saveRoomsSoon();
}

// A data directory the process cannot write is the worst kind of broken: rooms
// work perfectly until the first restart, then everything is gone. It is also
// the single most common way a containerised deploy goes wrong, because the
// volume's owner and the container's user are set in two different places -
// TrueNAS, for one, runs apps as uid 568 while this image's user is 1000.
// Refuse to start rather than pretend to persist.
function requireWritableDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (EPHEMERAL) {
    console.warn("CLIPSYNC_EPHEMERAL is set: rooms are kept in memory only and are lost on restart.");
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-probe");
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (e) {
    const me = typeof process.getuid === "function" ? process.getuid() : "n/a";
    let owner = "unknown";
    try { owner = String(fs.statSync(dir).uid); } catch (e2) { /* dir may not exist */ }
    // One line per call: no escape sequences to get mangled, and it reads
    // the same in a terminal as it does here.
    [
      "",
      "FATAL: cannot write to " + dir + " (" + e.code + ")",
      "",
      "  clipsync runs as uid " + me + ", but that directory is owned by uid " + owner,
      "  and is not writable. Every room would be lost on the next restart, so",
      "  clipsync is stopping instead of pretending to save them.",
      "",
      "  Fix it with either:",
      "    - hand the directory to this uid:    chown -R " + me + ":" + me + " <host path>",
      "    - or run the container as its owner: add  user: \"" + owner + ":" + owner + "\"  to docker-compose.yml",
      "",
      "  Set CLIPSYNC_EPHEMERAL=1 if you genuinely want in-memory-only rooms.",
      ""
    ].forEach(function (line) { console.error(line); });
    process.exit(1);
  }
}

requireWritableDataDir();
loadRooms();
setInterval(pruneRooms, 1000 * 60 * 60); // hourly

function getRoom(code) {
  if (!rooms[code]) {
    if (Object.keys(rooms).length >= MAX_ROOMS) {
      throw new Error("room_limit_reached");
    }
    rooms[code] = { items: [], lastActive: Date.now() };
  }
  return rooms[code];
}

// Non-creating lookup. The push/clear handlers must never construct a room:
// getRoom() throws once the server is at MAX_ROOMS, and an exception thrown
// inside a socket.io listener is an uncaught exception that takes the whole
// process down. Those handlers only ever run after a successful join, so the
// room already exists - and if it was pruned in between, dropping the message
// is the right outcome.
function peekRoom(code) {
  return Object.prototype.hasOwnProperty.call(rooms, code) ? rooms[code] : null;
}

function trimRoom(room) {
  room.items = room.items.slice(0, MAX_ITEMS_PER_ROOM);
  let total = 0;
  const kept = [];
  for (const item of room.items) {
    total += item.enc.length;
    // always keep the newest item, even if it alone blows the budget
    if (total > MAX_ROOM_BYTES && kept.length) break;
    kept.push(item);
  }
  room.items = kept;
}

// --- rate limiting ----------------------------------------------------
// Lazy-refill token buckets. Nothing runs on a timer: a bucket only recomputes
// its level when it is actually consulted, so idle sockets and idle IPs cost
// nothing but the object itself.
function makeBucket(spec) {
  return { tokens: spec.capacity, last: Date.now(), spec };
}

function take(bucket, cost) {
  const now = Date.now();
  const spec = bucket.spec;
  bucket.tokens = Math.min(spec.capacity, bucket.tokens + (now - bucket.last) * spec.refillPerMs);
  bucket.last = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

// Per-IP join buckets outlive any single socket, so they need their own
// bookkeeping. Entries that have refilled to capacity carry no information and
// are dropped, which keeps this map bounded without a fixed expiry.
const ipBuckets = new Map();

function sweepIpBuckets() {
  const now = Date.now();
  for (const [ip, bucket] of ipBuckets) {
    const level = bucket.tokens + (now - bucket.last) * bucket.spec.refillPerMs;
    if (level >= bucket.spec.capacity) ipBuckets.delete(ip);
  }
}

function ipMayJoin(ip) {
  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    if (ipBuckets.size >= MAX_TRACKED_IPS) {
      sweepIpBuckets();
      // Still full after a sweep means a distributed flood. Refuse rather than
      // fail open - failing open is exactly the state an attacker would aim for.
      if (ipBuckets.size >= MAX_TRACKED_IPS) return false;
    }
    bucket = makeBucket(LIMITS.ipJoin);
    ipBuckets.set(ip, bucket);
  }
  return take(bucket, 1);
}

// Unref'd: this is housekeeping, it should never be the reason the process
// stays alive.
setInterval(sweepIpBuckets, 1000 * 60 * 5).unref();

function clientIp(socket) {
  if (TRUST_PROXY) {
    const fwd = socket.handshake.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  }
  return socket.handshake.address || "unknown";
}

// --- security headers -------------------------------------------------
// Everything the page loads now comes from this origin (see scripts/vendor.js),
// so script-src can be locked to 'self' with no CDN escape hatch. 'unsafe-inline'
// stays on style-src only because the markup still uses inline style attributes.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // 'self' already covers same-origin ws:// and wss:// under CSP3. The old
  // `ws: wss:` allowed a websocket to *any* host, which is a strange hole to
  // leave in a tool that vendors its assets specifically to avoid third parties.
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'"
].join("; ");

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// --- static + basic routes -------------------------------------------
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.send("ok"));

// room links look like /r/AB3F9K - just serve the SPA, JS reads the code from the URL
app.get("/r/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function roomSize(code) {
  const set = io.sockets.adapter.rooms.get(code);
  return set ? set.size : 0;
}

// --- socket handling ---------------------------------------------------
// Two ways a socket can be attached to a room code:
//   join  - a real member. Receives items, counts toward presence.
//   watch - a device sitting on the pairing screen with that room's QR code on
//           screen, waiting for someone to scan it. Watchers live in a separate
//           "watch:CODE" room so they never show up in the presence count and
//           never see item traffic; all they get is a nudge when the first real
//           member joins, which is what lets the displaying device follow its
//           own QR code into the room automatically.
const WATCH_PREFIX = "watch:";
const CODE_RE = /^[A-Z0-9]{4,12}$/;

io.on("connection", (socket) => {
  let joinedRoom = null;
  let watchedRoom = null;

  const ip = clientIp(socket);
  const buckets = {
    join: makeBucket(LIMITS.join),
    watch: makeBucket(LIMITS.watch),
    push: makeBucket(LIMITS.push),
    clear: makeBucket(LIMITS.clear),
    bytes: makeBucket(LIMITS.bytes)
  };

  function stopWatching() {
    if (watchedRoom) {
      socket.leave(WATCH_PREFIX + watchedRoom);
      watchedRoom = null;
    }
  }

  socket.on("join", (code, ack) => {
    if (typeof code !== "string" || !CODE_RE.test(code)) {
      if (ack) ack({ ok: false, error: "bad_code" });
      return;
    }
    // Rejoining the room you are already in is free - a reconnect does exactly
    // that, and a flaky connection should not spend its budget on staying put.
    if (code !== joinedRoom && (!take(buckets.join, 1) || !ipMayJoin(ip))) {
      if (ack) ack({ ok: false, error: "rate_limited" });
      return;
    }

    let room;
    try {
      room = getRoom(code);
    } catch (e) {
      if (ack) ack({ ok: false, error: "room_limit_reached" });
      return;
    }

    // Leave whatever we were in first, otherwise a socket that switches rooms
    // keeps receiving items from the old one and keeps inflating its presence.
    const previous = joinedRoom;
    if (previous && previous !== code) socket.leave(previous);
    stopWatching();

    joinedRoom = code;
    socket.join(code);
    room.lastActive = Date.now();
    if (ack) ack({ ok: true, items: room.items });

    setTimeout(() => {
      io.to(code).emit("presence", roomSize(code));
      if (previous && previous !== code) io.to(previous).emit("presence", roomSize(previous));
    }, 50);

    // Wake up any device showing this room's QR code.
    io.to(WATCH_PREFIX + code).emit("peer-joined", code);
  });

  // Deliberately does not call getRoom(): watching must not create a room, or
  // a device idling on the pairing screen would burn a slot against MAX_ROOMS
  // for a room nobody ever joins.
  socket.on("watch", (code, ack) => {
    if (typeof code !== "string" || !CODE_RE.test(code)) {
      if (ack) ack({ ok: false, error: "bad_code" });
      return;
    }
    if (watchedRoom === code) {
      if (ack) ack({ ok: true, occupied: roomSize(code) > 0 });
      return;
    }
    if (!take(buckets.watch, 1)) {
      if (ack) ack({ ok: false, error: "rate_limited" });
      return;
    }
    stopWatching();
    watchedRoom = code;
    socket.join(WATCH_PREFIX + code);
    // If someone scanned in the gap between page load and this subscription,
    // the room is already occupied and the watcher should follow immediately.
    if (ack) ack({ ok: true, occupied: roomSize(code) > 0 });
  });

  socket.on("unwatch", () => stopWatching());

  socket.on("push", (payload) => {
    if (!joinedRoom || !payload || typeof payload !== "object") return;
    // enc is base64(iv + AES-GCM ciphertext). The key is derived client-side
    // with PBKDF2 from the room code itself, which the server necessarily sees
    // in order to route messages - so this is protection against network
    // snooping and against casual reads of rooms.json on disk, NOT against the
    // operator of this server. See the matching note in public/app.js.
    if (typeof payload.enc !== "string" || !payload.enc.length || payload.enc.length > MAX_ENC_LEN) return;
    if (!take(buckets.push, 1) || !take(buckets.bytes, payload.enc.length)) return;
    const room = peekRoom(joinedRoom);
    if (!room) return;
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: payload.type === "file" ? "file" : "text",
      enc: payload.enc,
      device: payload.device ? String(payload.device).slice(0, 40) : "device",
      ts: Date.now()
    };
    room.items.unshift(item);
    trimRoom(room);
    room.lastActive = Date.now();
    saveRoomsSoon();
    io.to(joinedRoom).emit("item", item);
  });

  socket.on("clear", () => {
    if (!joinedRoom) return;
    if (!take(buckets.clear, 1)) return;
    const room = peekRoom(joinedRoom);
    if (!room) return;
    room.items = [];
    room.lastActive = Date.now();
    saveRoomsSoon();
    io.to(joinedRoom).emit("cleared");
  });

  socket.on("disconnect", () => {
    if (joinedRoom) {
      setTimeout(() => io.to(joinedRoom).emit("presence", roomSize(joinedRoom)), 50);
    }
  });
});

server.listen(PORT, () => {
  console.log(`clipsync listening on :${PORT}${TRUST_PROXY ? " (trusting X-Forwarded-For)" : ""}`);
});

// --- shutdown ----------------------------------------------------------
// Saves are debounced by up to 500ms, so a container restart would otherwise
// drop whatever landed in that window. Flush synchronously before exiting.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, flushing rooms and shutting down`);
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    saveRoomsNow();
  } catch (e) {
    console.error("Final save failed:", e.message);
  }
  io.close();
  server.close(() => process.exit(0));
  // Don't let a lingering websocket hold the process open past the container's
  // grace period; unref'd so it never keeps us alive on its own.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
