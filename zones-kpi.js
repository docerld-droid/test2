/* zones-kpi.js — fills 'Итого/Поиск/Каталог' cards by parsing the XLSX returned by /fullstat */
(function(){
  const log = (...a)=>console.debug('[WB-EXT][zones-kpi]', ...a);

  if (window.__WB_ZONES_KPI_INSTALLED__) return;
  window.__WB_ZONES_KPI_INSTALLED__ = true;

  function parseXml(txt){ return new DOMParser().parseFromString(txt,'application/xml'); }
  const ACode='A'.charCodeAt(0);
  function colToIdx(ref){ let col=0; for(let i=0;i<ref.length;i++){ const ch=ref.charCodeAt(i); if(ch>=65&&ch<=90) col=col*26+(ch-ACode+1); else break;} return col-1; }
  function text(el){ return el&&el.textContent?el.textContent.trim():''; }

  async function unzipEntries(buf){
    const dv=new DataView(buf);
    function u32(o){ return dv.getUint32(o,true); }
    function u16(o){ return dv.getUint16(o,true); }
    const EOCD=0x06054b50, CD=0x02014b50, LFH=0x04034b50;
    let eocd=-1;
    for(let i=buf.byteLength-22;i>=0 && i>=buf.byteLength-65557;i--){ if(u32(i)===EOCD){eocd=i; break;} }
    if(eocd<0) throw new Error('ZIP EOCD not found');
    const cdSize=u32(eocd+12);
    const cdOffset=u32(eocd+16);
    let offset=cdOffset;
    const entries={};
    while(offset < cdOffset+cdSize){
      if(u32(offset)!==CD) break;
      const compMethod=u16(offset+10);
      const compSize=u32(offset+20);
      const fnLen=u16(offset+28);
      const extraLen=u16(offset+30);
      const commentLen=u16(offset+32);
      const lfhOffset=u32(offset+42);
      const filename=new TextDecoder().decode(new Uint8Array(buf, offset+46, fnLen));
      if(u32(lfhOffset)!==LFH) throw new Error('ZIP LFH missing');
      const lf_fnLen=u16(lfhOffset+26);
      const lf_extraLen=u16(lfhOffset+28);
      const dataStart=lfhOffset+30+lf_fnLen+lf_extraLen;
      const compSlice=buf.slice(dataStart, dataStart+compSize);
      entries[filename]={compMethod,compSlice};
      offset += 46+fnLen+extraLen+commentLen;
    }
    async function inflateRaw(slice){
      const stream=new DecompressionStream('deflate-raw');
      const r=new Response(new Blob([slice]).stream().pipeThrough(stream));
      return new Uint8Array(await r.arrayBuffer());
    }
    async function getText(name){
      const e=entries[name]; if(!e) return null;
      if(e.compMethod===0) return new TextDecoder().decode(new Uint8Array(e.compSlice));
      if(e.compMethod===8) return new TextDecoder().decode(await inflateRaw(e.compSlice));
      throw new Error('Unsupported compression '+e.compMethod);
    }
    return {getText, list:Object.keys(entries)};
  }

  async function parseXLSX(buf){
    const {getText} = await unzipEntries(buf);
    const wbkXml = await getText('xl/workbook.xml');
    if(!wbkXml) return null;
    const wbk = parseXml(wbkXml);
    const sstXml = await getText('xl/sharedStrings.xml');
    const sst = sstXml ? Array.from(parseXml(sstXml).getElementsByTagName('si')).map(si=>{
      const t = si.getElementsByTagName('t')[0];
      return t ? t.textContent : '';
    }) : [];

    const sheets = {};
    Array.from(wbk.getElementsByTagName('sheet')).forEach(sh=>{
      const name = sh.getAttribute('name') || '';
      const rid = sh.getAttribute('r:id');
      sheets[rid] = {name};
    });

    const relsXml = await getText('xl/_rels/workbook.xml.rels');
    const rels = relsXml ? parseXml(relsXml) : null;
    const rid2path = {};
    if(rels){
      Array.from(rels.getElementsByTagName('Relationship')).forEach(r=>{
        rid2path[r.getAttribute('Id')] = r.getAttribute('Target');
      });
    }
    Object.keys(sheets).forEach(rid=>{
      let p = rid2path[rid];
      if(p && !p.startsWith('xl/')) p = 'xl/' + p;
      sheets[rid].path = p;
    });

    const byName = {};
    for(const rid in sheets){
      const {name,path} = sheets[rid];
      if(!path) continue;
      const xml = await getText(path);
      if(!xml) continue;
      const doc = parseXml(xml);
      const rows = [];
      Array.from(doc.getElementsByTagName('row')).forEach(row=>{
        if(!row) return;
        let arr=[];
        Array.from(row.getElementsByTagName('c')).forEach(c=>{
          const t = c.getAttribute('t');
          const r = c.getAttribute('r') || 'A1';
          const idx = colToIdx(r);
          let v='';
          const vNode = c.getElementsByTagName('v')[0];
          if(t==='s'){
            const si = vNode ? parseInt(vNode.textContent,10) : NaN;
            v = Number.isFinite(si) ? (sst[si]||'') : '';
          } else if (t==='inlineStr'){
            const tnode = c.getElementsByTagName('t')[0];
            v = tnode ? tnode.textContent : '';
          } else {
            v = vNode ? vNode.textContent : '';
          }
          while(arr.length <= idx) arr.push('');
          arr[idx] = v;
        });
        arr = arr.map(x => typeof x === 'string' ? x.trim() : x);
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
    let s = String(v).replace(/\s+/g,'').replace('\u00A0','').replace(',', '.');
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
    const ctr = shows > 0 ? (clicks/shows) : 0;
    const cpc = clicks > 0 ? (cost/clicks) : 0;
    return {shows, clicks, cost, ctr, cpc};
  }

  function fmtNum(n, frac=0){
    if (!Number.isFinite(n)) n = 0;
    const s = n.toLocaleString('ru-RU', {maximumFractionDigits: frac, minimumFractionDigits: frac});
    return s.replace(/\u00A0/g,' ');
  }
  function fmtMoney(n){ return fmtNum(n, 2).replace('.', ','); }
  function setTexts(prefix, totals){
    const el = (id)=> document.getElementById(id);
    if (!el(prefix+'-shows')) return;
    el(prefix+'-shows').textContent   = fmtNum(totals.shows,0);
    el(prefix+'-clicks').textContent  = fmtNum(totals.clicks,0);
    el(prefix+'-ctr').textContent     = fmtNum(totals.ctr*100,2) + '%';
    el(prefix+'-cpc').textContent     = fmtMoney(totals.cpc);
    el(prefix+'-cost').textContent    = fmtMoney(totals.cost);
  }

  async function computeAndRenderFromXLSX(buf){
    try{
      log('computeAndRenderFromXLSX start', buf.byteLength);
      const sheets = await parseXLSX(buf);
      if (!sheets){ log('parseXLSX returned null'); return; }
      log('sheets found', Object.keys(sheets));
      let search=null, catalog=null, clusterSheet=null, statSheet=null;
      for (const key in sheets){
        const nm = sheets[key].name.toLowerCase();
        log('check sheet', nm);
        if (nm.trim()==='статистика') statSheet = sheets[key];
        else if (nm.includes('каталог')) catalog = sheets[key];
        else if (nm.includes('кластер') || nm.includes('ключевым')) clusterSheet = sheets[key];
      }
      if (!clusterSheet){
        for (const key in sheets){
          const rows = sheets[key].rows;
          if (rows && rows[0] && rows[0].some(v=>String(v).toLowerCase().includes('кластер'))){
            log('fallback cluster sheet', sheets[key].name);
            clusterSheet = sheets[key]; break;
          }
        }
      }
      const res = {};
      if (clusterSheet){
        log('cluster sheet rows', clusterSheet.rows.length);
        const idx = findHeaderIdx(clusterSheet.rows[0]||[]);
        log('cluster header idx', idx);
        res.search = sumBy(clusterSheet.rows, idx);
      } else {
        log('cluster sheet not found, using zeros');
        res.search = {shows:0,clicks:0,cost:0,ctr:0,cpc:0};
      }
      if (catalog){
        log('catalog sheet rows', catalog.rows.length);
        const idx = findHeaderIdx(catalog.rows[0]||[]);
        log('catalog header idx', idx);
        res.catalog = sumBy(catalog.rows, idx);
      } else {
        log('catalog sheet not found, using zeros');
        res.catalog = {shows:0,clicks:0,cost:0,ctr:0,cpc:0};
      }
      if (statSheet){
        log('stat sheet rows', statSheet.rows.length);
        const idx = findHeaderIdx(statSheet.rows[0]||[]);
        log('stat header idx', idx);
        let total = {shows:0,clicks:0,cost:0,ctr:0,cpc:0};
        for (let r=1; r<statSheet.rows.length; r++){
          const row = statSheet.rows[r];
          const first = (row[0]||'').toString().toLowerCase();
          if (first.includes('всего')){
            total.shows = parseNumbers(row[idx.shows]);
            total.clicks= parseNumbers(row[idx.clicks]);
            total.cost  = parseNumbers(row[idx.cost]);
            total.ctr = total.shows ? total.clicks/total.shows : 0;
            total.cpc = total.clicks ? total.cost/total.clicks : 0;
            log('total row', row);
            break;
          }
        }
        res.total = total;
      } else {
        log('stat sheet not found, deriving total from search+catalog');
        res.total = {
          shows:(res.search.shows||0)+(res.catalog.shows||0),
          clicks:(res.search.clicks||0)+(res.catalog.clicks||0),
          cost:(res.search.cost||0)+(res.catalog.cost||0)
        };
        res.total.ctr = res.total.shows ? res.total.clicks/res.total.shows : 0;
        res.total.cpc = res.total.clicks ? res.total.cost/res.total.clicks : 0;
      }

      log('computed KPI', res);
      document.dispatchEvent(new CustomEvent('wbZonesKPI', {detail: res}));

      setTexts('z-total',   res.total);
      setTexts('z-search',  res.search);
      setTexts('z-catalog', res.catalog);
      log('rendered KPI to DOM');
    }catch(e){
      log('computeAndRenderFromXLSX failed', e);
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function(input, init){
    let url = typeof input === 'string' ? input : (input && input.url);
    const resp = await origFetch(input, init);
    try{
      if (url && url.includes('/api/v3/fullstat')){
        log('intercept fullstat fetch', url);
        const clone = resp.clone();
        const buf = await clone.arrayBuffer();
        computeAndRenderFromXLSX(buf);
      }
    }catch(e){ log('hook error', e); }
    return resp;
  };
})();
