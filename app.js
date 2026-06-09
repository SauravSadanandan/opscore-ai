/* ============================================================
   OpsCore — PubScore BI Console (app.js) — v4
   Modules: AppStore, CloudSync, MetricsEngine, CSV, DOMManager
   ============================================================ */

const FIREBASE_CONFIG = {
  apiKey: null,
  authDomain: "opscore-database.firebaseapp.com",
  projectId: "opscore-database",
  storageBucket: "opscore-database.appspot.com",
  appId: "1:738267102673:web:18e776322ca775a75474f0"
};

let ACTIVE_TEAM_TOKEN = null;
const SESSION_KEY = "oc_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const THEME_KEY = "oc_theme";

/* ---------- Event bus ---------- */
const Bus = (() => {
  const subs = new Set();
  return {
    on(fn){ subs.add(fn); return ()=>subs.delete(fn); },
    emit(evt){ subs.forEach(fn=>{ try{ fn(evt); }catch(e){ console.error(e); } }); }
  };
})();

/* ---------- AppStore ---------- */
const AppStore = (() => {
  const K = {
    apps:'oc.apps.v2', pids:'oc.pids.v2', entries:'oc.entries', links:'oc.links',
    sel_apps:'oc.sel.apps', sel_pids:'oc.sel.pids', weights:'oc.weights'
  };
  const read = (k,fb)=>{ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):fb; }catch{ return fb; } };
  const write = (k,v)=> localStorage.setItem(k,JSON.stringify(v));

  const DEFAULT_WEIGHTS = {
    base:50, roas_hi:30, roas_md:15, rev_hi:20, rev_md:10,
    c2i_hi:20, c2i_md:10, fraud_hi:40, fraud_md:15
  };

  // Migrate legacy apps and pids
  const rawApps = read(K.apps,[]).concat(read('oc.apps',[]));
  const seenApp = new Set();
  const migratedApps = rawApps.map(a => ({
    id: a.id || crypto.randomUUID(),
    name: (a.name||'').trim(),
    vertical: (a.vertical||'').trim(),
    appName: (a.appName||'').trim()
  })).filter(a => a.name && !seenApp.has(a.name) && seenApp.add(a.name));

  const rawPids = read(K.pids,[]).concat(read('oc.pids',[]));
  const seenPid = new Set();
  const migratedPids = rawPids.map(p => ({
    id: p.id || crypto.randomUUID(),
    name: (p.name||'').trim(),
    pubNames: Array.isArray(p.pubNames) ? p.pubNames.filter(Boolean) : []
  })).filter(p => p.name && !seenPid.has(p.name) && seenPid.add(p.name));

  const state = {
    apps: migratedApps,
    pids: migratedPids,
    entries: read(K.entries,[]),
    links: read(K.links,[]),
    sel:{ apps:new Set(read(K.sel_apps,[])), pids:new Set(read(K.sel_pids,[])) },
    weights: { ...DEFAULT_WEIGHTS, ...read(K.weights,{}) },
    filters: { q:'', vertical:'', minC2I:null, maxFraud:null, minRev:null, minRoas:null }
  };

  function persist(slice){
    if(slice==='apps') write(K.apps,state.apps);
    if(slice==='pids') write(K.pids,state.pids);
    if(slice==='entries') write(K.entries,state.entries);
    if(slice==='links') write(K.links,state.links);
    if(slice==='sel'){ write(K.sel_apps,[...state.sel.apps]); write(K.sel_pids,[...state.sel.pids]); }
    if(slice==='weights') write(K.weights,state.weights);
    Bus.emit({type:slice});
  }
  return {
    state, persist, DEFAULT_WEIGHTS,
    addApp(name, vertical, appName){
      name=(name||'').trim(); vertical=(vertical||'').trim(); appName=(appName||'').trim();
      if(!name||!vertical) return null;
      if(state.apps.some(a=>a.name===name)) return null;
      const rec={id:crypto.randomUUID(), name, vertical, appName, ts:Date.now()};
      state.apps.push(rec); persist('apps'); return rec;
    },
    updateApp(id, patch){
      const a = state.apps.find(x=>x.id===id); if(!a) return;
      Object.assign(a, patch); persist('apps');
    },
    addPid(name, pubNames){
      name=(name||'').trim(); if(!name||state.pids.some(p=>p.name===name)) return null;
      const rec={id:crypto.randomUUID(), name, pubNames:Array.isArray(pubNames)?pubNames:[], ts:Date.now()};
      state.pids.push(rec); persist('pids'); return rec;
    },
    updatePid(id, patch){
      const p = state.pids.find(x=>x.id===id); if(!p) return;
      Object.assign(p, patch); persist('pids');
    },
    addPubToPid(id, pub){
      const p = state.pids.find(x=>x.id===id); if(!p) return;
      pub=(pub||'').trim(); if(!pub) return;
      if(!p.pubNames) p.pubNames=[];
      if(!p.pubNames.includes(pub)){ p.pubNames.push(pub); persist('pids'); }
    },
    removePubFromPid(id, pub){
      const p = state.pids.find(x=>x.id===id); if(!p) return;
      p.pubNames = (p.pubNames||[]).filter(x=>x!==pub); persist('pids');
    },
    removeApp(id){ state.apps=state.apps.filter(a=>a.id!==id); state.sel.apps.delete(id); persist('apps'); persist('sel'); },
    removePid(id){ state.pids=state.pids.filter(p=>p.id!==id); state.sel.pids.delete(id); persist('pids'); persist('sel'); },
    replaceApps(arr){ state.apps=arr; state.sel.apps=new Set([...state.sel.apps].filter(id=>arr.some(a=>a.id===id))); persist('apps'); persist('sel'); },
    replacePids(arr){ state.pids=arr; state.sel.pids=new Set([...state.sel.pids].filter(id=>arr.some(p=>p.id===id))); persist('pids'); persist('sel'); },
    toggleApp(id,on){ on? state.sel.apps.add(id) : state.sel.apps.delete(id); persist('sel'); },
    togglePid(id,on){ on? state.sel.pids.add(id) : state.sel.pids.delete(id); persist('sel'); },
    selectAllApps(){ state.apps.forEach(a=>state.sel.apps.add(a.id)); persist('sel'); },
    deselectAllApps(){ state.sel.apps.clear(); persist('sel'); },
    selectAllPids(){ state.pids.forEach(p=>state.sel.pids.add(p.id)); persist('sel'); },
    deselectAllPids(){ state.sel.pids.clear(); persist('sel'); },
    clearSel(){ state.sel.apps.clear(); state.sel.pids.clear(); persist('sel'); },
    addEntry(e){ const rec={id:crypto.randomUUID(), ts:Date.now(), ...e}; state.entries.unshift(rec); persist('entries'); return rec; },
    removeEntry(id){ state.entries=state.entries.filter(x=>x.id!==id); persist('entries'); },
    replaceEntries(arr){ state.entries=arr; persist('entries'); },
    addLink(rec){ const r={id:crypto.randomUUID(), createdAt:Date.now(), ...rec}; state.links.unshift(r); persist('links'); return r; },
    updateLink(id, patch){ const l = state.links.find(x=>x.id===id); if(!l) return; Object.assign(l, patch, {updatedAt:Date.now()}); persist('links'); },
    removeLink(id){ state.links=state.links.filter(x=>x.id!==id); persist('links'); },
    replaceLinks(arr){ state.links=arr; persist('links'); },
    purgeLinks(){ state.links=[]; persist('links'); },
    setWeights(w){ state.weights={...state.weights,...w}; persist('weights'); },
    resetWeights(){ state.weights={...DEFAULT_WEIGHTS}; persist('weights'); },
    setFilter(patch){ state.filters={...state.filters,...patch}; },
    purgeIntegration(){ state.apps=[]; state.pids=[]; state.sel.apps.clear(); state.sel.pids.clear(); persist('apps'); persist('pids'); persist('sel'); },
    purgeLedger(){ state.entries=[]; persist('entries'); }
  };
})();

