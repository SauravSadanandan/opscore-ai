/* ============================================================
   OpsCore — PubScore BI Console (app.js)
   Decoupled ES6 module: State, CloudSync, MetricsEngine, DOM.
   ============================================================ */

const FIREBASE_CONFIG = {
  apiKey: null,
  authDomain: "opscore-database.firebaseapp.com",
  projectId: "opscore-database",
  storageBucket: "opscore-database.appspot.com",
  appId: "1:738267102673:web:18e776322ca775a75474f0"
};

// The token is now fully dynamic and never hardcoded in GitHub.
let ACTIVE_TEAM_TOKEN = null; 
const SESSION_KEY = "oc_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/* ---------- AppStore ---------- */
const AppStore = (() => {
  const K = {
    apps:'oc.apps', pids:'oc.pids', entries:'oc.entries',
    sel_apps:'oc.sel.apps', sel_pids:'oc.sel.pids',
    weights:'oc.weights'
  };
  const read = (k,fb)=>{ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):fb; }catch{ return fb; } };
  const write = (k,v)=> localStorage.setItem(k,JSON.stringify(v));

  const DEFAULT_WEIGHTS = {
    base:50, roas_hi:30, roas_md:15, rev_hi:20, rev_md:10,
    c2i_hi:20, c2i_md:10, fraud_hi:40, fraud_md:15
  };

  const state = {
    apps: read(K.apps,[]),
    pids: read(K.pids,[]),
    entries: read(K.entries,[]),
    sel:{ apps:new Set(read(K.sel_apps,[])), pids:new Set(read(K.sel_pids,[])) },
    weights: { ...DEFAULT_WEIGHTS, ...read(K.weights,{}) },
    filters: { q:'', minC2I:null, maxFraud:null, minRev:null, minRoas:null }
  };

  function persist(slice){
    if(slice==='apps') write(K.apps,state.apps);
    if(slice==='pids') write(K.pids,state.pids);
    if(slice==='entries') write(K.entries,state.entries);
    if(slice==='sel'){ write(K.sel_apps,[...state.sel.apps]); write(K.sel_pids,[...state.sel.pids]); }
    if(slice==='weights') write(K.weights,state.weights);
  }
  return {
    state, persist, DEFAULT_WEIGHTS,
    addApp(name){ name=name.trim(); if(!name||state.apps.some(a=>a.name===name)) return;
      state.apps.push({id:crypto.randomUUID(), name}); persist('apps'); },
    addPid(name){ name=name.trim(); if(!name||state.pids.some(p=>p.name===name)) return;
      state.pids.push({id:crypto.randomUUID(), name}); persist('pids'); },
    removeApp(id){ state.apps=state.apps.filter(a=>a.id!==id); state.sel.apps.delete(id); persist('apps'); persist('sel'); },
    removePid(id){ state.pids=state.pids.filter(p=>p.id!==id); state.sel.pids.delete(id); persist('pids'); persist('sel'); },
    toggleApp(id,on){ on? state.sel.apps.add(id) : state.sel.apps.delete(id); persist('sel'); },
    togglePid(id,on){ on? state.sel.pids.add(id) : state.sel.pids.delete(id); persist('sel'); },
    clearSel(){ state.sel.apps.clear(); state.sel.pids.clear(); persist('sel'); },
    addEntry(e){ const rec={id:crypto.randomUUID(), ts:Date.now(), ...e}; state.entries.unshift(rec); persist('entries'); return rec; },
    removeEntry(id){ state.entries=state.entries.filter(x=>x.id!==id); persist('entries'); },
    replaceEntries(arr){ state.entries=arr; persist('entries'); },
    setWeights(w){ state.weights={...state.weights,...w}; persist('weights'); },
    resetWeights(){ state.weights={...DEFAULT_WEIGHTS}; persist('weights'); },
    setFilter(patch){ state.filters={...state.filters,...patch}; },
    purge(){
      state.apps=[]; state.pids=[]; state.entries=[]; state.sel.apps.clear(); state.sel.pids.clear();
      persist('apps');persist('pids');persist('entries');persist('sel');
    }
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
    // group by publisher (case-insensitive trim)
    const groups = new Map();
    for(const e of entries){
      const key = (e.publisher||'').trim() || '(Unspecified)';
      if(!groups.has(key)) groups.set(key,{ publisher:key, entries:[], sums:{
        clicks:0, installs:0, events:0, finstalls:0, fevents:0, revenue:0, cost:0, hasCost:false
      }});
      const g = groups.get(key);
      g.entries.push(e);
      g.sums.clicks += +e.clicks||0;
      g.sums.installs += +e.installs||0;
      g.sums.events += +e.events||0;
      g.sums.finstalls += +e.finstalls||0;
      g.sums.fevents += +e.fevents||0;
      g.sums.revenue += +e.revenue||0;
      if(e.cost!=null && e.cost!==''){ g.sums.cost += +e.cost||0; g.sums.hasCost=true; }
    }
    return [...groups.values()].map(g=>{
      const s=g.sums;
      const m = computeEntry({
        clicks:s.clicks, installs:s.installs, events:s.events,
        finstalls:s.finstalls, fevents:s.fevents,
        revenue:s.revenue, cost: s.hasCost? s.cost : null
      });
      return { ...g, metrics:m };
    });
  }

  function pubScore(m, w){
    let score = w.base;
    // Revenue bonuses
    if(m.revenue > 5000) score += w.rev_hi;
    else if(m.revenue > 1000) score += w.rev_md;
    // ROAS bonuses (if cost provided)
    if(m.roas != null){
      if(m.roas > 150) score += w.roas_hi;
      else if(m.roas > 100) score += w.roas_md;
    }
    // C2I bonuses
    if(m.c2i > 2) score += w.c2i_hi;
    else if(m.c2i > 1) score += w.c2i_md;
    // Fraud penalties (combined install+event fraud)
    if(m.fraud > 20) score -= w.fraud_hi;
    else if(m.fraud > 10) score -= w.fraud_md;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function tier(score){
    if(score >= 80) return 1;
    if(score >= 60) return 2;
    if(score >= 40) return 3;
    return 4;
  }

  return { rate, computeEntry, aggregate, pubScore, tier };
})();

