const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 8 * 1024 * 1024 // 8MB, room for small images/files
});

const PORT = process.env.PORT || 4173;
const DATA_FILE = path.join(__dirname, "data", "rooms.json");
const MAX_ITEMS_PER_ROOM = 30;
const ROOM_TTL_MS = 1000 * 60 * 60 * 24 * 14; // rooms idle 14 days get pruned

// --- persistence -----------------------------------------------------
let rooms = {}; // { code: { items: [...], lastActive } }

function loadRooms() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      rooms = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Could not load rooms.json, starting fresh:", e.message);
    rooms = {};
  }
}

let saveTimer = null;
function saveRoomsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(rooms));
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

loadRooms();
setInterval(pruneRooms, 1000 * 60 * 60); // hourly

function getRoom(code) {
  if (!rooms[code]) rooms[code] = { items: [], lastActive: Date.now() };
  return rooms[code];
}

// --- static + basic routes -------------------------------------------
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
io.on("connection", (socket) => {
  let joinedRoom = null;

  socket.on("join", (code, ack) => {
    if (typeof code !== "string" || !/^[A-Z0-9]{4,12}$/.test(code)) {
      if (ack) ack({ ok: false, error: "bad_code" });
      return;
    }
    joinedRoom = code;
    socket.join(code);
    const room = getRoom(code);
    room.lastActive = Date.now();
    if (ack) ack({ ok: true, items: room.items });
    setTimeout(() => io.to(code).emit("presence", roomSize(code)), 50);
  });

  socket.on("push", (payload) => {
    if (!joinedRoom || !payload || typeof payload !== "object") return;
    const room = getRoom(joinedRoom);
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: payload.type === "file" ? "file" : "text",
      text: typeof payload.text === "string" ? payload.text.slice(0, 200000) : undefined,
      fileName: payload.fileName ? String(payload.fileName).slice(0, 200) : undefined,
      fileType: payload.fileType ? String(payload.fileType).slice(0, 100) : undefined,
      dataUrl: payload.dataUrl ? String(payload.dataUrl).slice(0, 8 * 1024 * 1024) : undefined,
      device: payload.device ? String(payload.device).slice(0, 40) : "device",
      ts: Date.now()
    };
    room.items.unshift(item);
    room.items = room.items.slice(0, MAX_ITEMS_PER_ROOM);
    room.lastActive = Date.now();
    saveRoomsSoon();
    io.to(joinedRoom).emit("item", item);
  });

  socket.on("clear", () => {
    if (!joinedRoom) return;
    const room = getRoom(joinedRoom);
    room.items = [];
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
  console.log(`clipsync listening on :${PORT}`);
});