/* ---------- MetricsEngine ---------- */
const MetricsEngine = (() => {
  const rate = (n,d)=> (d>0 ? (n/d)*100 : 0);
  function computeEntry(e){
    const installs=+e.installs||0, clicks=+e.clicks||0, events=+e.events||0;
    const finstalls=+e.finstalls||0, fevents=+e.fevents||0;
    const revenue=+e.revenue||0;
    const cost=(e.cost==null||e.cost==='')?null:+e.cost;
    const c2i = rate(installs, clicks);
    const i2e = rate(events, installs);
    const ifr = rate(finstalls, installs);
    const efr = rate(fevents, events);
    const totalFraud = installs+events>0 ? rate(finstalls+fevents, installs+events) : 0;
    const roas = (cost!=null && cost>0) ? (revenue/cost)*100 : null;
    return { c2i, i2e, ifr, efr, fraud:totalFraud, revenue, cost, roas };
  }
  function aggregate(entries){
    const groups = new Map();
    for(const e of entries){
      const key = (e.publisher||'').trim() || '(Unspecified)';
      if(!groups.has(key)) groups.set(key,{ publisher:key, verticals:new Set(), entries:[], sums:{
        clicks:0, installs:0, events:0, finstalls:0, fevents:0, revenue:0, cost:0, hasCost:false
      }});
      const g = groups.get(key);
      g.entries.push(e);
      if(e.vertical) g.verticals.add(e.vertical);
      g.sums.clicks += +e.clicks||0; g.sums.installs += +e.installs||0; g.sums.events += +e.events||0;
      g.sums.finstalls += +e.finstalls||0; g.sums.fevents += +e.fevents||0; g.sums.revenue += +e.revenue||0;
      if(e.cost!=null && e.cost!==''){ g.sums.cost += +e.cost||0; g.sums.hasCost=true; }
    }
    return [...groups.values()].map(g=>{
      const s=g.sums;
      const m = computeEntry({clicks:s.clicks, installs:s.installs, events:s.events, finstalls:s.finstalls, fevents:s.fevents, revenue:s.revenue, cost: s.hasCost? s.cost : null});
      return { ...g, verticals:[...g.verticals], metrics:m };
    });
  }
  function pubScore(m, w){
    let score = w.base;
    if(m.revenue > 5000) score += w.rev_hi; else if(m.revenue > 1000) score += w.rev_md;
    if(m.roas != null){ if(m.roas > 150) score += w.roas_hi; else if(m.roas > 100) score += w.roas_md; }
    if(m.c2i > 2) score += w.c2i_hi; else if(m.c2i > 1) score += w.c2i_md;
    if(m.fraud > 20) score -= w.fraud_hi; else if(m.fraud > 10) score -= w.fraud_md;
    return Math.max(0, Math.min(100, Math.round(score)));
  }
  function tier(score){ if(score >= 80) return 1; if(score >= 60) return 2; if(score >= 40) return 3; return 4; }
  return { rate, computeEntry, aggregate, pubScore, tier };
})();

/* ---------- CloudSync ---------- */
const CloudSync = (() => {
  let app=null, db=null, fns=null;
  let unsubEntries=null, unsubApps=null, unsubPids=null, unsubLinks=null;
  let status='disconnected';
  const listeners=new Set();
  const emit=()=> listeners.forEach(fn=>fn(status));
  let lastError = null;

  async function connect(cfg){
    if(location.protocol === 'file:'){
      lastError = 'Page is opened via file:// — Firebase requires http(s). Serve the folder or use GitHub Pages.';
      status='error'; emit(); return;
    }
    if(!cfg.apiKey||!cfg.appId||!cfg.projectId){
      lastError = 'Firebase config incomplete.'; status='error'; emit(); return;
    }
    if(!ACTIVE_TEAM_TOKEN){ lastError = 'Team token missing.'; status='error'; emit(); return; }
    status='connecting'; emit();
    try{
      const [{initializeApp}, firestore] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
      ]);
      app = initializeApp(cfg, 'opscore-'+Date.now());
      db = firestore.getFirestore(app);
      fns = firestore;

      const sub = (name, sort, replace) => {
        const ref = firestore.collection(db, name);
        const q = firestore.query(ref, firestore.where('teamToken','==',ACTIVE_TEAM_TOKEN));
        return firestore.onSnapshot(q, snap=>{
          const rows=[]; snap.forEach(d=> rows.push({ id:d.id, ...d.data() }));
          rows.sort(sort); replace(rows);
        }, err=> handleSnapErr(name, err));
      };

      unsubEntries = sub('publisher_matrix', (a,b)=>(b.ts||0)-(a.ts||0), rows=>{
        AppStore.replaceEntries(rows); DOMManager.afterEntries();
      });
      unsubApps = sub('integration_apps', (a,b)=>(a.ts||0)-(b.ts||0), rows=>{
        AppStore.replaceApps(rows); DOMManager.afterApps();
      });
      unsubPids = sub('integration_pids', (a,b)=>(a.ts||0)-(b.ts||0), rows=>{
        AppStore.replacePids(rows); DOMManager.afterPids();
      });
      unsubLinks = sub('link_genie_links', (a,b)=>(b.createdAt||0)-(a.createdAt||0), rows=>{
        AppStore.replaceLinks(rows); DOMManager.afterLinks();
      });

      status='connected'; lastError=null; emit();
    }catch(err){
      lastError = err && err.message || String(err);
      console.error('[CloudSync] connect failed:', err);
      status='error'; emit();
    }
  }
  function handleSnapErr(kind, err){
    lastError = `[${kind}] `+(err && err.message || String(err));
    console.error('[CloudSync] onSnapshot error:', kind, err);
    status='error'; emit();
  }

  const cloudOn = ()=> status==='connected';

  // --- Entries ---
  async function addEntry(rec){
    if(!cloudOn()) return AppStore.addEntry(rec);
    const ref = fns.doc(fns.collection(db,'publisher_matrix'));
    const payload = { ...rec, ts: rec.ts||Date.now(), teamToken: ACTIVE_TEAM_TOKEN };
    delete payload.id;
    await fns.setDoc(ref, payload);
  }
  async function removeEntry(id){
    if(!cloudOn()) return AppStore.removeEntry(id);
    await fns.deleteDoc(fns.doc(db,'publisher_matrix',id));
  }
  async function replaceAll(rows){
    if(!cloudOn()){ AppStore.replaceEntries(rows); return; }
    const colRef = fns.collection(db,'publisher_matrix');
    const q = fns.query(colRef, fns.where('teamToken','==',ACTIVE_TEAM_TOKEN));
    const snap = await fns.getDocs(q);
    const batch = fns.writeBatch(db);
    snap.forEach(d=> batch.delete(d.ref));
    rows.forEach(r=>{
      const ref = fns.doc(colRef);
      const {id, ...rest} = r;
      batch.set(ref, { ...rest, ts: rest.ts||Date.now(), teamToken: ACTIVE_TEAM_TOKEN });
    });
    await batch.commit();
  }

  // --- Apps ---
  async function addApp(name, vertical, appName){
    if(!cloudOn()) return AppStore.addApp(name, vertical, appName);
    name=(name||'').trim(); vertical=(vertical||'').trim(); appName=(appName||'').trim();
    if(!name||!vertical) return null;
    if(AppStore.state.apps.some(a=>a.name===name)) return null;
    const ref = fns.doc(fns.collection(db,'integration_apps'));
    await fns.setDoc(ref, { name, vertical, appName, ts:Date.now(), teamToken: ACTIVE_TEAM_TOKEN });
    return true;
  }
  async function updateApp(id, patch){
    if(!cloudOn()) return AppStore.updateApp(id, patch);
    await fns.updateDoc(fns.doc(db,'integration_apps',id), patch);
  }
  async function removeApp(id){
    if(!cloudOn()) return AppStore.removeApp(id);
    await fns.deleteDoc(fns.doc(db,'integration_apps',id));
  }

  // --- PIDs ---
  async function addPid(name, pubNames){
    if(!cloudOn()) return AppStore.addPid(name, pubNames);
    name=(name||'').trim();
    if(!name || AppStore.state.pids.some(p=>p.name===name)) return null;
    const ref = fns.doc(fns.collection(db,'integration_pids'));
    await fns.setDoc(ref, { name, pubNames:Array.isArray(pubNames)?pubNames:[], ts:Date.now(), teamToken: ACTIVE_TEAM_TOKEN });
    return true;
  }
  async function updatePid(id, patch){
    if(!cloudOn()) return AppStore.updatePid(id, patch);
    await fns.updateDoc(fns.doc(db,'integration_pids',id), patch);
  }
  async function addPubToPid(id, pub){
    const p = AppStore.state.pids.find(x=>x.id===id); if(!p) return;
    pub=(pub||'').trim(); if(!pub) return;
    const next = Array.isArray(p.pubNames)? [...p.pubNames] : [];
    if(!next.includes(pub)) next.push(pub);
    await updatePid(id, { pubNames: next });
  }
  async function removePubFromPid(id, pub){
    const p = AppStore.state.pids.find(x=>x.id===id); if(!p) return;
    const next = (p.pubNames||[]).filter(x=>x!==pub);
    await updatePid(id, { pubNames: next });
  }
  async function removePid(id){
    if(!cloudOn()) return AppStore.removePid(id);
    await fns.deleteDoc(fns.doc(db,'integration_pids',id));
  }
  async function purgeIntegrationCloud(){
    if(!cloudOn()) return;
    for(const col of ['integration_apps','integration_pids']){
      const colRef = fns.collection(db,col);
      const q = fns.query(colRef, fns.where('teamToken','==',ACTIVE_TEAM_TOKEN));
      const snap = await fns.getDocs(q);
      const batch = fns.writeBatch(db);
      snap.forEach(d=> batch.delete(d.ref));
      await batch.commit();
    }
  }

  // --- Links ---
  async function addLink(rec){
    if(!cloudOn()) return AppStore.addLink(rec);
    const ref = fns.doc(fns.collection(db,'link_genie_links'));
    const payload = { ...rec, createdAt: rec.createdAt||Date.now(), teamToken: ACTIVE_TEAM_TOKEN };
    delete payload.id;
    await fns.setDoc(ref, payload);
  }
  async function updateLink(id, patch){
    if(!cloudOn()) return AppStore.updateLink(id, patch);
    await fns.updateDoc(fns.doc(db,'link_genie_links',id), { ...patch, updatedAt:Date.now() });
  }
  async function removeLink(id){
    if(!cloudOn()) return AppStore.removeLink(id);
    await fns.deleteDoc(fns.doc(db,'link_genie_links',id));
  }
  async function purgeLinksCloud(){
    if(!cloudOn()){ AppStore.purgeLinks(); return; }
    const colRef = fns.collection(db,'link_genie_links');
    const q = fns.query(colRef, fns.where('teamToken','==',ACTIVE_TEAM_TOKEN));
    const snap = await fns.getDocs(q);
    const batch = fns.writeBatch(db);
    snap.forEach(d=> batch.delete(d.ref));
    await batch.commit();
  }

  return {
    connect, addEntry, removeEntry, replaceAll,
    addApp, updateApp, removeApp,
    addPid, updatePid, addPubToPid, removePubFromPid, removePid, purgeIntegrationCloud,
    addLink, updateLink, removeLink, purgeLinksCloud,
    onStatus(fn){ listeners.add(fn); fn(status); return ()=>listeners.delete(fn); },
    get status(){ return status; },
    get lastError(){ return lastError; }
  };
})();

