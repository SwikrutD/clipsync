(function(){
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "clipsync_room";   // the last room code used
  const THEME_KEY = "clipsync_theme";
  const QR_PANEL_KEY = "clipsync_qr_open";

  function randomCode(len=6){
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
    const picks = crypto.getRandomValues(new Uint32Array(len));
    let s = "";
    for(let i=0;i<len;i++) s += alphabet[picks[i] % alphabet.length];
    return s;
  }

  function deviceLabel(){
    const ua = navigator.userAgent;
    if(/iPhone/.test(ua)) return "iPhone";
    if(/iPad/.test(ua)) return "iPad";
    if(/Android/.test(ua)) return "Android";
    if(/Win/.test(ua)) return "Windows";
    if(/Mac/.test(ua)) return "Mac";
    if(/Linux/.test(ua)) return "Linux";
    return "device";
  }

  // ---------- base64url ----------
  function bufToB64(buf){
    let binary = "";
    const bytes = new Uint8Array(buf);
    for(let i=0;i<bytes.byteLength;i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function b64ToBytes(b64){
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // ---------- room identity ----------
  // The room code is the whole secret and also the routing address, so the
  // server necessarily receives it. Accepts a bare code or a full room link,
  // so pasting either into the join box works.
  function roomUrl(code){
    return location.origin + "/r/" + code;
  }

  function parseRoomCode(input){
    const text = (input || "").trim();
    if(!text) return null;
    if(/^[A-Z0-9]{4,12}$/i.test(text)) return text.toUpperCase();
    try{
      const u = new URL(text, location.origin);
      const m = u.pathname.match(/\/r\/([A-Z0-9]{4,12})/i);
      if(m) return m[1].toUpperCase();
      const q = u.searchParams.get("r");
      if(q && /^[A-Z0-9]{4,12}$/i.test(q)) return q.toUpperCase();
    }catch(e){ /* not a URL */ }
    return null;
  }

  // ---------- theme ----------
  function applyTheme(theme){
    document.documentElement.setAttribute("data-theme", theme);
    const btn = $("themeToggle");
    if(btn){
      btn.textContent = theme === "dark" ? "☀️" : "🌙";
      btn.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    }
    try{ localStorage.setItem(THEME_KEY, theme); }catch(e){}
  }
  let storedTheme = null;
  try{ storedTheme = localStorage.getItem(THEME_KEY); }catch(e){}
  applyTheme(storedTheme
    || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("themeToggle").onclick = () => {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  };

  // ---------- secure-context gate ----------
  // crypto.subtle exists only in a secure context: HTTPS, or localhost. Reached
  // over plain HTTP on a LAN address or a bare domain - which is exactly how a
  // self-hosted instance usually gets opened first - it is undefined, and every
  // send used to die on an unhandled `undefined.importKey` with nothing shown to
  // the user: the app looked completely healthy and silently dropped everything.
  // Fail loudly and explain the fix instead.
  if(!(window.crypto && window.crypto.subtle)){
    const warn = $("insecureWarning");
    $("insecureOrigin").textContent = location.origin;
    $("insecureLocal").textContent = "http://localhost:" + (location.port || "4173");
    warn.hidden = false;
    $("pairScreen").hidden = true;
    $("app").hidden = true;
    document.querySelector(".footer-note").hidden = true;
    return;
  }

  // ---------- notices (replaces alert()) ----------
  // alert()/confirm() block the whole page, and the most common failure here -
  // a browser that won't hand over the clipboard - is an *expected* path on
  // Safari and Firefox, not an exception. Blocking the UI for it is wrong.
  let noticeTimer = null;
  function showNotice(message, tone){
    const el = $("notice");
    if(!el) return;
    el.textContent = message;
    el.dataset.tone = tone || "info";
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }
  function clearNotice(){
    const el = $("notice");
    if(el) el.hidden = true;
    clearTimeout(noticeTimer);
  }

  // ---------- crypto ----------
  // The key comes from the room code alone. That means the server, which
  // receives the code in order to route messages, can derive this key too -
  // this is encryption against network snooping and casual disk access, not
  // against the server operator. PBKDF2 is still worth its cost: it takes
  // offline grinding of stolen ciphertext from instant to expensive.
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const PBKDF2_ITERATIONS = 250000;
  let keyPromise = null;
  let keyPromiseFor = null;

  function getKey(code){
    if(keyPromise && keyPromiseFor === code) return keyPromise;
    keyPromiseFor = code;
    keyPromise = crypto.subtle
      .importKey("raw", textEncoder.encode(code), "PBKDF2", false, ["deriveKey"])
      .then((base) => crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: textEncoder.encode("clipsync:v2:" + code),
          iterations: PBKDF2_ITERATIONS,
          hash: "SHA-256"
        },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      ));
    return keyPromise;
  }

  async function encryptPayload(room, obj){
    const key = await getKey(room);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = textEncoder.encode(JSON.stringify(obj));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.byteLength);
    return bufToB64(combined.buffer);
  }

  async function decryptPayload(room, b64){
    const key = await getKey(room);
    const combined = b64ToBytes(b64);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(textDecoder.decode(plainBuf));
  }

  const pairScreen = $("pairScreen");
  const app = $("app");
  let pendingCode = randomCode();
  $("newCode").textContent = pendingCode;

  function renderQR(host, url, code, size){
    if(!host) return;
    host.innerHTML = "";
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    // QR decoding requires a 4-module light "quiet zone" around the symbol
    // (ISO/IEC 18004). With margin 0 the modules ran flush to the edge of the
    // library's white background rect, and in dark mode the card behind it is
    // near-black - putting the code in exactly the tight high-contrast frame
    // that scanners struggle with. The library measures margin in units, not
    // modules, so the quiet zone is 4 * cellSize; drawing it inside the SVG
    // keeps it correct whatever colour the card behind it happens to be.
    const CELL = 4;
    host.innerHTML = qr.createSvgTag({ cellSize: CELL, margin: 4 * CELL, scalable: true });
    const svg = host.querySelector("svg");
    if(svg){
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "QR code linking to room " + code);
    }
  }

  let socket = null;
  let currentRoom = null; // the room code once we are in a room
  let watchCode = null;   // room whose QR is showing on the pairing screen
  let joined = false;     // the server has acknowledged our join

  // Anything composed while the connection is down waits here.
  //
  // socket.io buffers emits made while disconnected and flushes them the moment
  // the transport reconnects - which is *before* our own "connect" handler gets
  // to re-join the room. The server drops a push from a socket that is not in a
  // room, so those messages vanished silently: composer cleared, no error, never
  // delivered. Holding them here and sending them after the join is
  // acknowledged is the difference between "sent" and "gone".
  const MAX_OUTBOX = 20;
  let outbox = [];

  function transmit(payload){
    if(socket && socket.connected && joined){
      socket.emit("push", payload);
      return true;
    }
    outbox.push(payload);
    if(outbox.length > MAX_OUTBOX) outbox.shift();
    return false;
  }

  function flushOutbox(){
    if(!outbox.length) return;
    const queued = outbox;
    outbox = [];
    for(const payload of queued) socket.emit("push", payload);
    showNotice(queued.length === 1
      ? "Back online — your queued item was sent."
      : `Back online — ${queued.length} queued items were sent.`, "info");
  }

  // One socket for the whole page life. It is opened on the pairing screen too
  // (to watch for a scan) and simply re-used on join, so a reconnect never
  // strands us: the connect handler re-establishes whichever of the two
  // subscriptions is current.
  function ensureSocket(){
    if(socket) return socket;
    socket = io({ transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      if(currentRoom) sendJoin();
      else if(watchCode) sendWatch();
    });
    socket.on("disconnect", () => {
      joined = false;
      if(currentRoom) setPresence(null);
    });
    socket.on("item", (item) => { if(currentRoom) prependItem(item); });
    socket.on("cleared", () => {
      if(!currentRoom) return;
      $("list").innerHTML = "";
      renderEmptyIfNeeded();
    });
    socket.on("presence", (count) => { if(currentRoom) setPresence(count); });
    socket.on("peer-joined", (code) => followScan(code));
    return socket;
  }

  function sendJoin(){
    socket.emit("join", currentRoom, (res) => {
      if(!res || !res.ok){
        const reason = res && res.error;
        showNotice(
          reason === "room_limit_reached" ? "This server is at its room limit right now. Try again shortly." :
          reason === "rate_limited" ? "Too many join attempts from here. Wait a moment and try again." :
          "Couldn't join that room.", "error");
        return;
      }
      joined = true;
      renderList(res.items || []);
      flushOutbox();
    });
  }

  // ---------- follow-your-own-QR ----------
  // While the pairing screen is up we subscribe to the displayed room code as a
  // watcher (no presence, no items). The moment a scanning device actually
  // joins, the server nudges us and we walk into the same room - so scanning
  // the QR on your laptop with your phone pairs *both* ends, instead of leaving
  // the laptop sitting on a screen it already told you to scan.
  function sendWatch(){
    socket.emit("watch", watchCode, (res) => {
      if(res && res.ok && res.occupied) followScan(watchCode);
    });
  }

  function startWatch(code){
    watchCode = code;
    ensureSocket();
    if(socket.connected) sendWatch();
  }

  function stopWatch(){
    if(watchCode && socket && socket.connected) socket.emit("unwatch");
    watchCode = null;
  }

  function followScan(code){
    if(currentRoom || !watchCode || code !== watchCode) return;
    enterRoom(code);
    showNotice("Another device scanned the code — this one joined room " + code + " too.", "info");
  }

  // ---------- in-room QR panel ----------
  let qrPanelOpen = true;
  try{ qrPanelOpen = localStorage.getItem(QR_PANEL_KEY) !== "0"; }catch(e){}

  function setQrPanel(open){
    qrPanelOpen = open;
    $("roomQrPanel").hidden = !open;
    const btn = $("roomQrToggle");
    btn.textContent = open ? "hide QR" : "show QR";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    try{ localStorage.setItem(QR_PANEL_KEY, open ? "1" : "0"); }catch(e){}
  }

  $("roomQrToggle").onclick = () => setQrPanel(!qrPanelOpen);

  function enterRoom(code){
    code = (code || "").toUpperCase().trim();
    if(!/^[A-Z0-9]{4,12}$/.test(code)){
      showNotice("Room codes are 4-12 letters or numbers.", "error");
      return;
    }
    clearNotice();
    stopWatch();
    if(code !== currentRoom) outbox = [];
    joined = false;
    currentRoom = code;
    try{ localStorage.setItem(STORAGE_KEY, code); }catch(e){}
    history.replaceState(null, "", "/r/" + code);
    pairScreen.hidden = true;
    app.hidden = false;
    $("roomLabel").textContent = code;
    renderQR($("roomQr"), roomUrl(code), code, 168);
    $("roomQrCode").textContent = code;
    $("roomQrUrl").textContent = location.host;
    setQrPanel(qrPanelOpen);

    ensureSocket();
    if(socket.connected) sendJoin();
  }

  function setPresence(count){
    const el = $("presence");
    if(count === null){
      el.hidden = false;
      $("presenceCount").textContent = "reconnecting…";
      return;
    }
    el.hidden = false;
    $("presenceCount").textContent = count + (count === 1 ? " device" : " devices");
  }

  // ---------- rendering ----------
  function fmtTime(ts){
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function renderEmptyIfNeeded(){
    const list = $("list");
    if(!list.children.length){
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = "Nothing sent yet — paste or type above to send it to every device in this room.";
      list.appendChild(div);
    }
  }

  async function decorateItem(item){
    try{
      const payload = await decryptPayload(currentRoom, item.enc);
      return Object.assign({}, item, payload);
    }catch(e){
      return Object.assign({}, item, {
        type: "text",
        text: "⚠️ Could not decrypt this item — it was sent with a different room key.",
        undecryptable: true
      });
    }
  }

  async function renderList(items){
    const list = $("list");
    list.innerHTML = "";
    if(!items.length){ renderEmptyIfNeeded(); return; }
    for(const item of items){
      list.appendChild(buildItemEl(await decorateItem(item)));
    }
  }

  async function prependItem(item){
    const list = $("list");
    const empty = list.querySelector(".empty");
    if(empty) empty.remove();
    list.prepend(buildItemEl(await decorateItem(item)));
  }

  function buildItemEl(item){
    const div = document.createElement("div");
    div.className = "item";
    const meta = document.createElement("div");
    meta.className = "item-meta";
    const metaSpan = document.createElement("span");
    metaSpan.textContent = (item.device || "device") + " · " + fmtTime(item.ts);
    meta.appendChild(metaSpan);
    div.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "item-actions";

    // Only ever hand a data: URL to <img src> / <a href>. The payload is
    // decrypted room content, but "someone else in the room" is not the same
    // trust level as "this page's own code" - a javascript: URL smuggled in
    // here would run on click, so refuse anything that is not a data: URL.
    const dataUrl = typeof item.dataUrl === "string" && /^data:/i.test(item.dataUrl)
      ? item.dataUrl
      : null;

    if(item.type === "file" && !item.undecryptable && dataUrl){
      if(item.fileType && item.fileType.startsWith("image/")){
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = item.fileName || "Shared image";
        div.appendChild(img);
      } else {
        const p = document.createElement("div");
        p.className = "item-text";
        p.textContent = "📎 " + (item.fileName || "file");
        div.appendChild(p);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "small";
      btn.textContent = "Save to device";
      btn.onclick = () => {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = item.fileName || "file";
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
      actions.appendChild(btn);
    } else {
      const p = document.createElement("div");
      p.className = "item-text";
      p.textContent = item.type === "file"
        ? "⚠️ Dropped a file attachment that wasn't in a readable format."
        : (item.text || "");
      div.appendChild(p);
      if(!item.undecryptable){
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "small primary";
        btn.textContent = "Copy";
        btn.onclick = () => copyText(item.text, btn);
        actions.appendChild(btn);
      }
    }

    if(actions.children.length) div.appendChild(actions);
    return div;
  }

  // ---------- clipboard ----------
  const canWriteClipboard = !!(navigator.clipboard && navigator.clipboard.writeText);
  const canReadClipboard = !!(navigator.clipboard && navigator.clipboard.readText);

  async function copyText(text, btn){
    if(canWriteClipboard){
      try{
        await navigator.clipboard.writeText(text);
        flash(btn, "Copied ✓");
        return;
      }catch(e){ /* fall through to the selection fallback */ }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try{ ok = document.execCommand("copy"); }catch(e2){ ok = false; }
    ta.remove();
    if(ok){
      flash(btn, "Copied ✓");
    }else{
      flash(btn, "Copy failed");
      showNotice("Your browser blocked the copy. Select the text and copy it manually.", "error");
    }
  }

  function flash(btn, label){
    const original = btn.dataset.label || btn.textContent;
    btn.dataset.label = original;
    btn.textContent = label;
    btn.classList.add("copied-flash");
    setTimeout(() => {
      btn.textContent = btn.dataset.label || original;
      btn.classList.remove("copied-flash");
    }, 1400);
  }

  // ---------- sending ----------
  async function sendText(text){
    text = (text || "").trim();
    if(!text || !socket || !currentRoom) return false;
    const enc = await encryptPayload(currentRoom, { text });
    const sent = transmit({ type: "text", enc, device: deviceLabel() });
    $("composer").value = "";
    if(!sent) showNotice("You're offline — this will send as soon as you reconnect.", "info");
    return true;
  }

  function sendFile(file){
    if(!file || !currentRoom) return;
    if(file.size > 4.5 * 1024 * 1024){
      showNotice("That file is over the ~4.5MB limit.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => showNotice("Couldn't read that file.", "error");
    reader.onload = async () => {
      try{
        const enc = await encryptPayload(currentRoom, {
          fileName: file.name,
          fileType: file.type,
          dataUrl: reader.result
        });
        if(!transmit({ type: "file", enc, device: deviceLabel() })){
          showNotice("You're offline — this file will send as soon as you reconnect.", "info");
        }
      }catch(e){
        showNotice("Couldn't encrypt that file.", "error");
      }
    };
    reader.readAsDataURL(file);
  }

  document.addEventListener("paste", (e) => {
    if(app.hidden) return;
    const items = e.clipboardData && e.clipboardData.items;
    if(items){
      for(const it of items){
        if(it.type.startsWith("image/")){
          sendFile(it.getAsFile());
          return;
        }
      }
    }
    const text = e.clipboardData ? e.clipboardData.getData("text") : "";
    if(text){
      e.preventDefault();
      sendText(text);
    }
  });

  $("sendBtn").onclick = () => sendText($("composer").value);
  $("composer").addEventListener("keydown", (e) => {
    if(e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendText($("composer").value);
  });
  $("fileBtn").onclick = () => $("fileInput").click();
  $("fileInput").addEventListener("change", (e) => {
    sendFile(e.target.files[0]);
    e.target.value = "";
  });

  // "Send my clipboard". Reading the clipboard is a privilege plenty of
  // browsers simply don't grant - Firefox and Safari have no readText() for
  // pages at all - so hide the button rather than offer something that can
  // only fail, and keep the paste path advertised as the reliable route.
  const sendClipboardBtn = $("sendClipboardBtn");
  if(!canReadClipboard){
    sendClipboardBtn.hidden = true;
  } else {
    sendClipboardBtn.onclick = async () => {
      try{
        if(navigator.clipboard.read){
          try{
            const items = await navigator.clipboard.read();
            for(const item of items){
              for(const type of item.types){
                if(type.startsWith("image/")){
                  const blob = await item.getType(type);
                  sendFile(new File([blob], "clipboard-image.png", { type }));
                  flash(sendClipboardBtn, "Sent ✓");
                  return;
                }
              }
            }
          }catch(imgErr){ /* fall through to text */ }
        }
        const text = await navigator.clipboard.readText();
        if(text){
          await sendText(text);
          flash(sendClipboardBtn, "Sent ✓");
        }else{
          showNotice("Your clipboard is empty.", "info");
        }
      }catch(e){
        showNotice("Your browser wouldn't hand over the clipboard. Paste into the box above instead — it sends automatically.", "error");
      }
    };
  }

  // ---------- pairing ----------
  renderQR($("qr"), roomUrl(pendingCode), pendingCode, 188);
  $("startBtn").onclick = () => enterRoom(pendingCode);

  function joinFromInput(){
    const code = parseRoomCode($("joinInput").value);
    if(!code){
      showNotice("Enter the room code shown on your other device.", "error");
      return;
    }
    enterRoom(code);
  }
  $("joinBtn").onclick = joinFromInput;
  $("joinInput").addEventListener("keydown", (e) => { if(e.key === "Enter") joinFromInput(); });

  async function shareRoom(code, btn){
    const url = roomUrl(code);
    if(navigator.share){
      try{ await navigator.share({ title: "clipsync room", url }); return; }catch(e){}
    }
    copyText(url, btn);
  }
  $("shareBtn").onclick = () => shareRoom(pendingCode, $("shareBtn"));
  $("roomShareBtn").onclick = () => shareRoom(currentRoom, $("roomShareBtn"));
  $("roomCopyCodeBtn").onclick = () => copyText(currentRoom, $("roomCopyCodeBtn"));

  $("leaveBtn").onclick = () => {
    try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
    location.href = "/";
  };

  // Inline confirm instead of window.confirm() - same two-step safety, no
  // frozen page.
  const clearBtn = $("clearBtn");
  const clearConfirm = $("clearConfirm");
  clearBtn.onclick = () => {
    clearConfirm.hidden = false;
    $("clearYes").focus();
  };
  $("clearNo").onclick = () => { clearConfirm.hidden = true; clearBtn.focus(); };
  $("clearYes").onclick = () => {
    if(socket) socket.emit("clear");
    clearConfirm.hidden = true;
    clearBtn.focus();
  };
  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape" && !clearConfirm.hidden){
      clearConfirm.hidden = true;
      clearBtn.focus();
    }
  });

  // The socket only notices a dead network when its ping times out, which by
  // default takes tens of seconds - a long time to show a confident "2 devices"
  // to someone whose wifi just dropped. The browser knows immediately, so use
  // that for the indicator and let the socket catch up in its own time.
  window.addEventListener("offline", () => { if(currentRoom){ joined = false; setPresence(null); } });
  window.addEventListener("online", () => {
    if(!currentRoom || !socket) return;
    if(socket.connected){
      // A short outage can end before the ping timeout notices, leaving a
      // perfectly live socket behind a "reconnecting" label with nothing left
      // to fire and clear it. Re-joining is idempotent, costs no rate-limit
      // budget for the room we are already in, and makes the server re-broadcast
      // presence - which puts the indicator back in step with reality.
      sendJoin();
    } else {
      socket.connect();
    }
  });

  // ---------- service worker ----------
  // Makes the app installable and lets the pairing screen render without a
  // network. Service workers only run on a secure context, and localhost counts
  // as one - registering unconditionally would just log a console error on a
  // plain-http LAN deployment, which is a perfectly reasonable way to run this.
  if("serviceWorker" in navigator && window.isSecureContext){
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* not fatal - the app works fine without it */
      });
    });
  }

  // ---------- boot ----------
  const fromUrl = parseRoomCode(location.href);
  if(fromUrl){
    enterRoom(fromUrl);
  } else {
    // Older builds stored {code, secret}; tolerate both shapes so an upgrade
    // doesn't strand anyone on the pairing screen.
    let saved = null;
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      saved = raw && raw.charAt(0) === "{" ? (JSON.parse(raw) || {}).code : raw;
    }catch(e){}
    if(saved){
      enterRoom(saved);
    } else {
      // Pairing screen is up, so listen for someone scanning the QR we drew.
      startWatch(pendingCode);
    }
  }
})();
