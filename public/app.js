(function(){
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "clipsync_room";   // the last room code used
  const THEME_KEY = "clipsync_theme";

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

  function renderQR(url){
    const host = $("qr");
    host.innerHTML = "";
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    host.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    const svg = host.querySelector("svg");
    if(svg){
      svg.setAttribute("width", "148");
      svg.setAttribute("height", "148");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "QR code linking to room " + pendingCode);
    }
  }
  renderQR(roomUrl(pendingCode));

  let socket = null;
  let currentRoom = null; // the room code

  function enterRoom(code){
    code = (code || "").toUpperCase().trim();
    if(!/^[A-Z0-9]{4,12}$/.test(code)){
      showNotice("Room codes are 4-12 letters or numbers.", "error");
      return;
    }
    clearNotice();
    currentRoom = code;
    try{ localStorage.setItem(STORAGE_KEY, code); }catch(e){}
    history.replaceState(null, "", "/r/" + code);
    pairScreen.hidden = true;
    app.hidden = false;
    $("roomLabel").textContent = code;
    connect(code);
  }

  function connect(code){
    if(socket) socket.disconnect();
    socket = io({ transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      socket.emit("join", code, (res) => {
        if(!res || !res.ok){
          showNotice(res && res.error === "room_limit_reached"
            ? "This server is at its room limit right now. Try again shortly."
            : "Couldn't join that room.", "error");
          return;
        }
        renderList(res.items || []);
      });
    });
    socket.on("disconnect", () => setPresence(null));
    socket.on("item", (item) => prependItem(item));
    socket.on("cleared", () => { $("list").innerHTML = ""; renderEmptyIfNeeded(); });
    socket.on("presence", (count) => setPresence(count));
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

    if(item.type === "file" && !item.undecryptable){
      if(item.fileType && item.fileType.startsWith("image/")){
        const img = document.createElement("img");
        img.src = item.dataUrl;
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
        a.href = item.dataUrl;
        a.download = item.fileName || "file";
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
      actions.appendChild(btn);
    } else {
      const p = document.createElement("div");
      p.className = "item-text";
      p.textContent = item.text || "";
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
    socket.emit("push", { type: "text", enc, device: deviceLabel() });
    $("composer").value = "";
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
        socket.emit("push", { type: "file", enc, device: deviceLabel() });
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

  $("shareBtn").onclick = async () => {
    const url = roomUrl(pendingCode);
    if(navigator.share){
      try{ await navigator.share({ title: "clipsync room", url }); return; }catch(e){}
    }
    copyText(url, $("shareBtn"));
  };

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
    if(saved) enterRoom(saved);
  }
})();