/* ---------- CSV helpers ---------- */
const CSV = (() => {
  const cols = ['id','publisher','pid','app','appName','vertical','clicks','installs','events','finstalls','fevents','revenue','cost','ts'];
  const esc = v => { if(v==null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  function stringify(rows){
    const head = cols.join(',');
    const body = rows.map(r=> cols.map(c=>esc(r[c])).join(',')).join('\n');
    return head + '\n' + body;
  }
  function parse(text){
    const rows=[]; let i=0, field='', row=[], inQ=false;
    const push=()=>{ row.push(field); field=''; };
    const newRow=()=>{ push(); rows.push(row); row=[]; };
    while(i<text.length){
      const c=text[i];
      if(inQ){
        if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i+=2; continue; } inQ=false; i++; continue; }
        field+=c; i++; continue;
      }
      if(c==='"'){ inQ=true; i++; continue; }
      if(c===','){ push(); i++; continue; }
      if(c==='\r'){ i++; continue; }
      if(c==='\n'){ newRow(); i++; continue; }
      field+=c; i++;
    }
    if(field.length || row.length) newRow();
    if(!rows.length) return [];
    const header = rows.shift().map(h=>h.trim());
    const num = new Set(['clicks','installs','events','finstalls','fevents','revenue','cost','ts']);
    const optionalNullable = new Set(['cost']);
    return rows.filter(r=>r.length && r.some(v=>v!=='')).map(r=>{
      const o={};
      header.forEach((h,idx)=>{
        let v = r[idx]==null ? '' : r[idx];
        if(num.has(h)) v = (v===''||v==null) ? (optionalNullable.has(h)? null : 0) : Number(v);
        o[h]=v;
      });
      if(!o.id) o.id = crypto.randomUUID();
      if(!o.ts) o.ts = Date.now();
      return o;
    });
  }
  return { stringify, parse };
})();

