

function showProgress(on){
  try{
    const bar = document.getElementById("progressBar");
    if (!bar) return;
    if (on){
      bar.style.transition = "none"; bar.style.width = "0%";
      requestAnimationFrame(()=>{ bar.style.transition = "width .6s ease"; bar.style.width = "80%"; });
    } else {
      bar.style.width = "100%";
      setTimeout(()=>{ if (bar) bar.style.width = "0%"; }, 400);
    }
  }catch(e){}
}

// Minimal DOM helpers available globally early
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));


// --- Theme presets ---
const PRESET_ORDER = ["lavender","graphite","cream","midnight"];
function applyPreset(preset){
  try{
    document.documentElement.setAttribute("data-preset", preset);
    localStorage.setItem("wbads.theme.preset", preset);
  }catch(e){}
}
function nextPreset(){
  const cur = localStorage.getItem("wbads.theme.preset") || PRESET_ORDER[0];
  const idx = (PRESET_ORDER.indexOf(cur)+1) % PRESET_ORDER.length;
  applyPreset(PRESET_ORDER[idx]);
}
// === Theme handling ===
function applyTheme(t){
  try{
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("wbExtTheme", t);
    const ico = $("#themeIcon"); if (ico) ico.textContent = (t === "light") ? "☀" : "🌙";
  }catch(e){}
}

function initTheme(){
  const preset = localStorage.getItem("wbads.theme.preset") || PRESET_ORDER[0];
  applyPreset(preset);
  const saved = localStorage.getItem("wbads.theme") || "dark";
  applyTheme(saved);
  const btn = $("#themeBtn");
  if (btn){
    btn.addEventListener("click", (e)=>{
      if (e.shiftKey) {
        // Shift+click toggles light/dark
        const next = (document.documentElement.getAttribute("data-theme")==="dark") ? "light":"dark";
        applyTheme(next);
      } else {
        nextPreset();
      }
    });
  }
}

