
(function(){
  if (window.__WB_EXT_BRIDGE__) return;
  window.__WB_EXT_BRIDGE__ = true;
  console.log("[WB-EXT] page-bridge loaded (page context)");

  window.addEventListener("message", async (e) => {
    const data = e.data || {};
    const reply = (payload, transfer) => {
      try { (e.source || window).postMessage(payload, "*", transfer || []); }
      catch (err) { window.postMessage(payload, "*", transfer || []); }
    };

    if (data.type === "WB_FETCH") {
      const { reqId, url, options } = data;
      try {
        const res = await fetch(url, Object.assign({ credentials: "include" }, options || {}));
        const ct = res.headers.get("content-type") || "";
        const text = await res.text();
        reply({ type: "WB_FETCH_RES", reqId, ok: true, text, contentType: ct, status: res.status });
      } catch (err) {
        reply({ type: "WB_FETCH_RES", reqId, ok: false, error: String(err) });
      }
      return;
    }

    if (data.type === "WB_FETCH_BIN") {
      const { reqId, url, options } = data;
      try {
        const res = await fetch(url, Object.assign({ credentials: "include" }, options || {}));
        const ct = res.headers.get("content-type") || "";
        const buf = await res.arrayBuffer();
        reply({ type: "WB_FETCH_BIN_RES", reqId, ok: true, buf, contentType: ct, status: res.status }, [buf]);
      } catch (err) {
        reply({ type: "WB_FETCH_BIN_RES", reqId, ok: false, error: String(err) });
      }
      return;
    }
  });

  // --- capture excluded list from page fetch/XHR ---
  (function(){
    function extractID(url){ const m = String(url||"").match(/\/auto\/(\d+)\//); return m ? Number(m[1]) : null; }
    function maybeCapture(url, text){
      try{
        if (!/\/api\/v2\/auto\/\d+\/(get-)?excluded|\/set-excluded/.test(url)) return;
        const arr = JSON.parse(text);
        if (Array.isArray(arr)){
          const advertID = extractID(url);
          window.postMessage({ type:"WB_CAPTURE_EXCLUDED", advertID, items: arr }, "*");
        }
      }catch(_){}
    }
    // fetch
    const _fetch = window.fetch;
    window.fetch = function(){
      const args = arguments;
      const p = _fetch.apply(this, args);
      try{
        const url = (typeof args[0]==="string" ? args[0] : (args[0] && args[0].url)) || "";
        p.then(res => {
          try { res.clone().text().then(t => maybeCapture(url, t)); } catch(_){}
        });
      }catch(_){}
      return p;
    };
    // XHR
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url){
      this.__wb_url = url;
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body){
      this.addEventListener("load", () => {
        try { maybeCapture(this.__wb_url, this.responseText); } catch(_){}
      });
      return _send.apply(this, arguments);
    };
  })();

})();