/* ---------- DOMManager ---------- */
const DOMManager = (() => {
  const $=s=>document.querySelector(s);
  const $$=s=>document.querySelectorAll(s);
  const fmt = n => Number(n||0).toLocaleString();
  const pct = n => (Math.round((n||0)*100)/100).toFixed(2)+'%';
  const usd = n => (n==null||n==='')? '—' : new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(+n||0);
  function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  // App / Pid display labels
  const appLabel = a => a.appName ? `${a.appName}` : a.name;
  const appSub = a => a.appName ? a.name : (a.vertical || '');
  const pidLabel = p => p.name;
  const pidSub = p => (p.pubNames && p.pubNames.length) ? p.pubNames.join(', ') : '';

  function toast(msg, isErr){
    const t = $('#toast'); if(!t) return;
    t.textContent = msg; t.classList.toggle('err', !!isErr); t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), 2400);
  }

  /* ====== Combobox factory ====== */
  // kind: 'app' | 'pid' | 'pub'
  function mountCombobox(input, kind, opts={}){
    if(!input || input._comboMounted) return; input._comboMounted = true;
    const wrap = document.createElement('div'); wrap.className='combo-wrap';
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    input.autocomplete = 'off';
    const btn = document.createElement('button'); btn.type='button'; btn.className='combo-btn'; btn.textContent='▾';
    wrap.appendChild(btn);
    let list = null, activeIdx = -1, rows = [];

    function getItems(){
      const q = (input.value||'').toLowerCase().trim();
      if(kind==='app'){
        return AppStore.state.apps.map(a=>({
          value:a.name, lbl:appLabel(a), meta: a.appName ? `${a.name} · ${a.vertical||'—'}` : (a.vertical||''),
          searchText: `${a.name} ${a.appName||''} ${a.vertical||''}`.toLowerCase(), raw:a
        })).filter(it=> !q || it.searchText.includes(q))
          .sort((x,y)=>{
            const xs = x.searchText.startsWith(q)?0:1, ys = y.searchText.startsWith(q)?0:1;
            return xs-ys || x.lbl.localeCompare(y.lbl);
          });
      }
      if(kind==='pid'){
        return AppStore.state.pids.map(p=>({
          value:p.name, lbl:pidLabel(p), meta:pidSub(p),
          searchText:`${p.name} ${(p.pubNames||[]).join(' ')}`.toLowerCase(), raw:p
        })).filter(it=> !q || it.searchText.includes(q))
          .sort((x,y)=>{
            const xs = x.searchText.startsWith(q)?0:1, ys = y.searchText.startsWith(q)?0:1;
            return xs-ys || x.lbl.localeCompare(y.lbl);
          });
      }
      if(kind==='pub'){
        const set = new Set(); AppStore.state.pids.forEach(p=> (p.pubNames||[]).forEach(n=>set.add(n)));
        return [...set].filter(n=> !q || n.toLowerCase().includes(q)).map(n=>({value:n, lbl:n, meta:'', searchText:n.toLowerCase()}));
      }
      return [];
    }

    function close(){ if(list){ list.remove(); list=null; activeIdx=-1; } }
    function open(){
      close();
      rows = getItems();
      list = document.createElement('div'); list.className='combo-list';
      const q = (input.value||'').trim();
      const exact = rows.some(r=> r.value.toLowerCase() === q.toLowerCase());
      if(!rows.length){
        const e = document.createElement('div'); e.className='empty';
        e.textContent = q ? `No ${kind} matches "${q}".` : `No ${kind} yet — type to create.`;
        list.appendChild(e);
      } else {
        rows.forEach((it,i)=>{
          const li = document.createElement('div'); li.className='row-li';
          li.innerHTML = `<span class="lbl">${escapeHtml(it.lbl)}</span>${it.meta? `<span class="meta">${escapeHtml(it.meta)}</span>`:''}`;
          li.addEventListener('mousedown', e=>{ e.preventDefault(); select(it); });
          list.appendChild(li);
        });
      }
      if(q && !exact && opts.allowCreate !== false){
        const c = document.createElement('div'); c.className='create';
        c.textContent = `+ Create new ${kind==='app'?'App':'PID'}: "${q}"`;
        c.addEventListener('mousedown', e=>{ e.preventDefault(); close(); opts.onCreate && opts.onCreate(q); });
        list.appendChild(c);
      }
      wrap.appendChild(list);
    }
    function select(item){
      input.value = item.value;
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      close();
      opts.onSelect && opts.onSelect(item.raw, item.value);
    }
    function highlight(d){
      if(!list) return;
      const items = list.querySelectorAll('.row-li');
      activeIdx = Math.max(0, Math.min(items.length-1, activeIdx + d));
      items.forEach((el,i)=> el.classList.toggle('active', i===activeIdx));
      items[activeIdx] && items[activeIdx].scrollIntoView({block:'nearest'});
    }
    input.addEventListener('input', open);
    input.addEventListener('focus', open);
    input.addEventListener('keydown', e=>{
      if(!list) return;
      if(e.key==='ArrowDown'){ e.preventDefault(); highlight(1); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); highlight(-1); }
      else if(e.key==='Enter'){
        if(activeIdx>=0 && rows[activeIdx]){ e.preventDefault(); select(rows[activeIdx]); }
        else { close(); }
      } else if(e.key==='Escape'){ close(); }
    });
    btn.addEventListener('mousedown', e=>{ e.preventDefault(); if(list) close(); else { input.focus(); open(); } });
    document.addEventListener('mousedown', e=>{ if(!wrap.contains(e.target)) close(); });
    Bus.on(evt=>{ if(list && (evt.type==='apps'||evt.type==='pids')) open(); });
  }

  /* ====== Boot ====== */
  function bind(){
    bindLogin(); bindTheme(); bindTabs();
    bindIntegration(); bindPubScore(); bindLinkGenie();
    CloudSync.onStatus(s=>{
      const pill=$('#syncPill'), txt=$('#syncPillText');
      pill.classList.toggle('on', s==='connected'); pill.classList.toggle('off', s!=='connected');
      txt.textContent = s==='connected'?'Cloud Synced' : s==='connecting'?'Connecting…' : s==='error'?'Sync Error':'Local mode';
      pill.title = s==='error' && CloudSync.lastError ? CloudSync.lastError : (s==='connected'?'Connected to Firestore':'Not connected');
    });
  }

  function bindLogin(){
    $('#loginForm').addEventListener('submit',(e)=>{
      e.preventDefault();
      const apiKey = $('#loginUser').value.trim();
      const teamToken = $('#loginPass').value.trim();
      const err = $('#loginErr');
      if(!apiKey || !teamToken){ err.textContent='Both API Key and Team Token are required.'; err.style.display='block'; return; }
      const session = { apiKey, teamToken, timestamp:Date.now() };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      FIREBASE_CONFIG.apiKey = apiKey;
      ACTIVE_TEAM_TOKEN = teamToken;
      $('#loginOverlay').style.display='none';
      err.style.display='none';
      initAppSystems();
    });
    $('#logoutBtn').addEventListener('click',()=>{ localStorage.removeItem(SESSION_KEY); window.location.reload(); });
  }

  function bindTheme(){
    const stored = (()=>{ try{ return JSON.parse(localStorage.getItem(THEME_KEY))||{}; }catch{ return {}; } })();
    const preset = stored.preset || 'crimson';
    const mode = stored.mode || 'light';
    applyTheme(preset, mode);
    $$('.swatch').forEach(s=> s.addEventListener('click',()=> applyTheme(s.dataset.themePreset, document.documentElement.dataset.mode)));
    $('#modeToggle').addEventListener('click',()=>{
      const next = document.documentElement.dataset.mode==='dark'?'light':'dark';
      applyTheme(document.documentElement.dataset.theme, next);
    });
  }
  function applyTheme(preset, mode){
    document.documentElement.dataset.theme = preset;
    document.documentElement.dataset.mode = mode;
    $$('.swatch').forEach(s=> s.classList.toggle('active', s.dataset.themePreset===preset));
    const mt = $('#modeToggle'); if(mt) mt.textContent = mode==='dark'?'☀️':'🌙';
    try{ localStorage.setItem(THEME_KEY, JSON.stringify({preset, mode})); }catch{}
  }

  function bindTabs(){
    $$('.topbar .tab').forEach(t=> t.addEventListener('click',()=>{
      $$('.topbar .tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      const id=t.dataset.tab;
      $('#tab-matrix').classList.toggle('hidden', id!=='matrix');
      $('#tab-analyzer').classList.toggle('hidden', id!=='analyzer');
      $('#tab-linkgenie').classList.toggle('hidden', id!=='linkgenie');
      if(id==='linkgenie') LinkGenie.ensureMount();
    }));
  }

  /* ====== Integration tab ====== */
  function bindIntegration(){
    $('#addAppForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const name = $('#appInput').value.trim();
      const vert = $('#appVertical').value.trim();
      const friendly = $('#appName').value.trim();
      if(!name || !vert){ toast('App ID and Vertical are required.', true); return; }
      if(AppStore.state.apps.some(a=>a.name===name)){ toast('That App ID already exists.', true); return; }
      try{ await CloudSync.addApp(name, vert, friendly); }catch(err){ toast('Add app failed: '+err.message, true); }
      $('#appInput').value=''; $('#appVertical').value=''; $('#appName').value='';
      renderAssets(); renderTopOptions();
    });
    $('#addPidForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const name = $('#pidInput').value.trim();
      const pubs = $('#pidPubs').value.split(',').map(s=>s.trim()).filter(Boolean);
      if(!name) return;
      if(AppStore.state.pids.some(p=>p.name===name)){ toast('That PID already exists.', true); return; }
      try{ await CloudSync.addPid(name, pubs); }catch(err){ toast('Add PID failed: '+err.message, true); }
      $('#pidInput').value=''; $('#pidPubs').value=''; renderAssets();
    });
    $('#launchBtn').addEventListener('click', launchMatrix);
    $('#clearSelBtn').addEventListener('click',()=>{ AppStore.clearSel(); renderAssets(); });
    $('#appSelAll').addEventListener('click',()=>{ AppStore.selectAllApps(); renderAssets(); });
    $('#appDeselAll').addEventListener('click',()=>{ AppStore.deselectAllApps(); renderAssets(); });
    $('#pidSelAll').addEventListener('click',()=>{ AppStore.selectAllPids(); renderAssets(); });
    $('#pidDeselAll').addEventListener('click',()=>{ AppStore.deselectAllPids(); renderAssets(); });
    $('#purgeIntegrationBtn').addEventListener('click', async ()=>{
      if(!confirm('Purge ALL App IDs and PIDs? Ledger entries are NOT affected.')) return;
      try{ if(CloudSync.status==='connected') await CloudSync.purgeIntegrationCloud(); AppStore.purgeIntegration(); }catch(err){ toast('Purge failed: '+err.message,true); }
      renderAssets();
    });
  }

  function renderAssets(){
    const {apps,pids,sel}=AppStore.state;
    const appUL=$('#appList'), pidUL=$('#pidList'); if(!appUL || !pidUL) return;
    appUL.innerHTML=''; pidUL.innerHTML='';

    apps.forEach(a=>{
      const li=document.createElement('li'); li.className='fade-in';
      li.innerHTML=`<input class="chk" type="checkbox" ${sel.apps.has(a.id)?'checked':''}/>
        <span class="name" title="${escapeHtml(a.name)}">
          <span class="friendly">${escapeHtml(appLabel(a))}</span>
          ${a.appName? `<span class="raw">${escapeHtml(a.name)}</span>`:''}
        </span>
        <span class="vert">${escapeHtml(a.vertical||'—')}</span>
        <button class="iconbtn editApp" title="Edit name/vertical">✎</button>
        <button class="iconbtn rmApp" title="Remove">✕</button>`;
      li.querySelector('.chk').addEventListener('change',e=>{ AppStore.toggleApp(a.id,e.target.checked); renderMatrix(); });
      li.querySelector('.rmApp').addEventListener('click', async ()=>{
        if(!confirm('Remove App "'+(a.appName||a.name)+'"?')) return;
        try{ await CloudSync.removeApp(a.id); }catch(err){ toast('Remove failed: '+err.message,true); }
        renderAssets();
      });
      li.querySelector('.editApp').addEventListener('click', async ()=>{
        const newName = prompt('App Name (optional friendly label):', a.appName||'');
        if(newName===null) return;
        const newVert = prompt('Vertical:', a.vertical||'');
        if(newVert===null) return;
        try{ await CloudSync.updateApp(a.id, { appName:newName.trim(), vertical:newVert.trim() }); }catch(err){ toast('Update failed: '+err.message,true); }
        renderAssets();
      });
      appUL.appendChild(li);
    });

    pids.forEach(p=>{
      const li=document.createElement('li'); li.className='fade-in';
      const chips = (p.pubNames||[]).map(pn=>`<span class="chip" data-pub="${escapeHtml(pn)}">${escapeHtml(pn)}<span class="x" title="Remove publisher">✕</span></span>`).join('');
      li.innerHTML=`<input class="chk" type="checkbox" ${sel.pids.has(p.id)?'checked':''}/>
        <span class="name"><span class="friendly mono">${escapeHtml(p.name)}</span></span>
        <button class="iconbtn rmPid" title="Remove">✕</button>
        <div class="pubchips">${chips}<span class="chip add" title="Add publisher">+ pub</span></div>`;
      li.querySelector('.chk').addEventListener('change',e=>{ AppStore.togglePid(p.id,e.target.checked); renderMatrix(); });
      li.querySelector('.rmPid').addEventListener('click', async ()=>{
        if(!confirm('Remove PID "'+p.name+'"?')) return;
        try{ await CloudSync.removePid(p.id); }catch(err){ toast('Remove failed: '+err.message,true); }
        renderAssets();
      });
      li.querySelector('.chip.add').addEventListener('click', async ()=>{
        const pub = prompt('Publisher name to associate with PID '+p.name+':'); if(!pub) return;
        try{ await CloudSync.addPubToPid(p.id, pub.trim()); }catch(err){ toast('Add pub failed: '+err.message,true); }
        renderAssets();
      });
      li.querySelectorAll('.chip[data-pub] .x').forEach(x=> x.addEventListener('click', async ()=>{
        const pub = x.parentElement.dataset.pub;
        if(!confirm('Remove "'+pub+'" from PID '+p.name+'?')) return;
        try{ await CloudSync.removePubFromPid(p.id, pub); }catch(err){ toast('Remove pub failed: '+err.message,true); }
        renderAssets();
      }));
      pidUL.appendChild(li);
    });

    $('#appsCount').textContent = apps.length+' total';
    $('#pidsCount').textContent = pids.length+' total';
    renderMatrix();
    const cApps=$('#ctxApps'), cPids=$('#ctxPids');
    if(cApps) cApps.textContent=apps.length;
    if(cPids) cPids.textContent=pids.length;
  }

  function renderMatrix(){
    const {apps,pids,sel}=AppStore.state;
    const sa=apps.filter(a=>sel.apps.has(a.id));
    const sp=pids.filter(p=>sel.pids.has(p.id));
    const grid=$('#matrixGrid');
    if(!sa.length || !sp.length){
      grid.innerHTML='<span class="muted">Add and select at least one App ID and one PID to build a launch matrix.</span>';
      $('#matrixCount').textContent='0 pairs selected'; return;
    }
    const rows = sa.map(a=>`<tr><td class="mono" style="font-size:12px">${escapeHtml(appLabel(a))}</td>${sp.map(p=>`<td class="mono muted" style="font-size:11.5px">→ ${escapeHtml(p.name)}</td>`).join('')}</tr>`).join('');
    grid.innerHTML = `<div class="table-wrap"><table><thead><tr><th>App</th>${sp.map(p=>`<th>${escapeHtml(p.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    const n = sa.length*sp.length;
    $('#matrixCount').textContent = n+' pair'+(n===1?'':'s')+' selected';
  }

  function launchMatrix(){
    const {apps,pids,sel}=AppStore.state;
    const sa=apps.filter(a=>sel.apps.has(a.id)); const sp=pids.filter(p=>sel.pids.has(p.id));
    const pairs=[]; sa.forEach(a=> sp.forEach(p=> pairs.push([a.name,p.name])));
    if(!pairs.length){ toast('Select at least one App and one PID.', true); return; }
    if(pairs.length>12 && !confirm('Open '+pairs.length+' tabs?')) return;
    let blocked=0;
    pairs.forEach(([app,pid])=>{
      const u=`https://hq1.appsflyer.com/marketplace/integrated-partners/${encodeURIComponent(app)}/${encodeURIComponent(pid)}`;
      const w=window.open(u,'_blank','noopener'); if(!w) blocked++;
    });
    if(blocked) toast(blocked+' tab(s) blocked. Allow pop-ups.', true);
  }

  /* ====== PubScore tab ====== */
  function bindPubScore(){
    // Filters
    const fltMap = [['#flt_q','q','string'],['#flt_vertical','vertical','string'],
      ['#flt_c2i','minC2I','num'],['#flt_fraud','maxFraud','num'],
      ['#flt_rev','minRev','num'],['#flt_roas','minRoas','num']];
    fltMap.forEach(([sel,key,kind])=>{
      const el=$(sel);
      const h = e=>{ const v=e.target.value; AppStore.setFilter({[key]: kind==='num'?(v===''?null:Number(v)):v}); renderLedger(); };
      el.addEventListener('input', h); el.addEventListener('change', h);
    });
    $('#flt_clear').addEventListener('click',()=>{
      ['#flt_q','#flt_c2i','#flt_fraud','#flt_rev','#flt_roas'].forEach(s=>$(s).value='');
      $('#flt_vertical').value='';
      AppStore.setFilter({q:'',vertical:'',minC2I:null,maxFraud:null,minRev:null,minRoas:null}); renderLedger();
    });

    // Top pubs
    ['#top_metric','#top_vertical','#top_count'].forEach(s=> $(s).addEventListener('change', renderTopPubs));

    // Weights
    hydrateWeightInputs();
    $$('.wt').forEach(inp=> inp.addEventListener('input',()=>{
      const key = inp.id.replace(/^w_/,''); const v = Number(inp.value)||0;
      AppStore.setWeights({[key]:v}); if(key==='base') $('#w_base_display').textContent=v;
      renderLedger(); renderTopPubs();
    }));
    $('#weightsReset').addEventListener('click',()=>{ AppStore.resetWeights(); hydrateWeightInputs(); renderLedger(); renderTopPubs(); });

    // CSV
    $('#exportCsv').addEventListener('click', exportCsv);
    $('#importBtn').addEventListener('click',()=>$('#importFile').click());
    $('#importFile').addEventListener('change',e=>{ const f=e.target.files[0]; if(f) importCsvFile(f); e.target.value=''; });
    $('#downloadTpl').addEventListener('click', downloadTemplate);
    const dz=$('#drop');
    ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag');}));
    ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag');}));
    dz.addEventListener('drop',e=>{ const f=e.dataTransfer.files[0]; if(f) importCsvFile(f); });
    $('#purgeBtn').addEventListener('click', async ()=>{
      if(!confirm('Purge ALL PubScore ledger entries?')) return;
      try{ if(CloudSync.status==='connected') await CloudSync.replaceAll([]); else AppStore.purgeLedger(); }catch(err){ toast('Purge failed: '+err.message,true); }
      renderLedger(); renderTopPubs();
    });

    // Drawer
    $('#settingsCog').addEventListener('click', openDrawer);
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerOverlay').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeDrawer(); });

    // Entry form comboboxes
    mountCombobox($('#f_app'), 'app', { onSelect:(rec)=>{
      $('#f_vertical').value = rec ? (rec.vertical||'') : '';
      $('#f_newAppPanel').classList.add('hidden');
    }, onCreate:(val)=>{
      $('#f_app').value = val;
      $('#f_newAppPanel').classList.remove('hidden');
      $('#f_newAppVert').focus();
    }});
    mountCombobox($('#f_pid'), 'pid', { onSelect:()=> $('#f_newPidPanel').classList.add('hidden'),
      onCreate:(val)=>{ $('#f_pid').value=val; $('#f_newPidPanel').classList.remove('hidden'); $('#f_newPidPubs').focus(); }});

    // App vertical auto-fill on free text change (if matches existing)
    $('#f_app').addEventListener('input',()=>{
      const v = $('#f_app').value.trim();
      const a = AppStore.state.apps.find(x=> x.name===v);
      $('#f_vertical').value = a ? (a.vertical||'') : '';
      $('#f_newAppPanel').classList.toggle('hidden', !v || !!a);
    });
    $('#f_pid').addEventListener('input',()=>{
      const v = $('#f_pid').value.trim();
      const p = AppStore.state.pids.find(x=>x.name===v);
      $('#f_newPidPanel').classList.toggle('hidden', !v || !!p);
    });

    $('#f_newAppCreate').addEventListener('click', async ()=>{
      const name = $('#f_app').value.trim();
      const vert = $('#f_newAppVert').value.trim();
      const friendly = $('#f_newAppName').value.trim();
      if(!name || !vert){ toast('App ID and Vertical required.', true); return; }
      try{ await CloudSync.addApp(name, vert, friendly); }catch(err){ toast('Create app failed: '+err.message,true); return; }
      $('#f_vertical').value = vert;
      $('#f_newAppName').value=''; $('#f_newAppVert').value='';
      $('#f_newAppPanel').classList.add('hidden');
      toast('App created.');
    });
    $('#f_newPidCreate').addEventListener('click', async ()=>{
      const name = $('#f_pid').value.trim();
      const pubs = $('#f_newPidPubs').value.split(',').map(s=>s.trim()).filter(Boolean);
      if(!name){ toast('PID required.', true); return; }
      try{ await CloudSync.addPid(name, pubs); }catch(err){ toast('Create PID failed: '+err.message,true); return; }
      $('#f_newPidPubs').value=''; $('#f_newPidPanel').classList.add('hidden');
      toast('PID created.');
    });

    $('#entryForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const appName = $('#f_app').value.trim();
      const appRec = AppStore.state.apps.find(a=>a.name===appName);
      if(!appRec){ toast('Pick or create an App ID first.', true); return; }
      const costVal = $('#f_cost').value;
      const rec = {
        publisher: $('#f_pub').value.trim(),
        pid: $('#f_pid').value.trim(),
        app: appRec.name, appName: appRec.appName||'',
        vertical: appRec.vertical,
        clicks:+$('#f_clicks').value||0, installs:+$('#f_installs').value||0,
        events:+$('#f_events').value||0, finstalls:+$('#f_finstalls').value||0,
        fevents:+$('#f_fevents').value||0, revenue:+$('#f_revenue').value||0,
        cost: costVal===''? null : Number(costVal),
      };
      try{ await CloudSync.addEntry(rec); }catch(err){ toast('Add failed: '+err.message,true); return; }
      e.target.reset();
      ['f_clicks','f_installs','f_events','f_finstalls','f_fevents','f_revenue'].forEach(id=>$('#'+id).value=0);
      $('#f_vertical').value='';
      toast('Entry added.');
      renderLedger(); renderTopPubs();
    });
  }

  function openDrawer(){
    $('#settingsDrawer').classList.remove('hidden');
    $('#drawerOverlay').classList.remove('hidden');
    $('#settingsDrawer').setAttribute('aria-hidden','false');
  }
  function closeDrawer(){
    $('#settingsDrawer').classList.add('hidden');
    $('#drawerOverlay').classList.add('hidden');
    $('#settingsDrawer').setAttribute('aria-hidden','true');
  }

  function hydrateWeightInputs(){
    const w = AppStore.state.weights;
    Object.keys(w).forEach(k=>{ const el = document.getElementById('w_'+k); if(el) el.value = w[k]; });
    const bd = document.getElementById('w_base_display'); if(bd) bd.textContent = w.base;
  }

  function renderTopOptions(){
    const verts = [...new Set(AppStore.state.apps.map(a=>a.vertical).filter(Boolean))].sort();
    [['#flt_vertical','All'],['#top_vertical','All verticals']].forEach(([s,label])=>{
      const el=$(s); if(!el) return;
      const c = el.value;
      el.innerHTML = `<option value="">${label}</option>` + verts.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
      if(c && verts.includes(c)) el.value=c;
    });
  }

  function applyFilters(groups){
    const f = AppStore.state.filters; const q = (f.q||'').trim().toLowerCase();
    return groups.filter(g=>{
      if(q){
        const inPub = g.publisher.toLowerCase().includes(q);
        const inPid = g.entries.some(e=> String(e.pid||'').toLowerCase().includes(q));
        if(!inPub && !inPid) return false;
      }
      if(f.vertical && !g.verticals.includes(f.vertical)) return false;
      const m = g.metrics;
      if(f.minC2I!=null && m.c2i < f.minC2I) return false;
      if(f.maxFraud!=null && m.fraud > f.maxFraud) return false;
      if(f.minRev!=null && m.revenue < f.minRev) return false;
      if(f.minRoas!=null){ if(m.roas==null || m.roas < f.minRoas) return false; }
      return true;
    });
  }
  function tierBadge(t){
    const map={1:['t1','Tier 1 · Premium'],2:['t2','Tier 2 · Baseline'],3:['t3','Tier 3 · Monitor'],4:['t4','Tier 4 · Flagged']};
    const [cls,label]=map[t]; return `<span class="tier ${cls}"><span class="led"></span>${label}</span>`;
  }
  function renderLedger(){
    const tbody=$('#ledgerBody'); if(!tbody) return;
    const groups = MetricsEngine.aggregate(AppStore.state.entries);
    const filtered = applyFilters(groups).sort((a,b)=> b.metrics.revenue - a.metrics.revenue);
    $('#ledgerCount').textContent = filtered.length;
    if(!filtered.length){ tbody.innerHTML='<tr><td colspan="9" class="muted" style="padding:20px;text-align:center">No publishers match the current filters.</td></tr>'; return; }
    const w = AppStore.state.weights;
    tbody.innerHTML = filtered.map(g=>{
      const m=g.metrics; const score = MetricsEngine.pubScore(m,w); const t = MetricsEngine.tier(score);
      const roasCell = m.roas==null ? '<span class="big muted">—</span><span class="sub">no cost data</span>' : `<span class="big">${pct(m.roas)}</span>`;
      const drill = renderDrill(g.entries);
      const vertLabel = g.verticals.length ? g.verticals.join(', ') : '—';
      return `<tr class="fade-in">
        <td><span class="big">${escapeHtml(g.publisher)}</span><span class="sub">${g.entries.length} PID${g.entries.length===1?'':'s'} · ${escapeHtml(vertLabel)}</span>${drill}</td>
        <td><span class="big">${score}</span><span class="sub">of 100</span><div class="score-bar"><span style="width:${score}%"></span></div></td>
        <td><span class="big">${pct(m.c2i)}</span><span class="sub">(${fmt(g.sums.installs)} / ${fmt(g.sums.clicks)} clicks)</span></td>
        <td><span class="big">${pct(m.i2e)}</span><span class="sub">context only</span></td>
        <td><span class="big">${pct(m.fraud)}</span><span class="sub">I:${pct(m.ifr)} · E:${pct(m.efr)}</span></td>
        <td><span class="big">${usd(m.revenue)}</span><span class="sub">cost ${usd(g.sums.hasCost? g.sums.cost : null)}</span></td>
        <td>${roasCell}</td><td>${tierBadge(t)}</td>
        <td><button class="iconbtn" data-pub="${escapeHtml(g.publisher)}" title="Delete all PIDs">✕</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.iconbtn').forEach(b=> b.addEventListener('click', async ()=>{
      const pub=b.dataset.pub;
      if(!confirm('Delete ALL entries for publisher "'+pub+'"?')) return;
      const targets = AppStore.state.entries.filter(e=> (e.publisher||'(Unspecified)').trim()===pub);
      for(const e of targets){ try{ await CloudSync.removeEntry(e.id); }catch(err){ toast('Delete failed: '+err.message,true); } }
      renderLedger(); renderTopPubs();
    }));
  }
  function renderDrill(entries){
    if(!entries.length) return '';
    const rows = entries.map(e=>{
      const m = MetricsEngine.computeEntry(e);
      const roas = m.roas==null? '—' : pct(m.roas);
      const appShow = e.appName ? `${escapeHtml(e.appName)} · ${escapeHtml(e.app||'')}` : escapeHtml(e.app||'');
      return `<tr><td class="mono">${escapeHtml(e.pid||'—')}</td><td>${appShow}</td><td>${escapeHtml(e.vertical||'—')}</td><td>${pct(m.c2i)}</td><td>${pct(m.fraud)}</td><td>${usd(m.revenue)}</td><td>${roas}</td></tr>`;
    }).join('');
    return `<details class="pid-drill"><summary>View ${entries.length} PID${entries.length===1?'':'s'}</summary>
      <table class="drill-table"><thead><tr><th>PID</th><th>App</th><th>Vertical</th><th>C2I</th><th>Fraud</th><th>Revenue</th><th>ROAS</th></tr></thead><tbody>${rows}</tbody></table></details>`;
  }
  function renderTopPubs(){
    const tbody = $('#topPubsBody'); if(!tbody) return;
    const metric = $('#top_metric').value, vertical = $('#top_vertical').value, n = +$('#top_count').value || 5;
    const w = AppStore.state.weights;
    let groups = MetricsEngine.aggregate(AppStore.state.entries);
    if(vertical) groups = groups.filter(g=> g.verticals.includes(vertical));
    const scored = groups.map(g=>{
      const score = MetricsEngine.pubScore(g.metrics, w);
      let val, valLabel;
      switch(metric){
        case 'score': val=score; valLabel=score+' / 100'; break;
        case 'fraud': val=g.metrics.fraud; valLabel=pct(g.metrics.fraud); break;
        case 'roas':  val=g.metrics.roas; valLabel=g.metrics.roas==null?'—':pct(g.metrics.roas); break;
        case 'c2i':   val=g.metrics.c2i; valLabel=pct(g.metrics.c2i); break;
        default:      val=g.metrics.revenue; valLabel=usd(g.metrics.revenue);
      }
      return { g, score, val, valLabel };
    });
    if(metric==='fraud') scored.sort((a,b)=> (a.val??Infinity) - (b.val??Infinity));
    else scored.sort((a,b)=> (b.val??-Infinity) - (a.val??-Infinity));
    const colTitle = {revenue:'Revenue', score:'PubScore', fraud:'Fraud (low→high)', roas:'ROAS', c2i:'C2I'}[metric];
    $('#topMetricCol').textContent = colTitle;
    const top = scored.slice(0, n);
    if(!top.length){ tbody.innerHTML='<tr><td colspan="5" class="muted" style="padding:14px;text-align:center">No matching publishers.</td></tr>'; return; }
    tbody.innerHTML = top.map((r,i)=>`<tr><td><span class="big">${i+1}</span></td><td><span class="big">${escapeHtml(r.g.publisher)}</span></td><td>${escapeHtml(r.g.verticals.join(', ')||'—')}</td><td><span class="big">${r.valLabel}</span></td><td>${r.score}</td></tr>`).join('');
  }
  function exportCsv(){
    const csv = CSV.stringify(AppStore.state.entries);
    const blob = new Blob([csv],{type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='opscore_pubscore_backup.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  async function importCsvFile(file){
    try{
      const text = await file.text();
      const rows = CSV.parse(text);
      if(!rows.length){ toast('CSV contained no rows.', true); return; }
      if(!confirm('Import '+rows.length+' entries? This replaces the current ledger.')) return;
      if(CloudSync.status==='connected') await CloudSync.replaceAll(rows);
      else { AppStore.replaceEntries(rows); renderLedger(); renderTopPubs(); }
    }catch(err){ toast('Import failed: '+err.message,true); }
  }
  function downloadTemplate(){
    const header = ['publisher','pid','app','appName','vertical','clicks','installs','events','finstalls','fevents','revenue','cost'];
    const escv = v => { if(v==null) return ''; const s=String(v); return /[",\n\r]/.test(s)? '"'+s.replace(/"/g,'""')+'"' : s; };
    const example = ['Acme Media','partner_int','com.brand.app','Brand App','Gaming','1000','50','25','2','1','120.50','80.00'];
    // Stub one row per app × pid combination not yet filled
    const filled = new Set(AppStore.state.entries.map(e=> (e.app||'')+'|'+(e.pid||'')));
    const stubs = [];
    AppStore.state.apps.forEach(a=> AppStore.state.pids.forEach(p=>{
      if(!filled.has(a.name+'|'+p.name)){
        stubs.push(['', p.name, a.name, a.appName||'', a.vertical||'', '', '', '', '', '', '', '']);
      }
    }));
    const all = [header, example, ...stubs].map(r=> r.map(escv).join(',')).join('\n');
    const blob = new Blob([all], {type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='opscore_pubscore_template.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }

  /* ====== Link Genie ====== */
  const MAND_PARAMS = [
    'pid','clickid','af_sub3','c','af_c_id','af_siteid','af_sub_site','af_adset_id','af_adset',
    'af_ad_id','af_ad','af_channel','deep_link_value','af_sub1','af_click_lookback',
    'af_viewthrough_lookback','advertising_id','idfa','af_prt'
  ];
  const LinkGenie = (() => {
    const state = { mounted:false, linkType:'CTA', appId:'', subdomain:'', templateId:'',
      params: [], linkName:'', editingId:null, suppress:false };

    function genId(){ return Math.random().toString(36).slice(2,11); }
    function defaultParams(){ return MAND_PARAMS.map(k=>({ id:genId(), key:k, value:'' })); }

    function ensureMount(){
      if(state.mounted) return; state.mounted = true;
      bindLG();
      state.params = defaultParams();
      renderParams();
      mountCombobox($('#appTrackerId'), 'app', { onSelect:(rec)=>{ state.appId = rec.name; updateUI(); } });
      renderHistory();
      updateUI();
    }

    function bindLG(){
      $$('#lg-tabs, .lg-tabs').forEach(()=>{});
      $$('.lg-tabs .tab').forEach(t=> t.addEventListener('click',()=>{
        $$('.lg-tabs .tab').forEach(x=>x.classList.remove('active'));
        t.classList.add('active');
        const which = t.dataset.lgtab;
        $('#lg-builder').classList.toggle('hidden', which!=='builder');
        $('#lg-history').classList.toggle('hidden', which!=='history');
      }));

      $$('#linkTypeToggle .seg-btn').forEach(b=> b.addEventListener('click',()=>{
        $$('#linkTypeToggle .seg-btn').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        state.linkType = b.dataset.type;
        updateUI();
      }));
      $('#appTrackerId').addEventListener('input', e=>{ state.appId = e.target.value; updateUI(); });
      $('#subdomain').addEventListener('input', e=>{ state.subdomain = e.target.value; updateUI(); });
      $('#templateId').addEventListener('input', e=>{ state.templateId = e.target.value; updateUI(); });
      $('#linkName').addEventListener('input', e=>{ state.linkName = e.target.value; });
      $('#addParamBtn').addEventListener('click',()=>{ state.params.push({id:genId(),key:'',value:''}); renderParams(); updateUI(); });

      $('#saveBtn').addEventListener('click', save);
      $('#resetBtn').addEventListener('click', resetSample);
      $('#copyLinkBtn').addEventListener('click', async ()=>{
        const txt = $('#linkPreview').textContent.trim();
        if(!txt) return;
        try{ await navigator.clipboard.writeText(txt); toast('Link copied.'); }catch{ toast('Copy failed.', true); }
      });
      $('#linkPreview').addEventListener('paste', e=>{
        e.preventDefault();
        const text = (e.clipboardData||window.clipboardData).getData('text');
        if(text && /^https?:/i.test(text.trim())){ parseLink(text.trim()); }
        else { document.execCommand('insertText', false, text); }
      });
      $('#searchLinks').addEventListener('input', renderHistory);
      $('#clearHistoryBtn').addEventListener('click', async ()=>{
        if(!AppStore.state.links.length) return;
        if(!confirm('Clear ALL saved links?')) return;
        try{ await CloudSync.purgeLinksCloud(); }catch(err){ toast('Clear failed: '+err.message,true); }
        renderHistory();
      });

      Bus.on(evt=>{ if(evt.type==='links' && state.mounted) renderHistory(); });
    }

    function updateUI(){
      $('#oneLinkFields').style.display = state.linkType==='OneLink' ? 'flex' : 'none';
      let base = '';
      if(state.linkType==='CTA') base = `https://app.appsflyer.com/${state.appId||'{app_id}'}`;
      else if(state.linkType==='VTA') base = `https://impression.appsflyer.com/${state.appId||'{app_id}'}`;
      else if(state.linkType==='OneLink') base = `https://${state.subdomain||'{subdomain}'}.onelink.me/${state.templateId||'{template_id}'}`;
      const sp = new URLSearchParams();
      state.params.forEach(p=>{ if(p.key && p.value) sp.append(p.key, p.value); });
      const qs = sp.toString();
      const final = qs ? `${base}?${decodeURIComponent(qs)}` : base;
      if(!state.suppress) $('#linkPreview').textContent = final;
      $('#appTrackerId').value = state.appId;
      $('#subdomain').value = state.subdomain;
      $('#templateId').value = state.templateId;
      $$('#linkTypeToggle .seg-btn').forEach(b=> b.classList.toggle('active', b.dataset.type===state.linkType));
    }

    function renderParams(){
      const list = $('#parametersList'); list.innerHTML='';
      state.params.forEach((p,idx)=>{
        const row = document.createElement('div'); row.className='param-row'; row.dataset.id = p.id;
        const isMand = MAND_PARAMS.includes(p.key);
        const isPid = p.key === 'pid';
        row.innerHTML = `
          <div class="reorder">
            <button title="Up" data-act="up">▲</button>
            <button title="Down" data-act="down">▼</button>
          </div>
          <input class="pi key" type="text" value="${escapeHtml(p.key)}" placeholder="key" ${isMand?'readonly':''}/>
          <input class="pi val" type="text" value="${escapeHtml(p.value)}" placeholder="value" ${isPid?'data-pid-combo="1"':''}/>
          <button class="rm" title="Remove">×</button>`;
        row.querySelector('.key').addEventListener('input', e=>{ p.key = e.target.value; updateUI(); });
        row.querySelector('.val').addEventListener('input', e=>{ p.value = e.target.value; updateUI(); });
        row.querySelector('.rm').addEventListener('click',()=>{
          if(!confirm('Remove parameter "'+(p.key||'?')+'"?')) return;
          state.params = state.params.filter(x=>x.id!==p.id); renderParams(); updateUI();
        });
        row.querySelector('[data-act="up"]').addEventListener('click',()=>{
          if(idx===0) return;
          [state.params[idx-1], state.params[idx]] = [state.params[idx], state.params[idx-1]];
          renderParams(); updateUI();
        });
        row.querySelector('[data-act="down"]').addEventListener('click',()=>{
          if(idx===state.params.length-1) return;
          [state.params[idx+1], state.params[idx]] = [state.params[idx], state.params[idx+1]];
          renderParams(); updateUI();
        });
        list.appendChild(row);
        if(isPid){
          mountCombobox(row.querySelector('.val'), 'pid', { allowCreate:false, onSelect:(rec,val)=>{ p.value = val; updateUI(); } });
        }
      });
    }

    function parseLink(url){
      try{
        const u = new URL(url);
        if(u.hostname.includes('onelink.me')){
          state.linkType = 'OneLink';
          state.subdomain = u.hostname.split('.')[0];
          const seg = u.pathname.split('/').filter(Boolean);
          state.templateId = seg[0] || '';
        } else if(u.hostname.includes('impression.appsflyer.com')){
          state.linkType = 'VTA';
          state.appId = u.pathname.split('/').filter(Boolean)[0] || '';
        } else {
          state.linkType = 'CTA';
          state.appId = u.pathname.split('/').filter(Boolean)[0] || '';
        }
        const np = []; u.searchParams.forEach((v,k)=> np.push({id:genId(), key:k, value:v}));
        if(np.length) state.params = np;
        renderParams(); updateUI();
        toast('Link parsed.');
      }catch(err){ toast('Could not parse URL.', true); }
    }

    function resetSample(){
      state.linkType='CTA'; state.appId=''; state.subdomain=''; state.templateId='';
      state.params = defaultParams(); state.linkName=''; state.editingId=null;
      $('#linkName').value='';
      renderParams(); updateUI();
    }

    async function save(){
      if(!state.appId){ toast('App ID is required.', true); return; }
      if(!state.linkName){
        // auto-name
        const ms = (state.params.find(p=>p.key==='pid')||{}).value || '';
        state.linkName = `${state.appId} · ${ms||state.linkType}`;
        $('#linkName').value = state.linkName;
      }
      const finalUrl = $('#linkPreview').textContent.trim();
      const rec = {
        name: state.linkName, platform:'Appsflyer', type: state.linkType,
        appId: state.appId, subdomain: state.subdomain, templateId: state.templateId,
        params: state.params.map(p=>({key:p.key, value:p.value})),
        url: finalUrl
      };
      try{
        if(state.editingId){ await CloudSync.updateLink(state.editingId, rec); toast('Link updated.'); }
        else { await CloudSync.addLink(rec); toast('Link saved.'); }
      }catch(err){ toast('Save failed: '+err.message,true); return; }
      state.editingId = null;
      // Switch to history tab
      $$('.lg-tabs .tab').forEach(x=>x.classList.toggle('active', x.dataset.lgtab==='history'));
      $('#lg-builder').classList.add('hidden'); $('#lg-history').classList.remove('hidden');
    }

    function renderHistory(){
      const list = $('#linksHistory'); if(!list) return;
      const q = ($('#searchLinks').value||'').toLowerCase().trim();
      const all = AppStore.state.links.slice().sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
      const filtered = q ? all.filter(l=> (l.name||'').toLowerCase().includes(q) || (l.url||'').toLowerCase().includes(q)) : all;
      $('#lgCount').textContent = all.length + ' saved';
      if(!filtered.length){
        list.innerHTML = `<div class="muted" style="padding:16px;text-align:center">${all.length?'No matches.':'No links saved yet. Build one in the Builder tab.'}</div>`;
        return;
      }
      list.innerHTML = filtered.map(l=>`
        <div class="history-item" data-id="${l.id}">
          <h4>${escapeHtml(l.name||'(unnamed)')}</h4>
          <div class="meta">${escapeHtml(l.platform||'Appsflyer')} · ${escapeHtml(l.type||'CTA')} · ${new Date(l.createdAt||0).toLocaleString()}</div>
          <div class="url">${escapeHtml(l.url||'')}</div>
          <div class="actions">
            <button class="btn sm primary" data-act="copy">Copy</button>
            <button class="btn sm" data-act="edit">Edit</button>
            <button class="btn sm danger" data-act="del">Delete</button>
          </div>
        </div>`).join('');
      list.querySelectorAll('.history-item').forEach(card=>{
        const id = card.dataset.id; const link = AppStore.state.links.find(x=>x.id===id);
        card.querySelector('[data-act="copy"]').addEventListener('click', async ()=>{
          try{ await navigator.clipboard.writeText(link.url||''); toast('Copied.'); }catch{ toast('Copy failed.', true); }
        });
        card.querySelector('[data-act="del"]').addEventListener('click', async ()=>{
          if(!confirm('Delete this link?')) return;
          try{ await CloudSync.removeLink(id); }catch(err){ toast('Delete failed: '+err.message,true); }
        });
        card.querySelector('[data-act="edit"]').addEventListener('click',()=>{
          state.linkType = link.type||'CTA'; state.appId = link.appId||'';
          state.subdomain = link.subdomain||''; state.templateId = link.templateId||'';
          state.params = (link.params||[]).map(p=>({id:genId(),key:p.key,value:p.value}));
          if(!state.params.length) state.params = defaultParams();
          state.linkName = link.name||''; state.editingId = link.id;
          $('#linkName').value = state.linkName;
          renderParams(); updateUI();
          $$('.lg-tabs .tab').forEach(x=>x.classList.toggle('active', x.dataset.lgtab==='builder'));
          $('#lg-builder').classList.remove('hidden'); $('#lg-history').classList.add('hidden');
        });
      });
    }

    return { ensureMount, renderHistory };
  })();

  function bindLinkGenie(){ /* binding happens on first tab activation via LinkGenie.ensureMount() */ }

  /* ====== Hooks called by CloudSync ====== */
  function afterEntries(){ renderLedger(); renderTopPubs(); }
  function afterApps(){ renderAssets(); renderTopOptions(); }
  function afterPids(){ renderAssets(); }
  function afterLinks(){ if(LinkGenie) LinkGenie.renderHistory && LinkGenie.renderHistory(); }

  function initAppSystems(){
    renderAssets(); renderTopOptions(); renderLedger(); renderTopPubs();
    CloudSync.connect(FIREBASE_CONFIG);
  }

  function checkSession(){
    let raw=null; try{ raw=localStorage.getItem(SESSION_KEY); }catch{ raw=null; }
    if(!raw) return;
    let session=null; try{ session=JSON.parse(raw); }catch{ session=null; }
    const apiKey = session && session.apiKey, teamToken = session && session.teamToken, ts = session && session.timestamp;
    const expired = !ts || (Date.now()-ts > SESSION_TTL_MS);
    if(!apiKey || !teamToken || expired){ localStorage.removeItem(SESSION_KEY); return; }
    FIREBASE_CONFIG.apiKey = apiKey; ACTIVE_TEAM_TOKEN = teamToken;
    $('#loginOverlay').style.display='none';
    initAppSystems();
  }

  return {
    bind, checkSession,
    renderAssets, renderLedger, renderTopPubs, renderTopOptions,
    afterEntries, afterApps, afterPids, afterLinks
  };
})();

/* ---------- boot ---------- */
DOMManager.bind();
DOMManager.checkSession();