(function(){
  const $ = (s)=>document.querySelector(s);
  const $$ = (s)=>Array.from(document.querySelectorAll(s));

  const state = { tab:"all", search:"", filters:{showsMin:null,showsMax:null,clicksMin:null,clicksMax:null,ctrMin:null,ctrMax:null,cpcMin:null,cpcMax:null,costMin:null,costMax:null}, clusters:[], excluded:new Set(), selected:new Set(), from:null, to:null, advertID:null, clusterDict:null, statRows:null };
  let loadInFlight = false;
  let loadQueued = false;

  let serverExcludedReady = false;  // true после успешного fetchExcludedFromWB()
  let lastServerExcludedCount = 0;

  document.addEventListener('wbZonesKPI', ev => {
    try{
      const d = ev.detail || {};
      state.zonesTotal = d.overall || null;
      state.zonesCatalog = d.catalog || {shows:0, clicks:0, cost:0, ctr:0, cpc:0};
      updateZones();
    }catch(e){}
  });

  
async function ensureServerSync(advertID){
  if (serverExcludedReady) return true;
  const list = await fetchExcludedFromWB(advertID);
  if (Array.isArray(list)){
    lastServerExcludedCount = list.length;
    serverExcludedReady = true;
    hideNotice();
    setStatus(`Синхронизировано из WB (stat-words): ${lastServerExcludedCount} фраз.`);
    return true;
  } else {
    showNotice("Не удалось получить актуальный список исключённых через <b>stat-words</b>. Чтобы ничего не потерять, откройте системную страницу WB с разделом «Исключённые фразы» или нажмите «Синхронизировать из WB». После успешной синхронизации можно изменять список.");
    setStatus("Требуется синхронизация исключённых (stat-words).");
    return false;
  }
}



  const EXC_KEY = "serverExcludedByAdvert";
  async function getServerExcluded(advertID){
    const saved = await chrome.storage.local.get([EXC_KEY]);
    const map = saved[EXC_KEY] || {};
    return { map, list: Array.isArray(map[advertID]) ? map[advertID] : null };
  }
  async function setServerExcluded(advertID, list){
    const saved = await chrome.storage.local.get([EXC_KEY]);
    const map = saved[EXC_KEY] || {};
    map[advertID] = Array.from(new Set(list.map(x => String(x).toLowerCase())));
    await chrome.storage.local.set({ [EXC_KEY]: map });
  }


  function fmt(n,d=0){ if(n==null||isNaN(n))return "—"; return n.toLocaleString("ru-RU",{minimumFractionDigits:d,maximumFractionDigits:d}); }
  function setStatus(m){ $("#status").textContent = m; }
  function showNotice(html){ const n=$("#notice"); n.innerHTML = html; n.style.display="block"; }
  function hideNotice(){ const n=$("#notice"); n.style.display="none"; n.innerHTML=""; }

  function defaultDates15d(){
    const to = new Date(); const from = new Date(to); from.setDate(to.getDate()-14);
    from.setHours(0,0,0,0); to.setHours(23,59,59,0);
    $("#fromDate").valueAsDate = from; $("#toDate").valueAsDate = to;
    state.from = from; state.to = to;
  }
  function readDatesFromInputs(){
    try {
      const from = $("#fromDate").valueAsDate;
      const to   = $("#toDate").valueAsDate;
      if (from) from.setHours(0,0,0,0);
      if (to)   to.setHours(23,59,59,0);
      if (from && to){
        state.from = from; state.to = to;
      }
    } catch(e){}
  }


  function readAdvertIdFromQuery(){
    const m = location.search.match(/[?&]advertID=(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // ---------- page bridge plumbing ----------
  const __waiters = new Map();
  window.addEventListener("message", (e)=>{
    const d = e.data||{};
    if (d.type === "WB_EXT_SET_ADVERT" && d.advertID){
      if (state.advertID !== Number(d.advertID)) {
        state.advertID = Number(d.advertID);
        scheduleLoad();
      }
    }
    if (d.type === "WB_FETCH_RES") {
      const w = __waiters.get(d.reqId);
      if (w){ __waiters.delete(d.reqId); d.ok ? w.resolve({ text:d.text, contentType:d.contentType, status:d.status }) : w.reject(new Error(d.error||"fetch failed")); }
    }

    if (d.type === "WB_CAPTURE_EXCLUDED" && d.items && d.advertID){
      console.info("[WB-EXT] captured server excluded:", d.items.length, "for advert", d.advertID);
      setServerExcluded(String(d.advertID), d.items);
      // если это текущая кампания — можно сразу пометить кластера
    }

    if (d.type === "WB_FETCH_BIN_RES") {
      const w = __waiters.get(d.reqId);
      if (w){ __waiters.delete(d.reqId); d.ok ? w.resolve({ buf:d.buf, contentType:d.contentType, status:d.status }) : w.reject(new Error(d.error||"fetch failed")); }
    }
  });
  function pageFetchText(url, options){
    return new Promise((resolve, reject)=>{
      const reqId = Math.random().toString(36).slice(2);
      __waiters.set(reqId, { resolve, reject });
      parent.postMessage({ type:"WB_FETCH", reqId, url, options }, "*");
      setTimeout(()=>{ if (__waiters.has(reqId)){ __waiters.delete(reqId); reject(new Error("timeout pageFetch")); } }, 25000);
    });
  }
  function pageFetchBin(url, options){
    return new Promise((resolve, reject)=>{
      const reqId = Math.random().toString(36).slice(2);
      __waiters.set(reqId, { resolve, reject });
      parent.postMessage({ type:"WB_FETCH_BIN", reqId, url, options }, "*");
      setTimeout(()=>{ if (__waiters.has(reqId)){ __waiters.delete(reqId); reject(new Error("timeout pageFetch(bin)")); } }, 25000);
    });
  }

  async function getCookies(){ const r=await chrome.runtime.sendMessage({type:"GET_COOKIES"}); return (r&&r.ok)?(r.cookies||{}):{}; }
  async function getAuthMeta(){ const r=await chrome.runtime.sendMessage({type:"GET_AUTHV3"}); return r||{ok:true}; }
  function safeMask(str, keep=8){ if(!str) return ""; return String(str).slice(0,keep)+"...("+String(str).length+" chars)"; }

  async function getAuthHeaders(logOnce=false){
    const cookies = await getCookies();
    const meta = await getAuthMeta();
    const authorizev3 = meta.authorizev3 || null;
    let supplierId = cookies["x-supplier-id-external"] || cookies["x-supplierid"] || null;
    if (!supplierId && meta.lastXsupplierid) { supplierId = meta.lastXsupplierid; }
    if (logOnce) console.log("[WB-EXT] headers:", { authorizev3: safeMask(authorizev3), x_supplierid: supplierId });
    if (!authorizev3) throw new Error("Не найден authorizev3. Перезагрузи страницу и подожди 1–2 сек.");
    if (!supplierId) throw new Error("Не найден supplierId (ни кука, ни заголовок x-supplierid).");
    return { "authorizev3": authorizev3, "x-supplierid": supplierId, "accept":"*/*" };
  }

  async function fetchWithRetryBIN(url, headers){
    const maxAttempts = 4;
    let delay = 1200;
    for (let attempt=1; attempt<=maxAttempts; attempt++){
      const { buf, contentType, status } = await pageFetchBin(url, { headers, credentials:"include" });
      if (status !== 429) return { buf, contentType, status };
      const jitter = Math.floor(Math.random()*350);
      console.warn(`[WB-EXT] 429 Too Many Requests. attempt ${attempt}/${maxAttempts}. Wait ${delay+jitter}ms`);
      await new Promise(r=>setTimeout(r, delay+jitter));
      delay *= 2;
    }
    throw new Error("Превышен лимит повторов после 429.");
  }

  // ---------- Minimal XLSX parser (ZIP+XML) ----------
  async function unzipEntries(buf){
    const dv = new DataView(buf);
    function u32(off){ return dv.getUint32(off, true); }
    function u16(off){ return dv.getUint16(off, true); }
    const EOCD = 0x06054b50, CD = 0x02014b50, LFH = 0x04034b50;

    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= 0 && i >= buf.byteLength - 65557; i--) {
      if (u32(i) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("ZIP EOCD not found");
    const cdSize = u32(eocd + 12);
    const cdOffset = u32(eocd + 16);

    let offset = cdOffset;
    const entries = {};
    while (offset < cdOffset + cdSize){
      if (u32(offset) !== CD) break;
      const compMethod = u16(offset + 10);
      const compSize = u32(offset + 20);
      const fnLen = u16(offset + 28);
      const extraLen = u16(offset + 30);
      const commentLen = u16(offset + 32);
      const lfhOffset = u32(offset + 42);
      const filename = new TextDecoder().decode(new Uint8Array(buf, offset + 46, fnLen));
      if (u32(lfhOffset) !== LFH) throw new Error("ZIP LFH missing");
      const lf_fnLen = u16(lfhOffset + 26);
      const lf_extraLen = u16(lfhOffset + 28);
      const dataStart = lfhOffset + 30 + lf_fnLen + lf_extraLen;
      const compSlice = buf.slice(dataStart, dataStart + compSize);
      entries[filename] = { compMethod, compSlice };
      offset += 46 + fnLen + extraLen + commentLen;
    }

    async function inflateRaw(slice){
      const stream = new DecompressionStream("deflate-raw");
      const r = new Response(new Blob([slice]).stream().pipeThrough(stream));
      return new Uint8Array(await r.arrayBuffer());
    }
    async function getText(name){
      const e = entries[name]; if (!e) return null;
      if (e.compMethod === 0) return new TextDecoder().decode(new Uint8Array(e.compSlice));
      if (e.compMethod === 8) return new TextDecoder().decode(await inflateRaw(e.compSlice));
      throw new Error("Unsupported compression "+e.compMethod);
    }
    return { getText, list: Object.keys(entries) };
  }

  function parseSharedStringsXML(xml){
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const arr = [];
    const si = doc.getElementsByTagName("si");
    for (let i=0;i<si.length;i++){
      const texts = si[i].getElementsByTagName("t");
      let s = "";
      for (let j=0;j<texts.length;j++) s += texts[j].textContent;
      arr.push(s);
    }
    return arr;
  }

  function parseSheetXML(xml, shared){
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const sheetData = doc.getElementsByTagName("sheetData")[0];
    if (!sheetData) return [];
    function colIndexFromRef(r){
      const m = /^[A-Z]+/.exec(r||"A1"); const s = m ? m[0] : "A";
      let idx = 0; for (let i=0;i<s.length;i++){ idx = idx*26 + (s.charCodeAt(i)-64); } return idx-1;
    }
    function getVal(c){
      const t = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0];
      if (!v) return "";
      const text = v.textContent;
      if (t === "s") { const idx = parseInt(text,10)||0; return shared[idx] || ""; }
      return text;
    }
    const rows = [];
    const rowNodes = sheetData.getElementsByTagName("row");
    for (let i=0;i<rowNodes.length;i++){
      const r = rowNodes[i];
      const cells = r.getElementsByTagName("c");
      const rowArr = [];
      for (let j=0;j<cells.length;j++){
        const c = cells[j];
        const ci = colIndexFromRef(c.getAttribute("r"));
        rowArr[ci] = getVal(c);
      }
      while (rowArr.length && (rowArr[rowArr.length-1]===undefined || rowArr[rowArr.length-1]==="")) rowArr.pop();
      rows.push(rowArr);
    }
    return rows;
  }

  function rowsToStat(rows){
    if (!rows || !rows.length) return [];
    const norm = (s)=>String(s||"").trim().toLowerCase();
    const hasAny = (text, arr)=>arr.some(a => norm(text).includes(a));
    const wantPhrase = ["ключев", "фраз", "keyword", "phrase", "слово", "word", "query", "запрос"];
    const wantShows  = ["показы","impressions","показов","просмотры","просмотров"];
    const wantClicks = ["клики","clicks"];
    const wantCost   = ["расход","затраты","cost","spend","расходы"];

    let headerRowIdx = -1, idxPhrase=-1, idxShows=-1, idxClicks=-1, idxCost=-1;
    const limit = Math.min(rows.length, 50);
    for (let i=0;i<limit;i++){
      const r = rows[i] || [];
      const labels = r.map(norm);
      const p = labels.findIndex(h => hasAny(h, wantPhrase));
      const s = labels.findIndex(h => hasAny(h, wantShows));
      const c = labels.findIndex(h => hasAny(h, wantClicks));
      const k = labels.findIndex(h => hasAny(h, wantCost));
      if (p >= 0) { headerRowIdx = i; idxPhrase=p; idxShows=s; idxClicks=c; idxCost=k; break; }
    }
    if (headerRowIdx < 0 || idxPhrase < 0) return [];
    console.info("[WB-EXT] header row", headerRowIdx, {idxPhrase, idxShows, idxClicks, idxCost});
    const out = [];
    for (let i=headerRowIdx+1;i<rows.length;i++){
      const r = rows[i] || [];
      const phrase = norm(r[idxPhrase]);
      if (!phrase) continue;
      const toNum = (x)=>{ if (x==null) return 0; const s=String(x).replace(/\s/g,"").replace(",",".").replace("\u00A0",""); const n=parseFloat(s); return isFinite(n)?n:0; };
      const shows  = toNum(r[idxShows]);
      const clicks = toNum(r[idxClicks]);
      const cost   = toNum(r[idxCost]);
      out.push({ phrase, shows, clicks, cost });
    }
    return out;
  }

  function rowsToMap(rows){
    if (!rows || !rows.length) return null;
    const norm = (s)=>String(s||"").trim().toLowerCase();
    const headerIdx = rows.findIndex(r => r.some(x => /кластер/i.test(String(x))) && r.some(x => /(фраз|запрос|keyword|phrase|слово|word|query)/i.test(String(x))));
    if (headerIdx < 0) return null;
    const header = rows[headerIdx].map(norm);
    const idxPhrase = header.findIndex(h => /фраз|запрос|keyword|phrase|слово|word|query/.test(h));
    const idxCluster = header.findIndex(h => /кластер|cluster/.test(h));
    if (idxPhrase < 0 || idxCluster < 0) return null;
    const dict = new Map();
    for (let i=headerIdx+1;i<rows.length;i++){
      const r = rows[i] || [];
      const phrase = norm(r[idxPhrase]);
      if (!phrase) continue;
      const cl = String(r[idxCluster]||"").trim() || "__без_кластера__";
      dict.set(phrase, cl);
    }
    return dict;
  }

  async function parseStatXLSX(buf){
    const { getText, list } = await unzipEntries(buf);
    const sharedXML = await getText("xl/sharedStrings.xml");
    const shared = sharedXML ? parseSharedStringsXML(sharedXML) : [];
    const sheets = list.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    for (const name of sheets){
      const xml = await getText(name);
      const rows = parseSheetXML(xml, shared);
      const stat = rowsToStat(rows);
      if (stat && stat.length){ console.info("[WB-EXT] chosen sheet", name, "rows:", rows.length, "stat:", stat.length); return stat; }
    }
    throw new Error("Не нашёл лист с колонкой «Фраза/Запрос» в XLSX.");
  }

  async function parseWordsMapXLSX(buf){
    const { getText, list } = await unzipEntries(buf);
    const sharedXML = await getText("xl/sharedStrings.xml");
    const shared = sharedXML ? parseSharedStringsXML(sharedXML) : [];
    const sheets = list.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    for (const name of sheets){
      const xml = await getText(name);
      const rows = parseSheetXML(xml, shared);
      const m = rowsToMap(rows);
      if (m){ console.info("[WB-EXT] words map sheet", name, "size:", m.size); return m; }
    }
    return null;
  }

  async function loadWordsMapAuto(){
    try{
      const headers = await getAuthHeaders();
      const url = `https://cmp.wildberries.ru/api/v5/words-clusters?advertID=${state.advertID}`;
      const { buf, status } = await fetchWithRetryBIN(url, headers);
      if (status === 200){
        try{
          const text = new TextDecoder().decode(new Uint8Array(buf));
          if (text.trim().startsWith("{") || text.trim().startsWith("[")){
            const j = JSON.parse(text);
            const dict = new Map();
            const arr = Array.isArray(j)?j:(j.items||j.data||[]);
            for (const r of arr){
              const p=(r.phrase||r.word||r.query||"").toLowerCase();
              const c=(r.cluster||r.cluster_name||r.clusterId||"__без_кластера__")||"__без_кластера__";
              if(p) dict.set(p,c);
            }
            if (dict.size) return dict;
          }
        }catch(_){}
        const dict = await parseWordsMapXLSX(buf);
        if (dict) return dict;
      }
    }catch(e){ console.warn("loadWordsMapAuto:", e); }
    return null;
  }

  async function loadStatViaAPI(){
// ensure date range
if (!state.from || !state.to){
  const __to = new Date();
  const __from = new Date(__to); __from.setDate(__to.getDate()-14);
  __from.setHours(0,0,0,0); __to.setHours(23,59,59,0);
  state.from = __from; state.to = __to;
  try{
    const fd = document.getElementById("fromDate");
    const td = document.getElementById("toDate");
    if (fd && !fd.value) fd.valueAsDate = __from;
    if (td && !td.value) td.valueAsDate = __to;
  }catch(e){}
}

    const headers = await getAuthHeaders(true);
    const qs = new URLSearchParams({
      advertID: String(state.advertID),
      from: state.from.toISOString().slice(0,19) + "Z",
      to:   state.to.toISOString().slice(0,19) + "Z",
      appType: "0",
      placementType: "0"
    });
    const url = `https://cmp.wildberries.ru/api/v3/fullstat?${qs.toString()}`;
    const res = await fetchWithRetryBIN(url, headers);

    try {
      const probe = new TextDecoder().decode(new Uint8Array(res.buf).slice(0, 512)).trim();
      if (probe.startsWith("{") || probe.startsWith("[")) {
        const json = JSON.parse(new TextDecoder().decode(res.buf));
        const items = Array.isArray(json) ? json : (json.items || json.data || []);
        return items.map(it => ({
          phrase: (it.phrase || it.query || it.keyword || it.word || "").toLowerCase(),
          shows:  Number(it.shows ?? it.impressions ?? 0),
          clicks: Number(it.clicks ?? 0),
          cost:   Number(it.cost ?? it.spend ?? 0)
        }));
      }
    } catch(e){ /* fallthrough to xlsx */ }

    return await parseStatXLSX(res.buf);
  }

  function aggregateByCluster(rows, dict){
    const by = new Map();
    for (const r of rows){
      const cl = (dict && dict.get(r.phrase)) || "__без_кластера__";
      const rec = by.get(cl) || { shows:0, clicks:0, cost:0 };
      rec.shows += r.shows; rec.clicks += r.clicks; rec.cost += r.cost;
      by.set(cl, rec);
    }
    const list = Array.from(by.entries()).map(([id,m]) => ({
      id, name:id, shows:m.shows, clicks:m.clicks, ctr:(m.shows? m.clicks/m.shows : 0), cpc:(m.clicks? m.cost/m.clicks : 0), cost:m.cost
    }));
    list.sort((a,b)=> b.shows - a.shows);
    return list;
  }

  
function normStr(s){ return (s||"").toLowerCase().replace(/ё/g,"е"); }
function tokenizeName(name){
  return normStr(name).split(/[^a-zа-я0-9]+/i).filter(Boolean);
}

function parseNum(v){
  if (v==null || v==="") return null;
  const n = parseFloat(String(v).replace(',', '.').replace(/[\s\u00A0\u202F%]+/g,''));
  return isNaN(n) ? null : n;
}
function passMetrics(c){
  const f = state.filters || {};
  const ok = (val, min, max) => (min==null || val>=min) && (max==null || val<=max);
  // shows, clicks
  if (!ok(c.shows, f.showsMin, f.showsMax)) return false;
  if (!ok(c.clicks, f.clicksMin, f.clicksMax)) return false;
  // ctr stored as 0..1; filters given in %
  const ctrMin = f.ctrMin==null ? null : f.ctrMin/100;
  const ctrMax = f.ctrMax==null ? null : f.ctrMax/100;
  if (!ok(c.ctr, ctrMin, ctrMax)) return false;
  // cpc, cost
  if (!ok(c.cpc, f.cpcMin, f.cpcMax)) return false;
  if (!ok(c.cost, f.costMin, f.costMax)) return false;
  return true;
}

function visibleList(){
  let list = state.clusters.filter(c => {
    const ex = state.excluded.has(c.id);
    const mode = state.tab || "all"; // reuse state.tab as mode
    const modeOk = (mode==="all") ? true : (mode==="active" ? !ex : ex);
    return modeOk && passMetrics(c);
  });
  const q = (state.search||"").trim();
  if (q){
    const neg = q.startsWith("!");
    const needle = normStr(neg ? q.slice(1) : q);
    list = list.filter(c => {
      const has = tokenizeName(c.name).some(t => t.startsWith(needle));
      return neg ? !has : has;
    });
  }
  return list;
}

function updateMicrocards
(){
  try{
    const list = visibleList();
    let shows=0, clicks=0, cost=0;
    for (const c of list){ shows+=c.shows||0; clicks+=c.clicks||0; cost+=c.cost||0; }
    const ctr = shows>0 ? (clicks/shows*100) : 0;
    const cpc = clicks>0 ? (cost/clicks) : 0;
    const set = (id, val)=>{ const el=$(id); if(el) el.textContent = val; };
    set("#m-shows", fmt(shows));
    set("#m-clicks", fmt(clicks));
    set("#m-ctr", fmt(ctr,2)+"%");
    set("#m-cpc", fmt(cpc,2));
    set("#m-cost", fmt(cost,2));
  }catch(e){}
}
function render(){
    updateZones();
    updateZones();
    updateMicrocards();
    const body = $("#clustersBody"); body.innerHTML = ""; const total=state.clusters.length, excCount=state.clusters.filter(c=>state.excluded.has(c.id)).length; const actCount=total-excCount; $("#countAll") && ($("#countAll").textContent=total); $("#countActive") && ($("#countActive").textContent=actCount); $("#countExcluded") && ($("#countExcluded").textContent=excCount);
    const list = visibleList();
    for (const c of list){
      const tr = document.createElement("tr");
      tr.dataset.clusterId = c.id;
      const checked = state.selected.has(c.id);
      const disabled = false;
      tr.innerHTML = `
        <td class="check"><input type="checkbox" class="rowCheck" ${checked?"checked":""} ${disabled?"disabled":""}></td>
        <td>${c.name}</td>
        <td>${fmt(c.shows)}</td>
        <td>${fmt(c.clicks)}</td>
        <td>${fmt(c.ctr*100,2)}%</td>
        <td>${fmt(c.cpc,2)}</td>
        <td>${fmt(c.cost,2)}</td>
      `;
      if (state.excluded.has(c.id)) tr.classList.add("cluster-row--excluded"); else tr.classList.remove("cluster-row--excluded");
      body.appendChild(tr);
    }
    $("#checkAll").checked = list.length && list.every(c => state.selected.has(c.id));
    const sel = Array.from(state.selected);
    const anyAct = sel.some(id => !state.excluded.has(id));
    $("#excludeBtn").disabled = !anyAct;
    const anyExc = Array.from(state.selected).some(id => state.excluded.has(id));
    $("#restoreBtn").disabled = !anyExc;
  }

  function bindUI(){
    $("#closeBtn").addEventListener("click", ()=> { try { window.parent?.postMessage({type:"WB_EXT_CLOSE"}, "*"); } catch(e){} });
    $("#checkAll").addEventListener("change", ()=>{
      const list = visibleList();
      if ($("#checkAll").checked) for (const c of list) state.selected.add(c.id);
      else for (const c of list) state.selected.delete(c.id);
      render();
    });
    $("#clustersBody").addEventListener("click", (e)=>{
      const cb = e.target.closest(".rowCheck"); if(!cb)return;
      const id = e.target.closest("tr").dataset.clusterId;
      cb.checked ? state.selected.add(id) : state.selected.delete(id);
      render();
    });
    $
    // filter chips
    const activate = (mode)=>{
      state.tab = mode;
      state.selected.clear();
      ["fAll","fActive","fExcluded"].forEach(id=>document.getElementById(id)?.classList.remove("active"));
      const m2 = mode==="all"?"fAll":(mode==="active"?"fActive":"fExcluded");
      document.getElementById(m2)?.classList.add("active");
      render();
    };
    $("#fAll")?.addEventListener("click", ()=>activate("all"));
    $("#fActive")?.addEventListener("click", ()=>activate("active"));
    $("#fExcluded")?.addEventListener("click", ()=>activate("excluded"));
$("#searchInput").addEventListener("input", ()=>{ state.search = $("#searchInput").value; render(); })
    $("#themeBtn").addEventListener("click", ()=>{
      const cur = document.documentElement.getAttribute("data-theme") || "dark";
      applyTheme(cur === "dark" ? "light" : "dark");
    });
;
    const F = state.filters;
    const setF = (id, key, isPct=false)=>{
      const el = $(id);
      if (!el) return;
      el.value = F[key] ?? "";
      el.addEventListener("input", ()=>{ 
        const v = parseNum(el.value); 
        F[key] = v; 
        render(); 
      });
    };
    setF("#f-shows-min","showsMin"); setF("#f-shows-max","showsMax");
    setF("#f-clicks-min","clicksMin"); setF("#f-clicks-max","clicksMax");
    setF("#f-ctr-min","ctrMin", true); setF("#f-ctr-max","ctrMax", true);
    setF("#f-cpc-min","cpcMin"); setF("#f-cpc-max","cpcMax");
    setF("#f-cost-min","costMin"); setF("#f-cost-max","costMax");

    $("#excludeBtn").addEventListener("click", async ()=>{
    try {
      if (state.tab !== "active"){ setStatus("Перейди на вкладку Активные."); return; }
      if (!await ensureServerSync(state.advertID)) return;
      const clustersToExclude = Array.from(state.selected);
      if (!clustersToExclude.length){ setStatus("Не выбрано ни одного кластера."); return; }
      // Оптимистично отметим кластера как исключённые
      clustersToExclude.forEach(id => state.excluded.add(id));
      await chrome.storage.local.set({ excludedClusters: Array.from(state.excluded) });
      await buildAndRender();
      setStatus("Исключаем…");
      // точный список фраз, который ожидаем увидеть в excluded
      const expectedPhrases = collectPhrasesByClusters(clustersToExclude, state.clusterDict, state.statRows);
      // Объединённая запись на сервер
      await fetchExcludedFromWB(state.advertID);
      await excludeClustersOnServer(state.advertID, clustersToExclude);
      // Ждём, пока stat-words точно отразит новое состояние
      const confirmed = await waitStatWordsReflects(state.advertID, expectedPhrases, "exclude");
      const serverClusters = clustersFromServerExcluded(confirmed||[], state.clusterDict || new Map());
      state.excluded = serverClusters;
      await chrome.storage.local.set({ excludedClusters: Array.from(state.excluded) });
      state.selected.clear();
      await buildAndRender();
      setStatus(`Исключены на стороне WB. Всего исключено: ${(confirmed||[]).length}`);
    } catch(e){
      console.error("[WB-EXT] exclude failed:", e);
      setStatus("Ошибка исключения: " + (e.message||e));
    }
  });;;;;
    $("#exportBtn").addEventListener("click", exportCSV);
    $("#restoreBtn").addEventListener("click", async ()=>{
      try {
        if (state.tab !== "excluded"){ setStatus("Перейди на вкладку Исключённые."); return; }
        if (!await ensureServerSync(state.advertID)) return;
        const clustersToRestore = Array.from(state.selected);
        if (!clustersToRestore.length){ setStatus("Не выбрано ни одного кластера."); return; }
        // Оптимистично снимем исключение
        clustersToRestore.forEach(id => state.excluded.delete(id));
        await chrome.storage.local.set({ excludedClusters: Array.from(state.excluded) });
        await buildAndRender();
        setStatus("Восстанавливаем…");
        const expectedPhrases = collectPhrasesByClusters(clustersToRestore, state.clusterDict, state.statRows);
        await fetchExcludedFromWB(state.advertID);
        await restoreClustersOnServer(state.advertID, clustersToRestore);
        const confirmed = await waitStatWordsReflects(state.advertID, expectedPhrases, "restore");
        const serverClusters = clustersFromServerExcluded(confirmed||[], state.clusterDict || new Map());
        state.excluded = serverClusters;
        await chrome.storage.local.set({ excludedClusters: Array.from(state.excluded) });
        state.selected.clear();
        await buildAndRender();
        setStatus(`Восстановлено на стороне WB. Осталось исключено: ${(confirmed||[]).length}`);
      } catch(e){
        console.error("[WB-EXT] restore failed:", e);
        setStatus("Ошибка восстановления: " + (e.message||e));
      }
    });;;
    $("#refreshBtn").addEventListener("click", ()=>{ readDatesFromInputs(); scheduleLoad(); });
    $("#syncBtn").addEventListener("click", async ()=>{
      serverExcludedReady = false;
      await ensureServerSync(state.advertID);
      // перерисуем пометки
      const cached = await getServerExcluded(String(state.advertID));
      const serverClusters = clustersFromServerExcluded(cached.list||[], state.clusterDict || new Map());
      state.excluded = serverClusters;
      await chrome.storage.local.set({ excludedClusters: Array.from(state.excluded) });
      render();
    });
  }

  async function exportCSV(){
    const rows = [["cluster","shows","clicks","ctr","cpc","cost","excluded"]];
    for (const c of state.clusters){
      rows.push([c.id, c.shows, c.clicks, c.ctr, c.cpc, c.cost, state.excluded.has(c.id)]);
    }
    const csv = rows.map(r => r.map(v => typeof v==="string" ? `"${v.replace(/"/g,'""')}"` : v).join(",")).join("\n");
    const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "wb_clusters.csv"; a.click(); URL.revokeObjectURL(url);
  }


  function collectPhrasesByClusters(clusterIds, dict, statRows){
    const want = new Set(clusterIds);
    const out = new Set();
    // по статистике
    if (statRows && dict){
      for (const r of statRows){
        const cl = dict.get(r.phrase) || "__без_кластера__";
        if (want.has(cl)) out.add(r.phrase);
      }
    }
    // добираем чисто из словаря (на случай нулевых показов)
    if (dict){
      for (const [phrase, cl] of dict.entries()){
        if (want.has(cl)) out.add(phrase);
      }
    }
    return Array.from(out);
  }

  async function fetchWithRetryTEXT(url, options){
    const maxAttempts = 4;
    let delay = 1200;
    for (let attempt=1; attempt<=maxAttempts; attempt++){
      const { text, status, contentType } = await pageFetchText(url, options);
      if (status !== 429) return { text, status, contentType };
      const jitter = Math.floor(Math.random()*350);
      console.warn(`[WB-EXT] 429 Too Many Requests (TEXT). attempt ${attempt}/${maxAttempts}. Wait ${delay+jitter}ms`);
      await new Promise(r=>setTimeout(r, delay+jitter));
      delay *= 2;
    }
    throw new Error("Превышен лимит повторов (TEXT) после 429.");
  }

  
  async function pushExcludedToWB(advertID, phrases){
    const advKey = String(advertID);
    const cached = await getServerExcluded(advKey);
    const base = new Set((cached.list || []).map(x => String(x).toLowerCase()));
    for (const p of phrases) base.add(String(p).toLowerCase());
    const union = Array.from(base);
    if (!union.length) return { ok:true, excluded:[] };

    const headers = await getAuthHeaders();
    const url = `https://cmp.wildberries.ru/api/v2/auto/${advertID}/set-excluded`;
    const batchSize = 500;
    const total = union.length;
    let done = 0;
    const confirmed = new Set();
    for (let i=0; i<union.length; i+=batchSize){
      const part = union.slice(i, i+batchSize);
      const body = JSON.stringify({ excluded: part });
      const res = await fetchWithRetryTEXT(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "accept": "application/json, text/plain, */*" },
        body
      });
      if (res.status !== 200){
        throw new Error(`WB вернул ${res.status}: ${String(res.text||"").slice(0,200)}`);
      }
      try {
        const arr = JSON.parse(res.text);
        if (Array.isArray(arr)) arr.forEach(x => confirmed.add(String(x).toLowerCase()));
      } catch(e){ /* ignore parse */ }
      done += part.length;
      setStatus(`Исключаем… ${done}/${total}`);
    }
    const finalList = Array.from(confirmed.size ? confirmed : base);
    await setServerExcluded(advKey, finalList);
    return { ok:true, excluded: finalList };
  }



  

async function setExcludedList(advertID, list){
  const headers = await getAuthHeaders();
  const url = `https://cmp.wildberries.ru/api/v2/auto/${advertID}/set-excluded`;
  // Отправляем одним запросом полный список (WB трактует body как финальное состояние)
  const res = await fetchWithRetryTEXT(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "accept": "application/json, text/plain, */*" },
    body: JSON.stringify({ excluded: list })
  });
  if (res.status !== 200){
    throw new Error(`WB вернул ${res.status}: ${String(res.text||"").slice(0,200)}`);
  }
  // authoritative refresh
  const refreshed = await fetchExcludedFromWB(advertID);
  if (Array.isArray(refreshed)){
    await setServerExcluded(String(advertID), refreshed);
    return refreshed;
  }
  return list;
}

  
async function fetchExcludedFromWB(advertID){
  const headers = await getAuthHeaders();
  const url = `https://cmp.wildberries.ru/api/v2/auto/${advertID}/stat-words?t=${Date.now()}`;
  try{
    const res = await fetchWithRetryTEXT(url, { method:"GET", headers: { ...headers, "accept":"application/json, text/plain, */*", "cache-control":"no-cache", "pragma":"no-cache" } });
    if (res.status === 200){
      try{
        const obj = JSON.parse(res.text);
        const list = (obj && obj.words && Array.isArray(obj.words.excluded)) ? obj.words.excluded : null;
        if (Array.isArray(list)){
          const norm = Array.from(new Set(list.map(x => String(x).toLowerCase())));
          await setServerExcluded(String(advertID), norm);
          console.info("[WB-EXT] fetched excluded via stat-words:", norm.length);
          return norm;
        } else {
          console.warn("[WB-EXT] stat-words: no words.excluded array");
        }
      }catch(e){ console.warn("[WB-EXT] stat-words parse failed", e); }
    } else {
      console.warn("[WB-EXT] stat-words status:", res.status);
    }
  }catch(e){ console.warn("[WB-EXT] stat-words error:", e); }
  return null; // важный сигнал — не удалось достать список
}


  function clustersFromServerExcluded(serverExcluded, dict){
    if (!dict) return new Set();
    const set = new Set(serverExcluded.map(s => String(s).toLowerCase()));
    const out = new Set();
    for (const [phrase, cl] of dict.entries()){
      if (set.has(String(phrase).toLowerCase())) out.add(cl || "__без_кластера__");
    }
    return out;
  }



  
async function excludeClustersOnServer(advertID, clusterIds){
  const serverList = await fetchExcludedFromWB(advertID) || [];
  const toAdd = collectPhrasesByClusters(clusterIds, state.clusterDict, state.statRows);
  const set = new Set(serverList.map(normPhrase));
  for (const p of toAdd){
    const np = normPhrase(p);
    if (!set.has(np)) serverList.push(p);
  }
  return await setExcludedList(advertID, serverList);
}


  
async function restoreClustersOnServer(advertID, clusterIds){
  const serverList = await fetchExcludedFromWB(advertID) || [];
  const toRemoveNorm = new Set(collectPhrasesByClusters(clusterIds, state.clusterDict, state.statRows).map(normPhrase));
  const final = serverList.filter(p => !toRemoveNorm.has(normPhrase(p)));
  return await setExcludedList(advertID, final);
}


  
  function buildLowerDictIfNeeded(){
    if (state.clusterDictLower && state.clusterDictLower.__sizeKey === (state.clusterDict ? state.clusterDict.size : 0)) return;
    const m = new Map();
    if (state.clusterDict){
      for (const [phrase, cl] of state.clusterDict.entries()){
        const key = String(phrase).trim().toLowerCase();
        if (!m.has(key)) m.set(key, cl);
      }
    }
    m.__sizeKey = state.clusterDict ? state.clusterDict.size : 0;
    state.clusterDictLower = m;
  }

  function clustersFromServerExcluded(serverExcluded, _dict){
    buildLowerDictIfNeeded();
    const dict = state.clusterDictLower || new Map();
    const out = new Set();
    for (const p of (serverExcluded||[])){
      const key = String(p).trim().toLowerCase();
      const cl = dict.get(key);
      out.add(cl ? cl : "__без_кластера__");
    }
    return out;
  }

  function collectPhrasesByClusters(clusterIds, dict, statRows){
    buildLowerDictIfNeeded();
    const dictL = state.clusterDictLower || new Map();
    const set = new Set();
    // собираем все фразы из statRows, относящиеся к выделенным кластерам
    for (const row of (statRows||[])){
      const phrase = String(row.phrase||row.Phrase||row.keyword||"").trim();
      if (!phrase) continue;
      const cl = dictL.get(phrase.toLowerCase());
      if (cl && clusterIds.includes(cl)) set.add(phrase);
    }
    return Array.from(set);
  }

  async function waitStatWordsReflects(advertID, phrases, mode, timeoutMs=8000){
    const target = new Set((phrases||[]).map(x => String(x).toLowerCase()));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs){
      const list = await fetchExcludedFromWB(advertID);
      if (Array.isArray(list)){
        const ex = new Set(list.map(x => String(x).toLowerCase()));
        let ok = true;
        for (const p of target){
          if (mode === "exclude" && !ex.has(p)) { ok = false; break; }
          if (mode === "restore" && ex.has(p)) { ok = false; break; }
        }
        if (ok) return list;
      }
      await new Promise(r => setTimeout(r, 450));
    }
    return await fetchExcludedFromWB(advertID);
  }


  function normPhrase(x){
    // унифицируем регистр, пробелы, дефисы, ё/е, типографику
    let s = String(x||"").toLowerCase();
    s = s.replace(/ё/g, "е");
    s = s.replace(/[\u2010-\u2015\u2212]/g, "-"); // дефисы/тире -> "-"
    s = s.replace(/[\u00AB\u00BB\u201C\u201D\u201E\u2033]/g, '"'); // кавычки
    s = s.replace(/[\u2018\u2019\u2032]/g, "'"); // апострофы
    s = s.replace(/\s+/g, " ").trim(); // схлопываем пробелы
    return s;
  }

  function rebuildReverseIndexes(){
    // clusterDictLower: norm -> clusterId
    // clusterToPhrasesNorm: clusterId -> Set(norm phrases)
    const cd = state.clusterDict || new Map();
    const lower = new Map();
    const rev = new Map();
    for (const [phrase, cl] of cd.entries()){
      const key = normPhrase(phrase);
      if (!lower.has(key)) lower.set(key, cl);
      if (!rev.has(cl)) rev.set(cl, new Set());
      rev.get(cl).add(key);
    }
    state.clusterDictLower = lower;
    state.clusterToPhrasesNorm = rev;
  }

  function clustersFromServerExcluded(serverExcluded){
    if (!state.clusterDictLower) rebuildReverseIndexes();
    const dict = state.clusterDictLower || new Map();
    const out = new Set();
    for (const p of (serverExcluded||[])){
      const cl = dict.get(normPhrase(p));
      out.add(cl ? cl : "__без_кластера__");
    }
    return out;
  }

  function collectPhrasesByClusters(clusterIds, dict, statRows){
    if (!state.clusterDictLower || !state.clusterToPhrasesNorm) rebuildReverseIndexes();
    const want = new Set(clusterIds);
    const outNorm = new Set();
    // из полного словаря соответствий
    for (const cl of want){
      const bucket = state.clusterToPhrasesNorm.get(cl);
      if (bucket) for (const np of bucket) outNorm.add(np);
    }
    // из статистики (на случай неполного словаря)
    for (const r of (statRows||[])){
      const phr = String(r.phrase || r.Phrase || r.keyword || "").trim();
      if (!phr) continue;
      const np = normPhrase(phr);
      const cl = state.clusterDictLower.get(np);
      if (cl && want.has(cl)) outNorm.add(np);
    }
    // вернём оригинальные формы, где возможно — через обратный маппинг
    const originals = new Set();
    // 1) из serverExcluded мы всё равно формируем финальный список => для ожидания используем нормализованные
    // но там, где есть исходные ключи, попробуем взять «как в словаре»
    for (const [phrase, cl] of (state.clusterDict||new Map()).entries()){
      const np = normPhrase(phrase);
      if (outNorm.has(np)) originals.add(phrase);
    }
    // если каких-то нормализованных форм не нашли оригиналы — вернём нормализованную строку
    for (const np of outNorm){
      // найдём любую оригинальную из statRows/словаря
      // (уже добавили из словаря; стат может добавить новые)
      // ничего не делаем, если уже есть
      // иначе пушим нормализованную
      // (сервер принимает и такие, он матчится по токенам, но в большинстве случаев словарь покроет)
    }
    // В JS выше блок невозможен — перепишем проще: вернём массив нормализованных форм
    return Array.from(outNorm);
  }

