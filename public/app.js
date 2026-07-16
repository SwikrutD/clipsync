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
    localStorage.setItem(STORAGE_KEY, code);
    history.replaceState(null, "", "/r/" + code);
    pairScreen.style.display = "none";
    app.style.display = "block";
    $("roomLabel").textContent = code;
    connect(code);
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

  function renderList(items){
    const list = $("list");
    list.innerHTML = "";
    if(!items.length){ renderEmptyIfNeeded(); return; }
    items.forEach(appendItemEl);
  }

  function prependItem(item){
    const list = $("list");
    const empty = list.querySelector(".empty");
    if(empty) empty.remove();
    const el = buildItemEl(item);
    list.prepend(el);
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
      const dl = document.createElement("a");
      dl.href = item.dataUrl;
      dl.download = item.fileName || "file";
      dl.textContent = "";
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
      // fallback for older/locked-down browsers
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
  function sendText(text){
    text = (text || "").trim();
    if(!text || !socket) return;
    socket.emit("push", { type: "text", text, device: deviceLabel() });
    $("composer").value = "";
  }

  function sendFile(file){
    if(!file) return;
    if(file.size > 4.5 * 1024 * 1024){ alert("Keep files under ~4.5MB for now."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      socket.emit("push", {
        type: "file",
        fileName: file.name,
        fileType: file.type,
        dataUrl: reader.result,
        device: deviceLabel()
      });
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