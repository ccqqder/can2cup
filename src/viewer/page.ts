/** The viewer's single page. Kept as a string so the viewer has zero build/asset steps. */
export const PAGE = /* html */ `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>can2cup viewer</title>
<style>
:root{--bg:#0f1115;--panel:#161a21;--line:#262c36;--fg:#e6e6e6;--mute:#8a93a3;--me:#2f4f8f;--them:#232a35;--sys:#1b1f27;--ok:#3ecf8e;--bad:#ff5c5c;--warn:#f0b429;--accent:#f4a26b}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;display:grid;grid-template-columns:260px 1fr;grid-template-rows:48px 1fr}
header{grid-column:1/3;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid var(--line);background:var(--panel)}
header b{color:var(--accent);letter-spacing:.04em}
header .id{color:var(--mute);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
header .sp{flex:1}
button{background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
button.pause{border-color:var(--warn);color:var(--warn)}button.pause.on{background:var(--bad);border-color:var(--bad);color:#fff}
aside{border-right:1px solid var(--line);background:var(--panel);overflow:auto}
aside .room{padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer}
aside .room:hover,aside .room.sel{background:#1c2129}
aside .room .n{font-weight:600}aside .room .m{color:var(--mute);font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}
main{display:flex;flex-direction:column;min-height:0}
.bar{display:flex;gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line);color:var(--mute);font-size:12px;flex-wrap:wrap}
.bar .ok{color:var(--ok)}.bar .bad{color:var(--bad)}.bar .st{padding:1px 8px;border:1px solid var(--line);border-radius:10px}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:72%;padding:8px 12px;border-radius:12px;background:var(--them);align-self:flex-start;position:relative}
.msg.me{background:var(--me);align-self:flex-end}
.msg.sys{align-self:center;background:var(--sys);color:var(--mute);font-size:12px;max-width:90%;padding:4px 10px}
.msg.blocked{align-self:flex-end;background:transparent;border:1px dashed var(--bad);color:var(--bad)}
.meta{font-size:11px;color:var(--mute);display:flex;gap:8px;align-items:center;margin-bottom:3px}
.msg.me .meta{color:#c9d4ea}
.type{font-family:ui-monospace,Menlo,Consolas,monospace;padding:0 6px;border-radius:8px;background:rgba(255,255,255,.08)}
.type.accept,.type.grant{background:var(--ok);color:#052}.type.close,.type.reject,.type.withdraw,.type.revoke{background:#444}.type.proposal,.type.counter{background:var(--accent);color:#3a1d05}.type.escalate{background:var(--warn);color:#3a2a05}.type.attachment,.type.question{background:#3b4a6b;color:#dfe7ff}.type.mechanism{background:#6b4a8b;color:#f0e6ff}
.att a{color:var(--accent)}.grantline{font-size:12px;color:#bfe9d3;margin-top:3px;font-family:ui-monospace,Menlo,Consolas,monospace}
.mechline{font-size:12px;color:#e2d3f5;margin-top:3px;font-family:ui-monospace,Menlo,Consolas,monospace}
.settle{align-self:center;max-width:90%;background:#241a2e;border:1px solid #6b4a8b;color:#e8dcf7;border-radius:12px;padding:6px 14px;font-size:12px;text-align:center}
.settle b{color:#c9a6ef;letter-spacing:.04em}.settle .deal{color:var(--ok);font-weight:700}.settle .nodeal{color:var(--warn);font-weight:700}
#invite{display:none;position:fixed;right:16px;top:56px;width:340px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;z-index:5;box-shadow:0 8px 30px rgba(0,0,0,.5)}
#invite.on{display:block}#invite h3{margin:0 0 8px;font-size:13px;color:var(--accent);letter-spacing:.06em}
#invite img{display:block;margin:0 auto 8px;background:#fff;padding:6px;border-radius:8px}
#invite textarea{width:100%;height:64px;background:#0b0d11;color:var(--fg);border:1px solid var(--line);border-radius:6px;font:12px ui-monospace,Menlo,Consolas,monospace;padding:6px;resize:none}
#invite .warn{font-size:11px;color:var(--mute);margin:6px 0 0}
.amt{font-weight:700;font-variant-numeric:tabular-nums}
.v{margin-left:auto}.v.ok{color:var(--ok)}.v.bad{color:var(--bad)}
.rat{margin-top:6px;padding:6px 8px;border-left:2px solid var(--warn);background:rgba(0,0,0,.25);font-size:12px;color:#e8d9a8;font-style:italic}
.rat b{font-style:normal;color:var(--warn);font-size:10px;letter-spacing:.06em}
.empty{margin:auto;color:var(--mute)}
</style></head><body>
<header><b>can2cup</b><span id="who" class="id"></span><span class="sp"></span>
<span id="pausedTxt" style="color:var(--mute);font-size:12px"></span>
<button id="inviteBtn" title="Invite link + QR for the selected room">INVITE</button>
<button id="pauseBtn" class="pause" title="Create/remove the PAUSED file: while paused your agent cannot send anything.">PAUSE</button></header>
<div id="invite"><h3>INVITE · <span id="invRoom"></span></h3><img id="invQr" width="240" height="240" alt="QR of the invite link"><textarea id="invLink" readonly></textarea><button id="invCopy">copy link</button> <span id="invCopied" style="color:var(--ok);font-size:12px"></span><div class="warn">This link is the room key — whoever holds it can read and post. Hand it to the other principal out-of-band (LINE, mail, in person via the QR); never post it publicly.</div></div>
<aside id="rooms"></aside>
<main><div class="bar" id="bar">選一間房</div><div id="log"><div class="empty">no room selected</div></div></main>
<script>
const $=s=>document.querySelector(s);
let state=null, cur=null, names={}, me="", seen=new Set(), blockedSeen=new Set(), poller=0, mechs={};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const t=(iso)=>{const d=new Date(iso);return d.toLocaleTimeString("zh-TW",{hour12:false})};
async function loadState(){state=await (await fetch("/api/state")).json();me=state.me.pub;
 $("#who").textContent=state.me.name+" · "+me.slice(0,8)+" · "+state.home+(state.notify?" · 🔔":"");
 setPaused(state.paused);
 const el=$("#rooms");el.innerHTML="";
 for(const r of state.rooms){const d=document.createElement("div");d.className="room"+(cur&&cur.id===r.id?" sel":"");
  d.innerHTML='<div class="n">'+esc(r.name||"(unnamed)")+'</div><div class="m">'+esc(r.id)+" · "+esc(r.state)+" · seq "+esc(r.lastSeq)+"</div>";
  d.onclick=()=>openRoom(r);el.appendChild(d);}
 if(!cur&&state.rooms.length)openRoom(state.rooms[0]);}
function setPaused(on){$("#pauseBtn").classList.toggle("on",on);$("#pauseBtn").textContent=on?"PAUSED — click to resume":"PAUSE";$("#pausedTxt").textContent=on?"⛔ your agent cannot send":"";}
$("#inviteBtn").onclick=async()=>{const p=$("#invite");if(p.classList.contains("on")){p.classList.remove("on");return;}if(!cur)return;
 const r=await (await fetch("/api/rooms/"+cur.id+"/invite")).json();$("#invRoom").textContent=(cur.name||cur.id);$("#invQr").src=r.qr;$("#invLink").value=r.link;$("#invCopied").textContent="";p.classList.add("on");};
$("#invCopy").onclick=async()=>{try{await navigator.clipboard.writeText($("#invLink").value);$("#invCopied").textContent="copied ✓";}catch(e){$("#invLink").select();}};
$("#pauseBtn").onclick=async()=>{const on=!$("#pauseBtn").classList.contains("on");const r=await (await fetch("/api/pause",{method:"POST",body:JSON.stringify({on})})).json();setPaused(r.paused);};
function extra(m){const b=m.body||{};let h="";
 if(m.type==="grant")h+='<div class="grantline">scope '+esc(b.scope||"")+' · until '+esc(b.expires||"")+(b.revocable===false?" · irrevocable":"")+'</div>';
 if(m.type==="revoke")h+='<div class="grantline">revokes #'+esc(b.ref)+'</div>';
 if(m.type==="attachment")h+='<div class="att">📎 '+esc(b.name||"")+' <a href="'+esc(b.url||"#")+'" target="_blank" rel="noopener">'+esc(b.url||"")+'</a>'+(b.sha256?' <span class="mute" style="font-size:11px">sha256 '+esc(String(b.sha256).slice(0,12))+'…</span>':"")+'</div>';
 if(m.type==="mechanism"){
  if(b.phase==="open")h+='<div class="mechline">sealed-bid k-double · opener takes '+esc(b.side||"")+' · k='+esc(b.k)+(b.currency?" · "+esc(b.currency):"")+' · #'+esc(m.seq)+'</div>';
  else if(b.phase==="commit")h+='<div class="mechline">🔒 '+esc(b.side||"")+' committed a sealed bid — hidden until both reveal (open #'+esc(b.ref)+')</div>';
  else if(b.phase==="reveal")h+='<div class="mechline">🔓 '+esc(b.side||"")+' revealed <span class="amt">'+esc(b.bid)+'</span> (open #'+esc(b.ref)+')</div>';
 }
 return h;}
function bubble(m){const mine=m.from===me, sys=m.from==="relay";
 const d=document.createElement("div");d.className="msg"+(mine?" me":"")+(sys?" sys":"");
 if(sys){const b=m.body||{};d.textContent=t(m.ts)+" · "+(b.event||"system")+" · "+(b.name||"")+" ("+String(b.by||"").slice(0,8)+")";return d;}
 const who=mine?"you":(names[m.from]||m.from.slice(0,8));const body=m.body||{};
 const mainTxt=(m.type==="mechanism")?("sealed-bid "+esc(body.phase||"")):esc(typeof body==="string"?body:(body.text||JSON.stringify(body)));
 d.innerHTML='<div class="meta"><span>'+esc(who)+'</span><span class="type '+esc(m.type)+'">'+esc(m.type)+'</span><span>'+t(m.ts)+'</span><span>#'+esc(m.seq)+'</span><span class="v '+(m.ok?"ok":"bad")+'" title="'+esc((m.errors||[]).join("; "))+'">'+(m.ok?"✓ verified":"✗ "+esc((m.errors||[]).join("; ")))+'</span></div>'
  +'<div>'+mainTxt+(m.type!=="mechanism"&&body.amount!=null?' <span class="amt">'+esc(body.amount)+'</span>':"")+'</div>'+extra(m);
 return d;}
// Fold a mechanism message into the running instances, and return a settlement to render when the second
// reveal lands. Display-only: the authoritative resolver (sealing invariant, hash-match, k-double) is
// protocol/mechanism.ts on the agent/relay side — this reproduces the k-split for the reader.
function noteMech(m){const b=m.body||{};
 if(b.phase==="open"){mechs[m.seq]={k:Number(b.k),cur:b.currency||"",commits:{},reveals:{}};return null;}
 const M=mechs[b.ref];if(!M)return null;
 if(b.phase==="commit"){M.commits[b.side]=true;return null;}
 if(b.phase==="reveal"){M.reveals[b.side]=Number(b.bid);
  if(!M.done&&M.reveals.buy!=null&&M.reveals.sell!=null){M.done=true;const bb=M.reveals.buy,ss=M.reveals.sell,deal=bb>=ss;
   return {open:b.ref,deal:deal,price:deal?Math.round(ss+M.k*(bb-ss)):null,buy:bb,sell:ss,k:M.k,cur:M.cur};}}
 return null;}
function settleBanner(s){const d=document.createElement("div");d.className="settle";
 d.innerHTML='<b>⚖ SEALED BID #'+esc(s.open)+' SETTLED</b> — '+(s.deal?'<span class="deal">DEAL at '+esc(s.price)+(s.cur?" "+esc(s.cur):"")+'</span>':'<span class="nodeal">NO DEAL</span>')+' · buy '+esc(s.buy)+' / sell '+esc(s.sell)+' · k='+esc(s.k);
 return d;}
function blockedBubble(b){const d=document.createElement("div");d.className="msg blocked";
 d.innerHTML='<div class="meta"><span>NOT SENT</span><span class="type '+esc(b.type)+'">'+esc(b.type)+'</span><span>'+t(b.at)+'</span></div><div>'+esc((b.body&&b.body.text)||JSON.stringify(b.body))+(b.body&&b.body.amount!=null?' <span class="amt">'+esc(b.body.amount)+'</span>':"")+'</div><div class="rat"><b>BLOCKED</b> '+esc(b.reason||"")+(b.rationale?'<br><b>RATIONALE</b> '+esc(b.rationale):"")+'</div>';return d;}
function render(data){const log=$("#log");if(log.querySelector(".empty"))log.innerHTML="";names=data.names||names;
 const items=[];
 for(const m of data.msgs){if(seen.has(m.seq))continue;seen.add(m.seq);items.push({at:m.ts,el:bubble(m),seq:m.seq,m});
  if(m.type==="mechanism"&&m.ok!==false){const s=noteMech(m);if(s)items.push({at:m.ts,el:settleBanner(s)});}}
 for(const b of data.blocked||[]){const k=b.at+"|"+JSON.stringify(b.body);if(blockedSeen.has(k))continue;blockedSeen.add(k);items.push({at:b.at,el:blockedBubble(b)});}
 items.sort((a,b)=>a.at.localeCompare(b.at));
 for(const it of items){if(it.m&&it.m.from===me&&data.rationale&&data.rationale[it.seq]){const r=document.createElement("div");r.className="rat";r.innerHTML="<b>PRIVATE RATIONALE</b> "+esc(data.rationale[it.seq]);it.el.appendChild(r);}log.appendChild(it.el);}
 if(items.length)log.scrollTop=log.scrollHeight;
 const parts=Object.entries(names).map(([pk,n])=>esc(n)+(pk===me?" (you)":"")+" "+pk.slice(0,8)).join(" · ");
 $("#bar").innerHTML='<b>'+esc(data.room.name||"(unnamed)")+'</b><span class="st">'+esc(data.room.state)+'</span><span>'+esc(data.room.id)+'</span><span>'+parts+'</span><span class="sp"></span><span class="'+(data.chainOk?"ok":"bad")+'">'+(data.chainOk?"chain ✓ ("+esc(data.lastSeq)+")":"CHAIN BROKEN")+'</span>';}
async function openRoom(r){cur=r;seen=new Set();blockedSeen=new Set();mechs={};$("#log").innerHTML="";clearTimeout(poller);$("#invite").classList.remove("on");
 document.querySelectorAll(".room").forEach(e=>e.classList.toggle("sel",e.querySelector(".m").textContent.startsWith(r.id)));
 const first=await (await fetch("/api/rooms/"+r.id+"?full=1")).json();render(first);poll();}
async function poll(){if(!cur)return;const id=cur.id;try{const d=await (await fetch("/api/rooms/"+id+"?wait=25")).json();if(cur&&cur.id===id)render(d);}catch(e){}
 if(cur&&cur.id===id)poller=setTimeout(poll,300);}
loadState();setInterval(async()=>{const s=await (await fetch("/api/state")).json();setPaused(s.paused);if(s.rooms.length!==(state?state.rooms.length:0))loadState();},5000);
</script></body></html>`;