async function buildAndRender(){
    if (!state.statRows) return;
    const agg = aggregateByCluster(state.statRows, state.clusterDict);
    state.clusters = agg;
    // не трогаем state.excluded: используем текущее состояние (оптимистическое или серверное)
    state.selected.clear();
    render();
    setStatus("Готово");
  }

  async function _load(){
    showProgress(true);
    try {
      setStatus("Загружаем данные…");
      const advert = state.advertID ?? readAdvertIdFromQuery();
      if (!advert) throw new Error("Не удалось прочитать advertID из URL/сообщения");
      state.advertID = advert;

      state.statRows = await loadStatViaAPI();
      if (!state.statRows || !state.statRows.length){ console.warn("[WB-EXT] stat rows empty"); }
      if (!state.clusterDict) state.clusterDict = await loadWordsMapAuto();
      // fetch server exclusions and reflect in UI
      const serverList = await fetchExcludedFromWB(state.advertID);
      serverExcludedReady = true; lastServerExcludedCount = Array.isArray(serverList)?serverList.length:0;
      const serverClusters = clustersFromServerExcluded(serverList||[], state.clusterDict || new Map());
      state.excluded = serverClusters;
      await chrome.storage.local.set({ excludedClusters: Array.from(state.excluded) });
      await buildAndRender();
      // серверный список — источник истины; локальный кэш уже синхронизирован выше;
      await chrome.storage.local.set({ excludedClusters: Array.from(state.excluded) });
      await buildAndRender();
    } catch(e){
      console.error("[WB-EXT] load error:", e);
      setStatus("Ошибка: " + (e.message||e));
    }
  }

  async function load(){
    if (loadInFlight){ loadQueued = true; return; }
    loadInFlight = true;
    try { await _load(); }
    finally {
      showProgress(false);
      loadInFlight = false;
      if (loadQueued){ loadQueued = false; setTimeout(load, 200); }
    }
  }
  const scheduleLoad = (function(){ let t=null; return function(){ clearTimeout(t); t = setTimeout(load, 200); }; })();

  document.addEventListener("DOMContentLoaded", async ()=>{ try {
    initTheme(); } catch(e){ console.warn("[WB-EXT] theme init failed", e); }
    defaultDates15d();
    bindUI();
    $("#fromDate").addEventListener("change", ()=>{ readDatesFromInputs(); scheduleLoad(); });
    $("#toDate").addEventListener("change", ()=>{ readDatesFromInputs(); scheduleLoad(); });
    state.advertID = readAdvertIdFromQuery();
    scheduleLoad();
  });
})();



