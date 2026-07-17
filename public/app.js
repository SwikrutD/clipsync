(function(){
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "clipsync_room";
  const THEME_KEY = "clipsync_theme";

  function randomCode(len=6){
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
    let s = "";
    for(let i=0;i<len;i++) s += alphabet[Math.floor(Math.random()*alphabet.length)];
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

  function roomFromUrl(){
    const m = location.pathname.match(/\/r\/([A-Z0-9]{4,12})/i);
    if(m) return m[1].toUpperCase();
    const q = new URLSearchParams(location.search).get("r");
    if(q) return q.toUpperCase();
    return null;
  }

  // ---------- theme ----------
  function applyTheme(theme){
    document.documentElement.setAttribute("data-theme", theme);
    const btn = $("themeToggle");
    if(btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
    localStorage.setItem(THEME_KEY, theme);
  }
  const initialTheme = localStorage.getItem(THEME_KEY)
    || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(initialTheme);
  $("themeToggle").onclick = () => {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  };

  // ---------- crypto ----------
  // Every device derives the same AES-GCM key from the room code alone.
  // The server only ever sees base64(iv + ciphertext) - it can relay and
  // persist items without ever being able to read them.
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  let keyPromise = null;

  function getKey(roomCode){
    if(!keyPromise){
      keyPromise = crypto.subtle.digest("SHA-256", textEncoder.encode(roomCode)).then((hash) =>
        crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
      );
    }
    return keyPromise;
  }

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

  async function encryptPayload(roomCode, obj){
    const key = await getKey(roomCode);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = textEncoder.encode(JSON.stringify(obj));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.byteLength);
    return bufToB64(combined.buffer);
  }

  async function decryptPayload(roomCode, b64){
    const key = await getKey(roomCode);
    const combined = b64ToBytes(b64);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(textDecoder.decode(plainBuf));
  }

  const pairScreen = $("pairScreen");
  const app = $("app");
  const newCodeEl = $("newCode");
  let pendingCode = randomCode();
  newCodeEl.textContent = pendingCode;

  function renderQR(code){
    $("qr").innerHTML = "";
    new QRCode($("qr"), {
      text: location.origin + "/r/" + code,
      width: 148, height: 148,
      colorDark: "#141414", colorLight: "#ffffff"
    });
  }
  renderQR(pendingCode);

  let socket = null;
  let currentRoom = null;

  function enterRoom(code){
    code = code.toUpperCase().trim();
    if(!/^[A-Z0-9]{4,12}$/.test(code)){ alert("Room codes are 4-12 letters/numbers."); return; }
    currentRoom = code;
    keyPromise = null; // fresh key derivation for this room
    localStorage.setItem(STORAGE_KEY, code);
    history.replaceState(null, "", "/r/" + code);
    pairScreen.style.display = "none";
    app.style.display = "block";
    $("roomLabel").textContent = code;
    connect(code);
    setupPush();
  }

  function connect(code){
    if(socket) socket.disconnect();
    socket = io({ transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      socket.emit("join", code, (res) => {
        if(!res || !res.ok){ return; }
        renderList(res.items || []);
      });
    });
    socket.on("item", (item) => prependItem(item));
    socket.on("cleared", () => { $("list").innerHTML = ""; renderEmptyIfNeeded(); });
    socket.on("presence", (count) => {
      $("presence").style.display = "flex";
      $("presenceCount").textContent = count + (count === 1 ? " device" : " devices");
    });
  }

  // ---------- rendering ----------
  function fmtTime(ts){
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function renderEmptyIfNeeded(){
    const list = $("list");
    if(!list.children.length){
      list.innerHTML = '<div class="empty">Nothing sent yet — paste or type above to send it to every device in this room.</div>';
    }
  }

  async function decorateItem(item){
    try{
      const payload = await decryptPayload(currentRoom, item.enc);
      return Object.assign({}, item, payload);
    }catch(e){
      return Object.assign({}, item, { type: "text", text: "⚠️ Could not decrypt this item." });
    }
  }

  async function renderList(items){
    const list = $("list");
    list.innerHTML = "";
    if(!items.length){ renderEmptyIfNeeded(); return; }
    for(const item of items){
      appendItemEl(await decorateItem(item));
    }
  }

  async function prependItem(item){
    const list = $("list");
    const empty = list.querySelector(".empty");
    if(empty) empty.remove();
    const decorated = await decorateItem(item);
    list.prepend(buildItemEl(decorated));
  }
  function appendItemEl(item){
    $("list").appendChild(buildItemEl(item));
  }

  function buildItemEl(item){
    const div = document.createElement("div");
    div.className = "item";
    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.innerHTML = `<span>${item.device || "device"} · ${fmtTime(item.ts)}</span>`;
    div.appendChild(meta);

    if(item.type === "file"){
      if(item.fileType && item.fileType.startsWith("image/")){
        const img = document.createElement("img");
        img.src = item.dataUrl;
        div.appendChild(img);
      } else {
        const p = document.createElement("div");
        p.className = "item-text";
        p.textContent = "📎 " + (item.fileName || "file");
        div.appendChild(p);
      }
      const actions = document.createElement("div");
      actions.className = "item-actions";
      const btn = document.createElement("button");
      btn.className = "small";
      btn.textContent = "Save to device";
      btn.onclick = () => {
        const a = document.createElement("a");
        a.href = item.dataUrl; a.download = item.fileName || "file";
        document.body.appendChild(a); a.click(); a.remove();
      };
      actions.appendChild(btn);
      div.appendChild(actions);
    } else {
      const p = document.createElement("div");
      p.className = "item-text";
      p.textContent = item.text || "";
      div.appendChild(p);
      const actions = document.createElement("div");
      actions.className = "item-actions";
      const btn = document.createElement("button");
      btn.className = "small primary";
      btn.textContent = "Copy";
      btn.onclick = () => copyText(item.text, btn);
      actions.appendChild(btn);
      div.appendChild(actions);
    }
    return div;
  }

  async function copyText(text, btn){
    try{
      await navigator.clipboard.writeText(text);
      flash(btn, "Copied ✓");
    }catch(e){
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try{ document.execCommand("copy"); flash(btn, "Copied ✓"); }
      catch(e2){ flash(btn, "Select & copy manually"); }
      ta.remove();
    }
  }
  function flash(btn, label){
    const original = btn.textContent;
    btn.textContent = label;
    btn.classList.add("copied-flash");
    setTimeout(() => { btn.textContent = original; btn.classList.remove("copied-flash"); }, 1400);
  }

  // ---------- sending ----------
  async function sendText(text){
    text = (text || "").trim();
    if(!text || !socket || !currentRoom) return;
    const enc = await encryptPayload(currentRoom, { text });
    socket.emit("push", { type: "text", enc, device: deviceLabel() });
    $("composer").value = "";
  }

  function sendFile(file){
    if(!file || !currentRoom) return;
    if(file.size > 4.5 * 1024 * 1024){ alert("Keep files under ~4.5MB for now."); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const enc = await encryptPayload(currentRoom, {
        fileName: file.name,
        fileType: file.type,
        dataUrl: reader.result
      });
      socket.emit("push", { type: "file", enc, device: deviceLabel() });
    };
    reader.readAsDataURL(file);
  }

  // paste anywhere on the page auto-sends (text or image)
  document.addEventListener("paste", (e) => {
    if(app.style.display === "none") return;
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
  $("fileInput").addEventListener("change", (e) => sendFile(e.target.files[0]));

  // "Send my clipboard" - a single tap, no need to focus/paste into the textarea.
  // Deliberately makes exactly ONE clipboard API call so the browser's native
  // permission popup fires once, not twice (calling read() then readText()
  // back to back can suppress or duplicate that prompt in some browsers).
  $("sendClipboardBtn").onclick = async () => {
    const btn = $("sendClipboardBtn");
    try{
      if(navigator.clipboard.read){
        const items = await navigator.clipboard.read(); // <- triggers the permission popup here
        for(const item of items){
          for(const type of item.types){
            if(type.startsWith("image/")){
              const blob = await item.getType(type);
              sendFile(new File([blob], "clipboard-image.png", { type }));
              flash(btn, "Sent ✓");
              return;
            }
          }
        }
        for(const item of items){
          if(item.types.includes("text/plain")){
            const blob = await item.getType("text/plain");
            const text = (await blob.text()).trim();
            if(text){
              await sendText(text);
              flash(btn, "Sent ✓");
              return;
            }
          }
        }
        alert("Clipboard is empty.");
        return;
      }
      // Safari/older browsers without clipboard.read() support
      const text = await navigator.clipboard.readText(); // <- triggers the permission popup here instead
      if(text){
        await sendText(text);
        flash(btn, "Sent ✓");
      }else{
        alert("Clipboard is empty.");
      }
    }catch(e){
      if(e.name === "NotAllowedError"){
        alert("Clipboard access was blocked. Check the site permissions icon next to the address bar (usually a lock or 🔒/ⓘ icon), allow clipboard access for this site, then tap the button again.");
      }else{
        alert("Couldn't read your clipboard — there may be nothing copied yet. You can still paste directly into the box above.");
      }
    }
  };

  $("startBtn").onclick = () => enterRoom(pendingCode);
  $("joinBtn").onclick = () => enterRoom($("joinInput").value);
  $("joinInput").addEventListener("keydown", (e) => { if(e.key === "Enter") enterRoom($("joinInput").value); });

  $("shareBtn").onclick = async () => {
    const url = location.origin + "/r/" + pendingCode;
    if(navigator.share){
      try{ await navigator.share({ title: "clipsync room", url }); return; }catch(e){}
    }
    copyText(url, $("shareBtn"));
  };

  $("leaveBtn").onclick = () => {
    localStorage.removeItem(STORAGE_KEY);
    location.href = "/";
  };

  $("clearBtn").onclick = (e) => {
    e.preventDefault();
    if(socket && confirm("Clear history for everyone in this room?")) socket.emit("clear");
  };

  // ---------- PWA + push notifications ----------
  let swRegistration = null;

  async function registerServiceWorker(){
    if(!("serviceWorker" in navigator)) return null;
    try{
      swRegistration = await navigator.serviceWorker.register("/sw.js");
      return swRegistration;
    }catch(e){
      console.error("Service worker registration failed:", e);
      return null;
    }
  }

  function urlBase64ToUint8Array(base64String){
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const output = new Uint8Array(rawData.length);
    for(let i=0;i<rawData.length;i++) output[i] = rawData.charCodeAt(i);
    return output;
  }

  async function setupPush(){
    if(!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const reg = swRegistration || await registerServiceWorker();
    if(!reg) return;

    const existing = await reg.pushManager.getSubscription();
    const btn = $("notifyBtn");
    btn.style.display = "inline-flex";

    if(existing){
      btn.textContent = "🔔";
      btn.title = "Notifications on for this room";
      btn.onclick = async () => {
        await existing.unsubscribe();
        if(socket) socket.emit("unsubscribe", existing.endpoint);
        btn.textContent = "🔕";
        btn.title = "Enable notifications";
        setupPush();
      };
      // make sure the server still has this subscription (e.g. after a fresh join)
      if(socket) socket.emit("subscribe", existing.toJSON ? existing.toJSON() : existing);
      return;
    }

    btn.textContent = "🔕";
    btn.title = "Enable notifications";
    btn.onclick = async () => {
      try{
        const perm = await Notification.requestPermission();
        if(perm !== "granted"){
          alert("Notifications weren't allowed. On iPhone: add this page to your Home Screen first, then open it from there before enabling notifications.");
          return;
        }
        const res = await fetch("/vapid-public-key");
        const { publicKey } = await res.json();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
        if(socket) socket.emit("subscribe", sub.toJSON ? sub.toJSON() : sub);
        btn.textContent = "🔔";
        btn.title = "Notifications on for this room";
        setupPush();
      }catch(e){
        console.error("Push subscribe failed:", e);
        alert("Couldn't enable notifications on this device/browser.");
      }
    };
  }

  registerServiceWorker();

  // ---------- boot ----------
  const urlRoom = roomFromUrl();
  const savedRoom = localStorage.getItem(STORAGE_KEY);
  if(urlRoom){
    enterRoom(urlRoom);
  } else if(savedRoom){
    enterRoom(savedRoom);
  }
  // else: show pairing screen with pendingCode, waiting for user action
})();