/* ---------- CloudSync (unchanged behavior) ---------- */
const CloudSync = (() => {
  let app=null, db=null, unsub=null, fns=null;
  let status='disconnected';
  const listeners=new Set();
  const emit=()=> listeners.forEach(fn=>fn(status));

  let lastError = null;
  async function connect(cfg){
    if(location.protocol === 'file:'){
      lastError = 'Page is opened via file:// — Firebase requires http(s). Serve the folder (e.g. `npx serve .` or `python3 -m http.server`).';
      console.error('[CloudSync] '+lastError);
      status='error'; emit(); return;
    }
    if(!cfg.apiKey||!cfg.appId||!cfg.projectId){
      lastError = 'Firebase config incomplete (need apiKey, appId, projectId).';
      console.warn('[CloudSync] '+lastError);
      status='error'; emit(); return;
    }
    status='connecting'; emit();
    try{
      const [{initializeApp}, firestore] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
      ]);
      app = initializeApp(cfg, 'opscore-'+Date.now());
      db = firestore.getFirestore(app);
      fns = firestore;

      const colRef = firestore.collection(db,'publisher_matrix');
      const q = firestore.query(colRef, firestore.where('teamToken','==',ACTIVE_TEAM_TOKEN));
      unsub = firestore.onSnapshot(q, snap=>{
        const rows=[];
        snap.forEach(d=> rows.push({ id:d.id, ...d.data() }));
        rows.sort((a,b)=>(b.ts||0)-(a.ts||0));
        AppStore.replaceEntries(rows);
        DOMManager.renderLedger();
        DOMManager.renderLeaderboard();
      }, err=>{
        lastError = err && err.message || String(err);
        console.error('[CloudSync] onSnapshot error:', err);
        status='error'; emit();
      });

      status='connected'; lastError=null; emit();
    }catch(err){
      lastError = err && err.message || String(err);
      console.error('[CloudSync] connect failed:', err);
      status='error'; emit();
    }
  }

  async function addEntry(rec){
    if(status!=='connected') return AppStore.addEntry(rec);
    const ref = fns.doc(fns.collection(db,'publisher_matrix'));
    const payload = { ...rec, ts: rec.ts||Date.now(), teamToken: ACTIVE_TEAM_TOKEN };
    delete payload.id;
    await fns.setDoc(ref, payload);
  }
  async function removeEntry(id){
    if(status!=='connected') return AppStore.removeEntry(id);
    await fns.deleteDoc(fns.doc(db,'publisher_matrix',id));
  }
  async function replaceAll(rows){
    if(status!=='connected'){ AppStore.replaceEntries(rows); return; }
    const colRef = fns.collection(db,'publisher_matrix');
    const q = fns.query(colRef, fns.where('teamToken','==',ACTIVE_TEAM_TOKEN));
    const snap = await fns.getDocs(q);
    const batch = fns.writeBatch ? fns.writeBatch(db) : null;
    if(batch){
      snap.forEach(d=> batch.delete(d.ref));
      rows.forEach(r=>{
        const ref = fns.doc(colRef);
        const {id, ...rest} = r;
        batch.set(ref, { ...rest, ts: rest.ts||Date.now(), teamToken: ACTIVE_TEAM_TOKEN });
      });
      await batch.commit();
    } else {
      for(const d of snap.docs){ await fns.deleteDoc(d.ref); }
      for(const r of rows){
        const {id, ...rest} = r;
        await fns.addDoc(colRef, { ...rest, ts: rest.ts||Date.now(), teamToken: ACTIVE_TEAM_TOKEN });
      }
    }
  }
  return {
    connect, addEntry, removeEntry, replaceAll,
    onStatus(fn){ listeners.add(fn); fn(status); return ()=>listeners.delete(fn); },
    get status(){ return status; },
    get lastError(){ return lastError; }
  };
})();