// ---- Zones parsing & rendering (reworked) -----------------------------------
async function parseTotalsAndCatalogXLSX(buf){
  const { getText, list } = await unzipEntries(buf);
  const sharedXML = await getText("xl/sharedStrings.xml");
  const shared = sharedXML ? parseSharedStringsXML(sharedXML) : [];
  const sheetNames = list.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));

  function toNum(x){
    if (x==null) return 0;
    let s = String(x).toString().replace(/\u00A0/g,' ').replace(/[^\d.,-]/g,'').replace(/\s+/g,'');
    if (!s) return 0;
    if (s.indexOf(',')>=0 && s.indexOf('.')<0) s = s.replace(',','.');
    const n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  let total=null, catalog=null;

  for (const name of sheetNames){
    const xml = await getText(name);
    const rows = parseSheetXML(xml, shared);
    if (!rows || rows.length<2) continue;
    const hdr = rows[0].map(v => String(v||'').trim().toLowerCase());
    const idxShows  = hdr.findIndex(h => /^показы/.test(h) || /impressions/.test(h));
    const idxClicks = hdr.findIndex(h => /^клики/.test(h) || /clicks/.test(h));
    const idxCost   = hdr.findIndex(h => /(затраты|расход)/.test(h) || /cost|spend/.test(h));
    if (idxShows<0 || idxClicks<0 || idxCost<0) continue;

    // detect catalog by presence of "доля"
    const isCatalog = hdr.some(h => /^доля/.test(h));

    const agg = {shows:0, clicks:0, cost:0, ctr:0, cpc:0};
    for (let i=1;i<rows.length;i++){
      const r = rows[i] || [];
      agg.shows  += toNum(r[idxShows]);
      agg.clicks += toNum(r[idxClicks]);
      agg.cost   += toNum(r[idxCost]);
    }
    agg.ctr = agg.shows ? (agg.clicks/agg.shows) : 0;
    agg.cpc = agg.clicks ? (agg.cost/agg.clicks) : 0;

    if (isCatalog){
      catalog = agg;
    } else {
      // choose the most plausible "total" sheet by max shows
      if (!total || agg.shows > total.shows) total = agg;
    }
  }
  return { total, catalog };
}

