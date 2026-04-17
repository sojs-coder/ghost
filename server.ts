#!/usr/bin/env bun
/**
 * Ghost Device Dashboard Server
 * Serves the web dashboard and controls ghost-run.py via the control file interface.
 *
 * Run on the Ghost Device:  bun run server.ts
 * Then visit:               http://<device-ip>:7070  (or http://ghost.local:7070)
 *
 * Control interface (matches ghost-run.py):
 *   /tmp/ghost-control.json  — write commands here; runner polls every ~0.25s
 *   /tmp/ghost-status.json   — runner writes state here every waypoint tick
 */

import { serve } from "bun";
import { readdir, stat, mkdir } from "fs/promises";
import { join } from "path";

const PORT            = 7070;
const ROUTES_DIR      = "/data/routes";
const STATUS_FILE     = "/tmp/ghost-status.json";
const CONTROL_FILE    = "/tmp/ghost-control.json";
const RUNNER_PID_FILE = "/tmp/ghost-runner.pid";

// ─── File-based control ───────────────────────────────────────────────────────
async function writeControl(cmd: object): Promise<void> {
  await Bun.write(CONTROL_FILE, JSON.stringify(cmd));
}

async function readStatus(): Promise<object> {
  try {
    const raw = await Bun.file(STATUS_FILE).text();
    return JSON.parse(raw);
  } catch {
    try {
      const pid = (await Bun.file(RUNNER_PID_FILE).text()).trim();
      if (pid) return { state: "initializing", runner_pid: Number(pid) };
    } catch {}
    return { state: "stopped" };
  }
}

// ─── Route file helpers ───────────────────────────────────────────────────────
function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function listRoutes(): Promise<object[]> {
  try {
    const files = await readdir(ROUTES_DIR);
    const routes = await Promise.all(
      files
        .filter((f) => f.endsWith(".gpx") || f.endsWith(".grf"))
        .map(async (f) => {
          const s = await stat(join(ROUTES_DIR, f));
          const id  = f.replace(/\.(gpx|grf)$/, "");
          const ext = f.endsWith(".gpx") ? "gpx" : "grf";
          // GRF: (filesize - 16 header) / 12 bytes per waypoint @ 1Hz
          // GPX: rough estimate (~40 bytes/waypoint in XML)
          const waypoints = ext === "grf"
            ? Math.max(0, Math.floor((s.size - 16) / 12))
            : Math.max(0, Math.floor(s.size / 40));
          return {
            id,
            filename: f,
            path: join(ROUTES_DIR, f),
            ext,
            name: id.replace(/[_-]/g, " "),
            size_bytes: s.size,
            waypoints,
            duration_secs: waypoints,
            duration_label: formatDuration(waypoints),
          };
        })
    );
    return routes;
  } catch {
    return [];
  }
}

async function saveUpload(filename: string, data: Uint8Array): Promise<void> {
  await mkdir(ROUTES_DIR, { recursive: true });
  const safe = filename.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
  await Bun.write(join(ROUTES_DIR, safe), data);
}

