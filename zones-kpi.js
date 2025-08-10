
// zones-kpi.js — fills 'Итого/Поиск/Каталог/Полки' cards by parsing the XLSX returned by /fullstat
(function(){
  const log = (...a)=>console.debug('[WB-EXT][zones-kpi]', ...a);

  // guard
  if (window.__WB_ZONES_KPI_INSTALLED__) return;
  window.__WB_ZONES_KPI_INSTALLED__ = true;

  // tiny XML helper
  function parseXml(txt){ return new DOMParser().parseFromString(txt, 'application/xml'); }
  const ACode = 'A'.charCodeAt(0);
  function colToIdx(ref){
    // "AB12" -> 27
    let col = 0;
    for(let i=0;i<ref.length;i++){
      const ch = ref.charCodeAt(i);
      if (ch>=65 && ch<=90){ // A-Z
        col = col*26 + (ch-ACode+1);
      } else break;
    }
    return col-1;
  }
  function text(el){ return el && el.textContent ? el.textContent.trim() : ''; }

  async function parseXLSX(buf){
    if (!window.JSZip){ log('JSZip missing – cannot parse'); return null; }
    const zip = await JSZip.loadAsync(buf);
    const get = async (p)=> zip.file(p) ? await zip.file(p).async('string') : null;

    const wbk = parseXml(await get('xl/workbook.xml'));
    const sstXml = await get('xl/sharedStrings.xml');
    const sst = sstXml ? Array.from(parseXml(sstXml).getElementsByTagName('si')).map(si=>{
      const t = si.getElementsByTagName('t')[0];
      return t ? t.textContent : '';
    }) : [];

    // map sheetId -> path and name
    const sheets = {};
    Array.from(wbk.getElementsByTagName('sheet')).forEach(sh=>{
      const name = sh.getAttribute('name') || '';
      const rid = sh.getAttribute('r:id');
      sheets[rid] = { name };
    });

    // relationships to map rid -> sheetN.xml
    const rels = parseXml(await get('xl/_rels/workbook.xml.rels'));
    const rid2path = {};
    Array.from(rels.getElementsByTagName('Relationship')).forEach(r=>{
      rid2path[r.getAttribute('Id')] = r.getAttribute('Target');
    });
    Object.keys(sheets).forEach(rid=>{
      let p = rid2path[rid];
      if (p && !p.startsWith('xl/')) p = 'xl/' + p;
      sheets[rid].path = p;
    });

    // build array by name
    const byName = {};
    for (const rid in sheets){
      const {name, path} = sheets[rid];
      if (!path) continue;
      const xml = await get(path);
      if (!xml) continue;
      const doc = parseXml(xml);
      const rows = [];
      Array.from(doc.getElementsByTagName('row')).forEach(row=>{
        if (!row) return;
        let arr = [];
        Array.from(row.getElementsByTagName('c')).forEach(c=>{
          const t = c.getAttribute('t'); // s (shared), inlineStr, b, n
          const r = c.getAttribute('r') || 'A1';
          const idx = colToIdx(r);
          let v = '';
          let vNode = c.getElementsByTagName('v')[0];
          if (t === 's'){ // shared string
            const si = vNode ? parseInt(vNode.textContent,10) : NaN;
            v = Number.isFinite(si) ? (sst[si]||'') : '';
          } else if (t === 'inlineStr'){
            const tnode = c.getElementsByTagName('t')[0];
            v = tnode ? tnode.textContent : '';
          } else { // numeric or general
            v = vNode ? vNode.textContent : '';
          }
          // place into arr at idx
          while (arr.length <= idx) arr.push('');
          arr[idx] = v;
        });
        // normalize: trim
        arr = arr.map(x=> (typeof x === 'string') ? x.trim() : x);
        rows.push(arr);
      });
      byName[name.toLowerCase()] = {name, rows};
    }

    return byName;
  }

  function findHeaderIdx(headerRow){
    const norm = (s)=> (s||'').toString().trim().toLowerCase();
    const idx = { shows:-1, clicks:-1, cost:-1, ctr:-1, cpc:-1, cluster:-1, date:-1 };
    headerRow.forEach((v,i)=>{
      const n = norm(v);
      if (n.startsWith('показы')) idx.shows = i;
      else if (n.startsWith('клики')) idx.clicks = i;
      else if (n === 'затраты' || n.startsWith('расход')) idx.cost = i;
      else if (n === 'ctr') idx.ctr = i;
      else if (n === 'cpc' || n === 'спс') idx.cpc = i;
      else if (n.startsWith('кластер')) idx.cluster = i;
      else if (n.startsWith('дата') || n.startsWith('даты')) idx.date = i;
    });
    return idx;
  }

  function parseNumbers(v){
    if (v==null) return 0;
    let s = String(v).replace(/\s+/g,'').replace(' ','').replace(',', '.'); // also handle nbsp
    let num = parseFloat(s);
    return Number.isFinite(num) ? num : 0;
  }

  function sumBy(rows, idx){
    let shows=0, clicks=0, cost=0;
    for (let r=1; r<rows.length; r++){
      const row = rows[r];
      shows += parseNumbers(row[idx.shows]);
      clicks += parseNumbers(row[idx.clicks]);
      cost += parseNumbers(row[idx.cost]);
    }
    const ctr = shows > 0 ? (clicks/shows*100) : 0;
    const cpc = clicks > 0 ? (cost/clicks) : 0;
    return {shows, clicks, cost, ctr, cpc};
  }

  function fmtNum(n, frac=0){
    if (!Number.isFinite(n)) n = 0;
    const s = n.toLocaleString('ru-RU', {maximumFractionDigits: frac, minimumFractionDigits: frac});
    return s.replace(/\u00A0/g,' '); // no-break space -> regular
  }
  function fmtMoney(n){ return fmtNum(n, 2).replace('.', ','); }
  function setTexts(prefix, totals){
    const el = (id)=> document.getElementById(id);
    if (!el(prefix+'-shows')) return;
    el(prefix+'-shows').textContent   = fmtNum(totals.shows,0);
    el(prefix+'-clicks').textContent  = fmtNum(totals.clicks,0);
    el(prefix+'-ctr').textContent     = fmtNum(totals.ctr,2) + '%';
    el(prefix+'-cpc').textContent     = fmtMoney(totals.cpc);
    el(prefix+'-cost').textContent    = fmtMoney(totals.cost);
  }

  async function computeAndRenderFromXLSX(buf){
    try {
      const sheets = await parseXLSX(buf);
      if (!sheets){ return; }
      // pick sheets
      let overall = null, search = null, catalog = null, clusterSheet = null;
      for (const key in sheets){
        const nm = sheets[key].name.toLowerCase();
        if (nm.includes('каталог')) catalog = sheets[key];
        if (nm.includes('статистика') && !nm.includes('каталог')) overall = sheets[key];
        if (nm.includes('кластер')) clusterSheet = sheets[key];
      }
      // fallback: choose first sheet with "Кластер" in header
      if (!clusterSheet){
        for (const key in sheets){
          const rows = sheets[key].rows;
          if (rows && rows[0] && rows[0].some(v => String(v).toLowerCase().includes('кластер'))){
            clusterSheet = sheets[key]; break;
          }
        }
      }
      // totals
      const res = {};
      if (overall){
        const idx = findHeaderIdx(overall.rows[0]||[]);
        res.overall = sumBy(overall.rows, idx);
      }
      if (clusterSheet){
        const idx = findHeaderIdx(clusterSheet.rows[0]||[]);
        res.search = sumBy(clusterSheet.rows, idx);
      }
      if (catalog){
        const idx = findHeaderIdx(catalog.rows[0]||[]);
        res.catalog = sumBy(catalog.rows, idx);
      } else {
        res.catalog = {shows:0,clicks:0,cost:0,ctr:0,cpc:0};
      }
      if (!res.overall && res.search){
        // use search as baseline
        res.overall = {...res.search};
      }
      // shelves = overall - (search+catalog)
      const sh = {
        shows: (res.overall.shows||0) - (res.search.shows||0) - (res.catalog.shows||0),
        clicks: (res.overall.clicks||0) - (res.search.clicks||0) - (res.catalog.clicks||0),
        cost: (res.overall.cost||0) - (res.search.cost||0) - (res.catalog.cost||0)
      };
      sh.ctr = sh.shows>0? (sh.clicks/sh.shows*100):0;
      sh.cpc = sh.clicks>0? (sh.cost/sh.clicks):0;
      res.shelves = sh;

      // render
      setTexts('z-total', res.overall);
      setTexts('z-search', res.search);
      setTexts('z-catalog', res.catalog);
      setTexts('z-shelves', res.shelves);
      log('rendered KPI', res);
    } catch (e){
      log('computeAndRenderFromXLSX failed', e);
    }
  }

  // Hook fetch
  const origFetch = window.fetch;
  window.fetch = async function(input, init){
    let url = typeof input === 'string' ? input : (input && input.url);
    const resp = await origFetch(input, init);
    try{
      if (url && url.includes('/api/v3/fullstat')){
        const clone = resp.clone();
        const buf = await clone.arrayBuffer();
        computeAndRenderFromXLSX(buf);
      }
    }catch(e){ log('hook error', e); }
    return resp;
  };

  // Also, if app cached the last blob on page (e.g., via link object), try to reuse by listening to custom events if author emits them later.
})();