function computeSearchTotals(){
  const items = (state && state.clusters) ? state.clusters : [];
  const agg = {shows:0, clicks:0, cost:0, ctr:0, cpc:0};
  for (const c of items){ agg.shows += c.shows||0; agg.clicks += c.clicks||0; agg.cost += c.cost||0; }
  agg.ctr = agg.shows ? agg.clicks/agg.shows : 0;
  agg.cpc = agg.clicks ? agg.cost/agg.clicks : 0;
  return agg;
}

function fillZoneCard(prefix, m){
  const fmt = (n)=> (n==null? '—' : Number(n).toLocaleString('ru-RU'));
  const elS = document.getElementById(`z-${prefix}-shows`);  if (elS) elS.textContent  = fmt(m.shows||0);
  const elC = document.getElementById(`z-${prefix}-clicks`); if (elC) elC.textContent = fmt(m.clicks||0);
  const elCtr = document.getElementById(`z-${prefix}-ctr`);  if (elCtr) elCtr.textContent = ((m.ctr||0)*100).toFixed(2)+'%';
  const elCpc = document.getElementById(`z-${prefix}-cpc`);  if (elCpc) elCpc.textContent = (m.cpc||0).toFixed(2);
  const elCost= document.getElementById(`z-${prefix}-cost`); if (elCost) elCost.textContent= fmt(m.cost||0);
}

function updateZones(){
  try{
    const search = computeSearchTotals();
    const total = state.zonesTotal || null;
    const catalog = state.zonesCatalog || {shows:0, clicks:0, cost:0, ctr:0, cpc:0};
    let shelves = {shows:0, clicks:0, cost:0, ctr:0, cpc:0};
    if (total){
      shelves.shows = Math.max(0,(total.shows||0)-(search.shows||0)-(catalog.shows||0));
      shelves.clicks= Math.max(0,(total.clicks||0)-(search.clicks||0)-(catalog.clicks||0));
      shelves.cost  = Math.max(0,(total.cost||0)-(search.cost||0)-(catalog.cost||0));
      shelves.ctr   = shelves.shows ? shelves.clicks/shelves.shows : 0;
      shelves.cpc   = shelves.clicks ? shelves.cost/shelves.clicks : 0;
      fillZoneCard('total', total);
    } else {
      fillZoneCard('total', {shows:0, clicks:0, cost:0, ctr:0, cpc:0});
    }
    fillZoneCard('search',  search);
    fillZoneCard('catalog', catalog);
    fillZoneCard('shelves', shelves);
  }catch(e){ /* ignore */ }
}