// ─── HTML dashboard ───────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ghost \xB7 Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:#0e0d0b;--surface:#161512;--surface2:#1e1c18;--border:#2a2720;
  --dim:#5a5650;--mid:#8a8478;--text:#e8e2d8;--text-dim:#9a9488;
  --green:#5ddb8a;--green-glow:rgba(93,219,138,0.10);
  --amber:#e8a840;--amber-glow:rgba(232,168,64,0.10);--red:#e85858;
  --mono:'DM Mono',monospace;--serif:'DM Serif Display',serif;
  --sans:'DM Sans',sans-serif;--r:3px;
}
html{height:100%}
body{font-family:var(--sans);font-weight:300;background:var(--bg);color:var(--text);min-height:100%;-webkit-font-smoothing:antialiased;}
.layout{display:grid;grid-template-columns:240px 1fr;min-height:100vh;}
aside{background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:28px 0;position:sticky;top:0;height:100vh;overflow-y:auto;}
.logo{font-family:var(--serif);font-size:22px;letter-spacing:-0.02em;padding:0 22px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;}
.logo-badge{font-family:var(--mono);font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:var(--dim);border:1px solid var(--border);padding:3px 7px;border-radius:2px;}
.nav{padding:16px 0;flex:1;}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 22px;font-size:13px;font-weight:400;color:var(--mid);cursor:pointer;transition:color .15s,background .15s;border-left:2px solid transparent;letter-spacing:0.01em;}
.nav-item:hover{color:var(--text);background:rgba(255,255,255,0.025);}
.nav-item.active{color:var(--green);border-left-color:var(--green);background:var(--green-glow);}
.sidebar-status{padding:18px 22px;border-top:1px solid var(--border);font-family:var(--mono);font-size:11px;}
.srow{display:flex;justify-content:space-between;margin-bottom:7px;}
.srow:last-child{margin-bottom:0;}
.sl{color:var(--dim);letter-spacing:0.06em;text-transform:uppercase;}
.sv{color:var(--text-dim);}
.sv.green{color:var(--green);}.sv.amber{color:var(--amber);}.sv.red{color:var(--red);}
main{padding:40px 44px;max-width:860px;}
.page{display:none;}.page.active{display:block;}
.page-header{margin-bottom:32px;padding-bottom:22px;border-bottom:1px solid var(--border);}
.eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--dim);margin-bottom:8px;}
.page-title{font-family:var(--serif);font-size:30px;letter-spacing:-0.02em;line-height:1.1;}
.now-playing{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:28px;margin-bottom:24px;position:relative;overflow:hidden;transition:border-color .3s;}
.now-playing::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at top left,var(--green-glow) 0%,transparent 65%);pointer-events:none;opacity:0;transition:opacity .4s;}
.now-playing.playing{border-color:rgba(93,219,138,0.25);}
.now-playing.playing::before{opacity:1;}
.now-playing.paused{border-color:rgba(232,168,64,0.2);}
.now-playing.paused::before{background:radial-gradient(ellipse at top left,var(--amber-glow) 0%,transparent 65%);opacity:1;}
.np-state{font-family:var(--mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:14px;display:flex;align-items:center;gap:8px;}
.dot{width:7px;height:7px;border-radius:50%;background:var(--dim);transition:background .3s,box-shadow .3s;flex-shrink:0;}
.playing .dot{background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite;}
.paused .dot{background:var(--amber);}
@keyframes pulse{0%,100%{box-shadow:0 0 5px var(--green);}50%{box-shadow:0 0 14px var(--green);}}
.np-route{font-family:var(--serif);font-size:24px;letter-spacing:-0.02em;margin-bottom:5px;min-height:32px;text-transform:capitalize;}
.np-meta{font-family:var(--mono);font-size:11px;color:var(--dim);margin-bottom:24px;}
.prog-wrap{background:var(--surface2);height:2px;border-radius:2px;margin-bottom:6px;overflow:hidden;}
.prog-fill{height:100%;background:var(--green);border-radius:2px;width:0%;transition:width .5s linear;}
.prog-labels{display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--dim);margin-bottom:24px;}
.controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.btn{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:0.07em;padding:9px 16px;border-radius:var(--r);border:1px solid var(--border);background:var(--surface2);color:var(--mid);cursor:pointer;transition:all .15s;text-transform:uppercase;white-space:nowrap;}
.btn:hover{border-color:var(--mid);color:var(--text);}
.btn.primary{background:var(--green);border-color:var(--green);color:#091a0f;font-weight:500;}
.btn.primary:hover{filter:brightness(1.08);}
.btn.danger{border-color:#3a1e1e;color:var(--red);}
.btn.danger:hover{background:rgba(232,88,88,0.08);border-color:var(--red);}
.btn:disabled{opacity:.3;cursor:not-allowed;pointer-events:none;}
.speed-btns{display:flex;margin-left:auto;}
.sbtn{font-family:var(--mono);font-size:11px;padding:8px 13px;border:1px solid var(--border);background:transparent;color:var(--dim);cursor:pointer;transition:all .15s;margin-left:-1px;}
.sbtn:first-child{border-radius:var(--r) 0 0 var(--r);}
.sbtn:last-child{border-radius:0 var(--r) var(--r) 0;}
.sbtn.active{background:var(--surface2);color:var(--text);border-color:var(--mid);z-index:1;position:relative;}
.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px 20px;}
.stat-val{font-family:var(--serif);font-size:24px;letter-spacing:-0.02em;margin-bottom:4px;line-height:1;}
.stat-label{font-family:var(--mono);font-size:10px;color:var(--dim);letter-spacing:0.08em;text-transform:uppercase;}
.route-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
.route-count{font-family:var(--mono);font-size:11px;color:var(--dim);}
.route-list{display:flex;flex-direction:column;gap:2px;}
.route-item{display:flex;align-items:center;gap:14px;padding:14px 18px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);transition:border-color .15s,background .15s;}
.route-item:hover{border-color:var(--dim);background:var(--surface2);}
.route-item.active-route{border-color:rgba(93,219,138,0.4);background:var(--green-glow);}
.route-num{font-family:var(--mono);font-size:10px;color:var(--dim);width:18px;flex-shrink:0;text-align:right;}
.route-info{flex:1;min-width:0;}
.route-name{font-size:13px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:capitalize;margin-bottom:3px;}
.route-meta{font-family:var(--mono);font-size:10px;color:var(--dim);}
.route-ext{font-family:var(--mono);font-size:9px;color:var(--dim);border:1px solid var(--border);padding:2px 5px;border-radius:2px;flex-shrink:0;text-transform:uppercase;}
.route-actions{display:flex;gap:6px;flex-shrink:0;}
.rbtn{font-family:var(--mono);font-size:10px;padding:5px 10px;border:1px solid var(--border);background:var(--surface);color:var(--mid);border-radius:var(--r);cursor:pointer;transition:all .15s;}
.rbtn:hover{border-color:var(--mid);color:var(--text);}
.rbtn.load:hover{border-color:var(--green);color:var(--green);background:var(--green-glow);}
.upload-zone{border:1px dashed var(--border);border-radius:var(--r);padding:44px;text-align:center;transition:border-color .2s,background .2s;cursor:pointer;margin-bottom:24px;}
.upload-zone:hover,.upload-zone.drag-over{border-color:var(--green);background:var(--green-glow);}
.upload-icon{font-size:26px;margin-bottom:12px;opacity:.45;}
.upload-title{font-size:14px;font-weight:400;margin-bottom:6px;}
.upload-sub{font-family:var(--mono);font-size:11px;color:var(--dim);}
#file-input{display:none;}
.upload-log{font-family:var(--mono);font-size:12px;color:var(--dim);min-height:24px;}
#toast{position:fixed;bottom:24px;right:24px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:11px 16px;font-family:var(--mono);font-size:12px;color:var(--text-dim);transform:translateY(70px);opacity:0;transition:all .22s cubic-bezier(.16,1,.3,1);z-index:999;max-width:260px;}
#toast.show{transform:translateY(0);opacity:1;}
#toast.ok{border-color:var(--green);color:var(--green);}
#toast.err{border-color:var(--red);color:var(--red);}
::-webkit-scrollbar{width:4px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px;}
@media(max-width:680px){
  .layout{grid-template-columns:1fr;}
  aside{height:auto;position:static;flex-direction:row;flex-wrap:wrap;padding:14px;gap:8px;}
  .logo{border-bottom:none;border-right:1px solid var(--border);padding:0 14px 0 0;}
  .nav{display:flex;padding:0;}
  .sidebar-status{display:none;}
  main{padding:24px 18px;}
  .stats-grid{grid-template-columns:1fr 1fr;}
  .speed-btns{margin-left:0;}
}
</style>
</head>
<body>
<div class="layout">
  <aside>
    <div class="logo">Ghost <span class="logo-badge">Device</span></div>
    <nav class="nav">
      <div class="nav-item active" data-page="session" onclick="navTo(this)">\u25B6\xA0\xA0Session</div>
      <div class="nav-item" data-page="routes"  onclick="navTo(this)">\u2261\xA0\xA0 Routes</div>
      <div class="nav-item" data-page="upload"  onclick="navTo(this)">\u2191\xA0\xA0 Upload</div>
    </nav>
    <div class="sidebar-status">
      <div class="srow"><span class="sl">State</span><span class="sv" id="s-state">\u2014</span></div>
      <div class="srow"><span class="sl">Route</span><span class="sv" id="s-route" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\u2014</span></div>
      <div class="srow"><span class="sl">Speed</span><span class="sv" id="s-speed">\u2014</span></div>
      <div class="srow"><span class="sl">Loop</span><span class="sv"  id="s-loop">\u2014</span></div>
    </div>
  </aside>
  <main>
    <div class="page active" id="page-session">
      <div class="page-header">
        <div class="eyebrow">Live Control</div>
        <div class="page-title">Session</div>
      </div>
      <div class="now-playing" id="now-playing">
        <div class="np-state"><div class="dot" id="state-dot"></div><span id="state-label">Stopped</span></div>
        <div class="np-route" id="np-route">No active session</div>
        <div class="np-meta"  id="np-meta">\u2014</div>
        <div class="prog-wrap"><div class="prog-fill" id="prog-fill"></div></div>
        <div class="prog-labels"><span id="prog-elapsed">0:00</span><span id="prog-total">0:00</span></div>
        <div class="controls">
          <button class="btn primary" onclick="cmd('play')">\u25B6 Play</button>
          <button class="btn"         onclick="cmd('pause')">\u23F8 Pause</button>
          <button class="btn danger"  onclick="cmd('stop')">\u25A0 Stop</button>
          <div class="speed-btns">
            <button class="sbtn active" data-speed="1" onclick="setSpeed(1)">1\xD7</button>
            <button class="sbtn"        data-speed="2" onclick="setSpeed(2)">2\xD7</button>
            <button class="sbtn"        data-speed="4" onclick="setSpeed(4)">4\xD7</button>
          </div>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-val" id="stat-wp">\u2014</div><div class="stat-label">Waypoint</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-pct">\u2014</div><div class="stat-label">Progress</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-speed">1\xD7</div><div class="stat-label">Speed</div></div>
        <div class="stat-card"><div class="stat-val" id="stat-loop">\u2014</div><div class="stat-label">Loop #</div></div>
      </div>
    </div>

    <div class="page" id="page-routes">
      <div class="page-header">
        <div class="eyebrow">Cover Routes</div>
        <div class="page-title">Route Library</div>
      </div>
      <div class="route-toolbar">
        <span class="route-count" id="route-count">\u2014</span>
        <button class="btn" onclick="loadRoutes()">\u21BB Refresh</button>
      </div>
      <div class="route-list" id="route-list">
        <div style="color:var(--dim);font-family:var(--mono);font-size:11px;padding:14px 0">Loading routes\u2026</div>
      </div>
    </div>

    <div class="page" id="page-upload">
      <div class="page-header">
        <div class="eyebrow">Add Routes</div>
        <div class="page-title">Upload Route File</div>
      </div>
      <div class="upload-zone" id="upload-zone" onclick="document.getElementById('file-input').click()">
        <div class="upload-icon">\u2912</div>
        <div class="upload-title">Drop a .gpx or .grf file here</div>
        <div class="upload-sub">or click to browse \xB7 GPX and Ghost Route Format accepted</div>
      </div>
      <input type="file" id="file-input" accept=".gpx,.grf" multiple onchange="handleFiles(this.files)">
      <div class="upload-log" id="upload-log"></div>
    </div>
  </main>
