
(function(){
  const ID = "wb-ext-root";
  let currentAdvert = null;
  let host = null;
  let iframeRef = null;

  function injectBridge(){
    if (document.getElementById("wb-ext-bridge")) return;
    const s = document.createElement("script");
    s.id = "wb-ext-bridge";
    s.src = chrome.runtime.getURL("page-bridge.js");
    (document.head || document.documentElement).appendChild(s);
  }


  function postAdvertToIframe(id){
    try{
      const fr = iframeRef || (host && host.querySelector("iframe"));
      if (fr && fr.contentWindow){
        fr.contentWindow.postMessage({ type:"WB_EXT_SET_ADVERT", advertID: id }, "*");
      }
    }catch(e){}
  }

  function parseAdvertId(){
    const m = location.pathname.match(/\/campaigns\/(?:edit|statistics\/details)\/(\d+)/);
    return m ? m[1] : null;
  }

  function dismissedKey(id){ return `wbExtDismissed:${id}`; }

  function isDismissed(id){
    try { return sessionStorage.getItem(dismissedKey(id)) === "1"; } catch(e){ return false; }
  }
  function setDismissedUntilUnload(id){
    try { 
      const key = dismissedKey(id);
      sessionStorage.setItem(key, "1");
      const clear = ()=>{ try{ sessionStorage.removeItem(key); }catch(e){}; window.removeEventListener("beforeunload", clear); };
      window.addEventListener("beforeunload", clear);
    } catch(e){}
  }

  function findAnchor(){
    const selectors = [
      '[data-qa="page-content"]',
      '[data-qa="content"]',
      'main',
      '#app',
      'body'
    ];
    for (const sel of selectors){
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  }

  function openPanel(id){
    if (document.getElementById(ID) || host) return;
    injectBridge();
    host = document.createElement("div");
    host.id = ID;
    const anchor = findAnchor();
    const cs = getComputedStyle(anchor);
    if (cs.position === "static") { anchor.style.position = "relative"; }
    
    Object.assign(host.style, {
      position: "fixed", left: "unset", right: "16px", top: "90px", transform: "none",
      width: "1100px", height: "640px", zIndex: "999999",
      borderRadius: "12px", overflow: "hidden",
      boxShadow: "0 10px 40px rgba(0,0,0,.5)", background: "transparent"
    });
    anchor.appendChild(host);

    // drag handle overlay (captures mouse for moving)
    const handle = document.createElement("div");
    Object.assign(handle.style, {position:"absolute",left:"0",top:"0",width:"100%",height:"32px",cursor:"move",zIndex:"1000000",background:"transparent"});
    host.appendChild(handle);

    // resize grip bottom-right
    const grip = document.createElement("div");
    Object.assign(grip.style, {position:"absolute",right:"0",bottom:"0",width:"14px",height:"14px",cursor:"se-resize",zIndex:"1000000",background:"transparent"});
    host.appendChild(grip);

    const fr = document.createElement("iframe");
    fr.src = chrome.runtime.getURL("app.html");
    Object.assign(fr.style, { width:"100%", height:"100%", border:"0" });
    host.appendChild(fr);
    iframeRef = fr;
    fr.addEventListener("load", ()=> postAdvertToIframe(id));

    // restore last position/size
    try{
      const saved = JSON.parse(localStorage.getItem("wbExtPanelPos")||"null");
      if (saved){
        host.style.left = saved.left + "px";
        host.style.top = saved.top + "px";
        host.style.width = saved.width + "px";
        host.style.height = saved.height + "px";
        host.style.right = "unset";
      }
    }catch(e){}

    // drag + resize logic
    (function(){
      const minW = 720, minH = 420;
      const save = ()=>{
        try{
          const r = host.getBoundingClientRect();
          localStorage.setItem("wbExtPanelPos", JSON.stringify({left:r.left, top:r.top, width:r.width, height:r.height}));
        }catch(e){}
      };
      let dragging=false, sx=0, sy=0, startL=0, startT=0;
      handle.addEventListener("mousedown", (ev)=>{
        dragging=true; sx=ev.clientX; sy=ev.clientY;
        const r = host.getBoundingClientRect(); startL=r.left; startT=r.top;
        ev.preventDefault();
      });
      window.addEventListener("mousemove", (ev)=>{
        if(!dragging || resizing) return;
        let nx = startL + (ev.clientX - sx);
        let ny = startT + (ev.clientY - sy);
        nx = Math.max(0, Math.min(window.innerWidth - host.offsetWidth, nx));
        ny = Math.max(0, Math.min(window.innerHeight - host.offsetHeight, ny));
        host.style.left = nx + "px";
        host.style.top = ny + "px";
        host.style.right = "unset";
      });
      window.addEventListener("mouseup", ()=>{ if(dragging){ dragging=false; save(); } });

      let resizing=false, rsx=0, rsy=0, startW=0, startH=0;
      grip.addEventListener("mousedown", (ev)=>{
        resizing=true; rsx=ev.clientX; rsy=ev.clientY; startW=host.offsetWidth; startH=host.offsetHeight; ev.preventDefault();
      });
      window.addEventListener("mousemove", (ev)=>{
        if(!resizing) return;
        let w = Math.max(minW, startW + (ev.clientX - rsx));
        let h = Math.max(minH, startH + (ev.clientY - rsy));
        host.style.width = w + "px";
        host.style.height = h + "px";
      });
      window.addEventListener("mouseup", ()=>{ if(resizing){ resizing=false; save(); } });
    })();
  }

  function closePanel(){
    const id = currentAdvert || parseAdvertId();
    if (id) setDismissedUntilUnload(id);
    if (host) { host.remove(); host = null; }
    iframeRef = null;
  }

  // слушаем сигнал от iframe
  window.addEventListener("message", (ev)=>{
    if (ev && ev.data && ev.data.type === "WB_EXT_CLOSE") closePanel();
  });

  function shouldOpen(id){
    if (!id) return false;
    if (isDismissed(id)) return false;
    if (document.getElementById(ID)) return false;
    return true;
  }

  function reinit(){
    const id = parseAdvertId();
    if (id !== currentAdvert){
      currentAdvert = id;
      if (host && id) postAdvertToIframe(id);
      // для нового advertID открываем заново (без сброса «dismissed» на старом id)
    }
    if (!id){ if (host) closePanel(); return; }
    if (shouldOpen(id)){
      const anchor = findAnchor();
      if (anchor) openPanel(id);
    }
  }

  // перехватываем навигацию SPA
  const _push = history.pushState;
  history.pushState = function(){ const r = _push.apply(this, arguments); setTimeout(reinit, 50); return r; };
  window.addEventListener("popstate", ()=> setTimeout(reinit, 50));

  // следим, когда нужный контейнер появится
  const mo = new MutationObserver(()=>{
    if (!host) reinit();
  });
  mo.observe(document.documentElement, { childList:true, subtree:true });

  document.addEventListener("readystatechange", ()=>{
    if (document.readyState === "complete") reinit();
  });

  window.addEventListener("beforeunload", closePanel);
  // первый запуск
  reinit();
})();