/* ---------- CSV helpers ---------- */
const CSV = (() => {
  const cols = ['id','publisher','pid','app','clicks','installs','events','finstalls','fevents','revenue','cost','ts'];
  const esc = v => {
    if(v==null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  };
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

  function bind(){
   // Login
    $('#loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const apiKey = $('#loginUser').value.trim();
      const teamToken = $('#loginPass').value.trim(); // Capture token dynamically
      const err = $('#loginErr');
      
      if (!apiKey || !teamToken) { 
        err.textContent='Both API Key and Team Token are required.'; 
        err.style.display='block'; 
        return; 
      }
      
      // Save both to local storage for the 24-hour session
      const session = { apiKey, teamToken, timestamp: Date.now() };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      
      // Load into memory
      FIREBASE_CONFIG.apiKey = apiKey;
      ACTIVE_TEAM_TOKEN = teamToken;
      
      $('#loginOverlay').style.display = 'none';
      err.style.display = 'none';
      initAppSystems();
    });

    $('#logoutBtn').addEventListener('click', () => {
      localStorage.removeItem(SESSION_KEY);
      window.location.reload();
    });

    // Tabs
    $$('.tab').forEach(t=> t.addEventListener('click',()=>{
      $$('.tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      const id=t.dataset.tab;
      $('#tab-matrix').classList.toggle('hidden', id!=='matrix');
      $('#tab-analyzer').classList.toggle('hidden', id!=='analyzer');
    }));

    // Asset forms
    $('#addAppForm').addEventListener('submit',e=>{
      e.preventDefault(); AppStore.addApp($('#appInput').value); $('#appInput').value=''; renderAssets();
    });
    $('#addPidForm').addEventListener('submit',e=>{
      e.preventDefault(); AppStore.addPid($('#pidInput').value); $('#pidInput').value=''; renderAssets();
    });
    $('#launchBtn').addEventListener('click',launchMatrix);
    $('#clearSelBtn').addEventListener('click',()=>{ AppStore.clearSel(); renderAssets(); });

    // Entry form
    $('#entryForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const costVal = $('#f_cost').value;
      const rec = {
        publisher: $('#f_pub').value.trim(),
        pid: $('#f_pid').value.trim(),
        app: $('#f_app').value.trim(),
        clicks:+$('#f_clicks').value||0,
        installs:+$('#f_installs').value||0,
        events:+$('#f_events').value||0,
        finstalls:+$('#f_finstalls').value||0,
        fevents:+$('#f_fevents').value||0,
        revenue:+$('#f_revenue').value||0,
        cost: costVal===''? null : Number(costVal),
      };
      try{ await CloudSync.addEntry(rec); }catch(err){ alert('Add failed: '+err.message); }
      e.target.reset();
      ['f_clicks','f_installs','f_events','f_finstalls','f_fevents','f_revenue'].forEach(id=>$('#'+id).value=0);
      renderLedger(); renderLeaderboard();
    });

    // Filters
    const filterIds = [
      ['#flt_q','q','string'],
      ['#flt_c2i','minC2I','num'],
      ['#flt_fraud','maxFraud','num'],
      ['#flt_rev','minRev','num'],
      ['#flt_roas','minRoas','num'],
    ];
    filterIds.forEach(([sel,key,kind])=>{
      $(sel).addEventListener('input', e=>{
        const v = e.target.value;
        AppStore.setFilter({ [key]: kind==='num' ? (v===''? null : Number(v)) : v });
        renderLedger();
      });
    });
    $('#flt_clear').addEventListener('click',()=>{
      ['#flt_q','#flt_c2i','#flt_fraud','#flt_rev','#flt_roas'].forEach(s=> $(s).value='');
      AppStore.setFilter({ q:'', minC2I:null, maxFraud:null, minRev:null, minRoas:null });
      renderLedger();
    });

    // Weights
    bindWeights();
    $('#weightsToggle').addEventListener('click',()=> $('#weightsBody').classList.toggle('hidden'));
    $('#weightsReset').addEventListener('click',()=>{
      AppStore.resetWeights();
      hydrateWeightInputs();
      renderLedger();
    });

    // CSV
    $('#exportCsv').addEventListener('click',exportCsv);
    $('#importBtn').addEventListener('click',()=>$('#importFile').click());
    $('#importFile').addEventListener('change',e=>{ const f=e.target.files[0]; if(f) importCsvFile(f); e.target.value=''; });
    const dz=$('#drop');
    ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag');}));
    ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag');}));
    dz.addEventListener('drop',e=>{ const f=e.dataTransfer.files[0]; if(f) importCsvFile(f); });

    $('#purgeBtn').addEventListener('click',async ()=>{
      if(!confirm('Purge ALL local data (apps, PIDs, ledger)? This cannot be undone.')) return;
      AppStore.purge();
      if(CloudSync.status==='connected' && confirm('Also wipe the connected Firestore collection "publisher_matrix"?')){
        try{ await CloudSync.replaceAll([]); }catch(err){ alert('Cloud wipe failed: '+err.message); }
      }
      renderAssets();      // ✅ Add this
      renderLedger();      // ✅ Add this
      renderLeaderboard(); // ✅ Add this
    });

    CloudSync.onStatus(s=>{
      const pill=$('#syncPill'), txt=$('#syncPillText');
      pill.classList.toggle('on', s==='connected');
      pill.classList.toggle('off', s!=='connected');
      txt.textContent = s==='connected'?'Live Sync Active' : s==='connecting'?'Connecting…' : s==='error'?'Sync Error':'Local mode';
      pill.title = s==='error' && CloudSync.lastError ? CloudSync.lastError : (s==='connected'?'Connected to Firestore':'Not connected');
    });
  }

  function bindWeights(){
    hydrateWeightInputs();
    $$('.wt').forEach(inp=>{
      inp.addEventListener('input',()=>{
        const key = inp.id.replace(/^w_/,'');
        const v = Number(inp.value)||0;
        AppStore.setWeights({ [key]: v });
        if(key==='base') $('#w_base_display').textContent = v;
        renderLedger();
      });
    });
  }
  function hydrateWeightInputs(){
    const w = AppStore.state.weights;
    Object.keys(w).forEach(k=>{
      const el = document.getElementById('w_'+k);
      if(el) el.value = w[k];
    });
    const bd = document.getElementById('w_base_display');
    if(bd) bd.textContent = w.base;
  }

 function initAppSystems(){
    renderAssets();
    renderLedger();
    renderLeaderboard();
    CloudSync.connect(FIREBASE_CONFIG);
  }

  function checkSession(){
    let raw=null; try{ raw=localStorage.getItem(SESSION_KEY); }catch{ raw=null; }
    if(!raw) return;
    let session=null; try{ session=JSON.parse(raw); }catch{ session=null; }
    const apiKey = session && session.apiKey;
    const ts = session && session.timestamp;
    const expired = !ts || (Date.now()-ts > SESSION_TTL_MS);
    if(!apiKey || expired){ localStorage.removeItem(SESSION_KEY); return; }
    FIREBASE_CONFIG.apiKey = apiKey;
    $('#loginOverlay').style.display='none';
    initAppSystems();
  }

  function renderAssets(){
    const {apps,pids,sel}=AppStore.state;
    const appUL=$('#appList'), pidUL=$('#pidList');
    appUL.innerHTML=''; pidUL.innerHTML='';
    apps.forEach(a=>{
      const li=document.createElement('li'); li.className='fade-in';
      li.innerHTML=`<input class="chk" type="checkbox" ${sel.apps.has(a.id)?'checked':''}/><span class="name">${escapeHtml(a.name)}</span><button class="iconbtn" title="Remove">✕</button>`;
      li.querySelector('.chk').addEventListener('change',e=>{ AppStore.toggleApp(a.id,e.target.checked); renderMatrix(); });
      li.querySelector('.iconbtn').addEventListener('click',()=>{ if(confirm('Remove App ID "'+a.name+'"?')){ AppStore.removeApp(a.id); renderAssets(); } });
      appUL.appendChild(li);
    });
    pids.forEach(p=>{
      const li=document.createElement('li'); li.className='fade-in';
      li.innerHTML=`<input class="chk" type="checkbox" ${sel.pids.has(p.id)?'checked':''}/><span class="name">${escapeHtml(p.name)}</span><button class="iconbtn" title="Remove">✕</button>`;
      li.querySelector('.chk').addEventListener('change',e=>{ AppStore.togglePid(p.id,e.target.checked); renderMatrix(); });
      li.querySelector('.iconbtn').addEventListener('click',()=>{ if(confirm('Remove PID "'+p.name+'"?')){ AppStore.removePid(p.id); renderAssets(); } });
      pidUL.appendChild(li);
    });
    $('#appsCount').textContent=apps.length+' total';
    $('#pidsCount').textContent=pids.length+' total';
    renderMatrix();
  }

  function renderMatrix(){
    const {apps,pids,sel}=AppStore.state;
    const sa=apps.filter(a=>sel.apps.has(a.id));
    const sp=pids.filter(p=>sel.pids.has(p.id));
    const grid=$('#matrixGrid');
    if(!sa.length || !sp.length){
      grid.innerHTML='<span class="muted">Add and select at least one App ID and one PID to build a launch matrix.</span>';
      $('#matrixCount').textContent='0 pairs selected';
      return;
    }
    const rows = sa.map(a=>`<tr><td class="mono" style="font-size:12px">${escapeHtml(a.name)}</td>${sp.map(p=>`<td class="mono muted" style="font-size:11.5px">→ ${escapeHtml(p.name)}</td>`).join('')}</tr>`).join('');
    grid.innerHTML = `<div class="table-wrap"><table><thead><tr><th>App ID</th>${sp.map(p=>`<th>${escapeHtml(p.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    const n = sa.length*sp.length;
    $('#matrixCount').textContent = n+' pair'+(n===1?'':'s')+' selected';
  }

  function launchMatrix(){
    const {apps,pids,sel}=AppStore.state;
    const sa=apps.filter(a=>sel.apps.has(a.id));
    const sp=pids.filter(p=>sel.pids.has(p.id));
    const pairs=[];
    sa.forEach(a=> sp.forEach(p=> pairs.push([a.name,p.name])));
    if(!pairs.length){ alert('Select at least one App ID and one PID.'); return; }
    if(pairs.length>12 && !confirm('Open '+pairs.length+' tabs?')) return;
    let blocked=0;
    pairs.forEach(([app,pid])=>{
      const u=`https://hq1.appsflyer.com/marketplace/integrated-partners/${encodeURIComponent(app)}/${encodeURIComponent(pid)}`;
      const w=window.open(u,'_blank','noopener'); if(!w) blocked++;
    });
    if(blocked) alert(blocked+' tab(s) were blocked. Allow pop-ups for this site.');
  }

  function applyFilters(groups){
    const f = AppStore.state.filters;
    const q = (f.q||'').trim().toLowerCase();
    return groups.filter(g=>{
      if(q){
        const inPub = g.publisher.toLowerCase().includes(q);
        const inPid = g.entries.some(e=> String(e.pid||'').toLowerCase().includes(q));
        if(!inPub && !inPid) return false;
      }
      const m = g.metrics;
      if(f.minC2I!=null && m.c2i < f.minC2I) return false;
      if(f.maxFraud!=null && m.fraud > f.maxFraud) return false;
      if(f.minRev!=null && m.revenue < f.minRev) return false;
      if(f.minRoas!=null){
        if(m.roas==null || m.roas < f.minRoas) return false;
      }
      return true;
    });
  }

  function tierBadge(t){
    const map={1:['t1','Tier 1 · Premium'],2:['t2','Tier 2 · Baseline'],3:['t3','Tier 3 · Monitor'],4:['t4','Tier 4 · Flagged']};
    const [cls,label]=map[t];
    return `<span class="tier ${cls}"><span class="led"></span>${label}</span>`;
  }

  function renderLedger(){
    const tbody=$('#ledgerBody');
    const groups = MetricsEngine.aggregate(AppStore.state.entries);
    const filtered = applyFilters(groups).sort((a,b)=> b.metrics.revenue - a.metrics.revenue);
    $('#ledgerCount').textContent = filtered.length;
    if(!filtered.length){
      tbody.innerHTML='<tr><td colspan="9" class="muted" style="padding:20px;text-align:center">No publishers match the current filters.</td></tr>';
      return;
    }
    const w = AppStore.state.weights;
    tbody.innerHTML = filtered.map(g=>{
      const m=g.metrics;
      const score = MetricsEngine.pubScore(m,w);
      const t = MetricsEngine.tier(score);
      const roasCell = m.roas==null ? '<span class="big muted">—</span><span class="sub">no cost data</span>' : `<span class="big">${pct(m.roas)}</span>`;
      const drill = renderDrill(g.entries);
      return `<tr class="fade-in">
        <td>
          <span class="big">${escapeHtml(g.publisher)}</span>
          <span class="sub">${g.entries.length} PID${g.entries.length===1?'':'s'}</span>
          ${drill}
        </td>
        <td>
          <span class="big">${score}</span>
          <span class="sub">of 100</span>
          <div class="score-bar"><span style="width:${score}%"></span></div>
        </td>
        <td><span class="big">${pct(m.c2i)}</span><span class="sub">(${fmt(g.sums.installs)} / ${fmt(g.sums.clicks)} clicks)</span></td>
        <td><span class="big">${pct(m.i2e)}</span><span class="sub">context only</span></td>
        <td><span class="big">${pct(m.fraud)}</span><span class="sub">I:${pct(m.ifr)} · E:${pct(m.efr)}</span></td>
        <td><span class="big">${usd(m.revenue)}</span><span class="sub">cost ${usd(g.sums.hasCost? g.sums.cost : null)}</span></td>
        <td>${roasCell}</td>
        <td>${tierBadge(t)}</td>
        <td><button class="iconbtn" data-pub="${escapeHtml(g.publisher)}" title="Delete all PIDs for this publisher">✕</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.iconbtn').forEach(b=> b.addEventListener('click', async ()=>{
      const pub = b.dataset.pub;
      if(!confirm('Delete ALL entries for publisher "'+pub+'"?')) return;
      const targets = AppStore.state.entries.filter(e=> (e.publisher||'(Unspecified)').trim()===pub);
      for(const e of targets){
        try{ await CloudSync.removeEntry(e.id); }catch(err){ alert('Delete failed: '+err.message); }
      }
      renderLedger(); renderLeaderboard();
    }));
  }

  function renderDrill(entries){
    if(!entries.length) return '';
    const rows = entries.map(e=>{
      const m = MetricsEngine.computeEntry(e);
      const roas = m.roas==null? '—' : pct(m.roas);
      return `<tr>
        <td class="mono">${escapeHtml(e.pid||'—')}</td>
        <td>${pct(m.c2i)}</td>
        <td>${pct(m.i2e)}</td>
        <td>${pct(m.fraud)}</td>
        <td>${usd(m.revenue)}</td>
        <td>${roas}</td>
      </tr>`;
    }).join('');
    return `<details class="pid-drill"><summary>View ${entries.length} PID${entries.length===1?'':'s'}</summary>
      <table class="drill-table">
        <thead><tr><th>PID</th><th>C2I</th><th>I2E</th><th>Fraud</th><th>Revenue</th><th>ROAS</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
  }

  function renderLeaderboard(){
    const tbody=$('#leaderBody');
    const top = [...AppStore.state.entries]
      .map(e=>({ e, m:MetricsEngine.computeEntry(e) }))
      .sort((a,b)=> b.m.revenue - a.m.revenue)
      .slice(0,5);
    if(!top.length){
      tbody.innerHTML='<tr><td colspan="4" class="muted" style="padding:14px;text-align:center">No entries yet.</td></tr>';
      return;
    }
    tbody.innerHTML = top.map((r,i)=>`
      <tr>
        <td><span class="big">${i+1}</span></td>
        <td><span class="big">${escapeHtml(r.e.publisher||'(Unspecified)')}</span><span class="sub mono">${escapeHtml(r.e.pid||'—')}</span></td>
        <td><span class="big">${usd(r.m.revenue)}</span></td>
        <td>${r.m.roas==null? '<span class="muted">—</span>' : pct(r.m.roas)}</td>
      </tr>
    `).join('');
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
      if(!rows.length){ alert('CSV contained no rows.'); return; }
      if(!confirm('Import '+rows.length+' entries? This replaces the current ledger.')) return;
      if(CloudSync.status==='connected'){
        await CloudSync.replaceAll(rows);
      } else {
        AppStore.replaceEntries(rows);
        renderLedger(); renderLeaderboard();
      }
    }catch(err){ alert('Import failed: '+err.message); }
  }

  return {
    bind, checkSession,
    renderAll: ()=> { renderAssets(); renderLedger(); renderLeaderboard(); },
    renderLedger, renderLeaderboard
  };
})();

/* ---------- boot ---------- */
DOMManager.bind();
DOMManager.checkSession();