</div>
<div id="toast"></div>
<script>
var _currentRouteId=null,_st={};
function navTo(el){
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('page-'+el.dataset.page).classList.add('active');
  if(el.dataset.page==='routes')loadRoutes();
}
var _tt;
function toast(msg,type){
  var el=document.getElementById('toast');
  el.textContent=msg;el.className='show '+(type||'');
  clearTimeout(_tt);_tt=setTimeout(()=>el.className='',2600);
}
async function cmd(c,extra){
  try{
    var res=await fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({cmd:c},extra))});
    if(!res.ok){var j=await res.json();throw new Error(j.error||'Failed');}
    toast(c+' sent','ok');
  }catch(e){toast(e.message,'err');}
}
function setSpeed(n){
  document.querySelectorAll('.sbtn').forEach(b=>b.classList.toggle('active',+b.dataset.speed===n));
  cmd('set_speed',{multiplier:n});
}
function fmtTime(s){
  if(s==null||isNaN(s))return'\u2014';
  s=Math.floor(s);var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
  if(h>0)return h+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0');
  return m+':'+String(ss).padStart(2,'0');
}
async function pollStatus(){
  try{var res=await fetch('/api/status');_st=await res.json();applyStatus(_st);}catch(e){}
}
function applyStatus(st){
  var state=(st.state||'stopped').toLowerCase();
  var sv=document.getElementById('s-state');
  sv.textContent=state;
  sv.className='sv '+(state==='playing'?'green':state==='paused'?'amber':state==='reconnecting'?'amber':'');
  document.getElementById('s-route').textContent=st.route_name||'\u2014';
  document.getElementById('s-speed').textContent=st.speed_multiplier!=null?st.speed_multiplier+'\xD7':'\u2014';
  document.getElementById('s-loop').textContent=st.loop!=null?(st.loop?'yes':'no'):'\u2014';
  var card=document.getElementById('now-playing');
  card.className='now-playing '+(state==='playing'?'playing':state==='paused'?'paused':'');
  document.getElementById('state-label').textContent=
    state==='playing'?'Playing':state==='paused'?'Paused':
    state==='initializing'?'Initializing':state==='reconnecting'?'Reconnecting':
    state==='idle'?'Idle':'Stopped';
  document.getElementById('np-route').textContent=st.route_name||'No active session';
  document.getElementById('np-meta').textContent=st.route_id
    ?(st.route_id+(st.waypoint_total?' \xB7 '+st.waypoint_total+' waypoints':''))
    :'\u2014';
  var pct=st.waypoint_total>0?(st.waypoint_index/st.waypoint_total*100):0;
  document.getElementById('prog-fill').style.width=pct+'%';
  document.getElementById('prog-elapsed').textContent=fmtTime(st.waypoint_index);
  document.getElementById('prog-total').textContent=fmtTime(st.waypoint_total);
  document.getElementById('stat-wp').textContent=st.waypoint_total>0
    ?(st.waypoint_index||0)+' / '+st.waypoint_total:'\u2014';
  document.getElementById('stat-pct').textContent=st.waypoint_total>0?pct.toFixed(1)+'%':'\u2014';
  document.getElementById('stat-speed').textContent=(st.speed_multiplier||1)+'\xD7';
  document.getElementById('stat-loop').textContent=st.loop_count!=null?'#'+(st.loop_count+1):'\u2014';
  document.querySelectorAll('.sbtn').forEach(b=>b.classList.toggle('active',+b.dataset.speed===(st.speed_multiplier||1)));
  if(st.route_id&&st.route_id!==_currentRouteId){
    _currentRouteId=st.route_id;
    document.querySelectorAll('.route-item').forEach(el=>el.classList.toggle('active-route',el.dataset.id===st.route_id));
  }
}
setInterval(pollStatus,1500);pollStatus();
async function loadRoutes(){
  var list=document.getElementById('route-list');
  list.innerHTML='<div style="color:var(--dim);font-family:var(--mono);font-size:11px;padding:14px 0">Loading\u2026</div>';
  try{
    var res=await fetch('/api/routes'),routes=await res.json();
    document.getElementById('route-count').textContent=routes.length+' route'+(routes.length===1?'':'s');
    if(!routes.length){list.innerHTML='<div style="color:var(--dim);font-family:var(--mono);font-size:11px;padding:14px 0">No .gpx or .grf files in /data/routes/</div>';return;}
    list.innerHTML='';
    routes.forEach(function(r,i){
      var el=document.createElement('div');
      el.className='route-item'+(_st.route_id===r.id?' active-route':'');
      el.dataset.id=r.id;
      el.innerHTML=
        '<span class="route-num">'+String(i+1).padStart(2,'0')+'</span>'+
        '<div class="route-info">'+
          '<div class="route-name">'+esc(r.name)+'</div>'+
          '<div class="route-meta">'+r.duration_label+' \xB7 '+r.waypoints.toLocaleString()+' waypoints \xB7 '+fmtBytes(r.size_bytes)+'</div>'+
        '</div>'+
        '<span class="route-ext">'+r.ext+'</span>'+
        '<div class="route-actions">'+
          '<button class="rbtn load" onclick="loadRoute('+JSON.stringify(r.id)+','+JSON.stringify(r.path)+',event)">Load</button>'+
        '</div>';
      list.appendChild(el);
    });
  }catch(e){list.innerHTML='<div style="color:var(--red);font-family:var(--mono);font-size:11px;padding:14px 0">Error: '+esc(e.message)+'</div>';}
}
async function loadRoute(id,path,e){
  e.stopPropagation();
  try{
    var res=await fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:'set_route',route_id:id,route_path:path})});
    if(!res.ok)throw new Error('Failed');
    toast('Route queued: '+id,'ok');
    document.querySelectorAll('.route-item').forEach(el=>el.classList.toggle('active-route',el.dataset.id===id));
  }catch(e){toast(e.message,'err');}
}
var zone=document.getElementById('upload-zone');
zone.addEventListener('dragover',function(e){e.preventDefault();zone.classList.add('drag-over');});
zone.addEventListener('dragleave',function(){zone.classList.remove('drag-over');});
zone.addEventListener('drop',function(e){e.preventDefault();zone.classList.remove('drag-over');handleFiles(e.dataTransfer.files);});
async function handleFiles(files){
  var log=document.getElementById('upload-log');
  for(var i=0;i<files.length;i++){
    var file=files[i];
    if(!file.name.endsWith('.gpx')&&!file.name.endsWith('.grf')){toast(file.name+' \u2014 not .gpx or .grf','err');continue;}
    log.textContent='Uploading '+file.name+'\u2026';
    var fd=new FormData();fd.append('file',file);
    try{
      var res=await fetch('/api/upload',{method:'POST',body:fd});
      var j=await res.json();
      if(!res.ok)throw new Error(j.error);
      log.textContent='\u2713 '+file.name+' saved to /data/routes/';
      toast('Uploaded '+file.name,'ok');
    }catch(e){log.textContent='\u2717 '+file.name+': '+e.message;toast('Upload failed: '+e.message,'err');}
  }
}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);});}
function fmtBytes(n){return n>1048576?(n/1048576).toFixed(1)+' MB':(n/1024).toFixed(0)+' KB';}
<\/script>
</body>
</html>`;

// ─── HTTP server ──────────────────────────────────────────────────────────────
serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/status") {
      return Response.json(await readStatus());
    }

    if (url.pathname === "/api/routes") {
      return Response.json(await listRoutes());
    }

    if (url.pathname === "/api/cmd" && req.method === "POST") {
      let body: object;
      try { body = await req.json(); }
      catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
      try {
        await writeControl(body);
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ error: e?.message || "Write failed" }, { status: 500 });
      }
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      try {
        const form = await req.formData();
        const file = form.get("file") as File | null;
        if (!file) return Response.json({ error: "No file" }, { status: 400 });

        const name = file.name.toLowerCase();
        if (!name.endsWith(".gpx") && !name.endsWith(".grf")) {
          return Response.json({ error: "Only .gpx and .grf files accepted" }, { status: 415 });
        }

        const buf = new Uint8Array(await file.arrayBuffer());

        if (name.endsWith(".grf")) {
          if (buf[0] !== 0x47 || buf[1] !== 0x52 || buf[2] !== 0x46 || buf[3] !== 0x54) {
            return Response.json({ error: "Not a valid GRF file (bad magic bytes)" }, { status: 422 });
          }
        }

        await saveUpload(file.name, buf);
        return Response.json({ ok: true, filename: file.name });
      } catch (e: any) {
        return Response.json({ error: e?.message || "Upload failed" }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\nGhost Dashboard \u2192 http://0.0.0.0:${PORT}`);
console.log(`  Control: ${CONTROL_FILE}`);
console.log(`  Status:  ${STATUS_FILE}\n`);