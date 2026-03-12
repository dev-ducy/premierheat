import { useState, useEffect, useCallback, useRef } from "react";

// ─── League config ────────────────────────────────────────────────────────────
// ESPN league slug → used in: /apis/site/v2/sports/soccer/{slug}/scoreboard
const LEAGUES = [
  { id: "eng.1", label: "Premier League", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { id: "esp.1", label: "La Liga",        flag: "🇪🇸" },
  { id: "ger.1", label: "Bundesliga",     flag: "🇩🇪" },
  { id: "ita.1", label: "Serie A",        flag: "🇮🇹" },
  { id: "fra.1", label: "Ligue 1",        flag: "🇫🇷" },
  { id: "uefa.champions", label: "UCL",   flag: "⭐" },
];

// ESPN base – no proxy needed, it's CORS-open
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// ─── Date helpers ─────────────────────────────────────────────────────────────
const TODAY = (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
function toDateStr(d)  { return d.toISOString().slice(0,10); }
function toESPN(d)     { return toDateStr(d).replace(/-/g,""); } // YYYYMMDD
function fromDateStr(s){ const [y,m,dd]=s.split("-").map(Number); return new Date(y,m-1,dd); }
function addDays(d,n)  { const r=new Date(d); r.setDate(r.getDate()+n); return r; }
function sameDay(a,b)  { return toDateStr(a)===toDateStr(b); }
function fmtShort(d)   { return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}); }
function fmtMonthYear(d){ return d.toLocaleDateString("en-US",{month:"long",year:"numeric"}); }
function fmtTime(iso)  { return new Date(iso).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:true}); }

// ─── ESPN data parser ─────────────────────────────────────────────────────────
// Map ESPN status codes → our internal statuses
function parseStatus(competition) {
  const state = competition.status?.type?.state;
  if (state === "post") return "final";
  if (state === "in") return "inprogress";
  return "scheduled";
}

// Parse the `details` array ESPN embeds per competition into our key_events shape
function parseDetails(competition) {
  const details = competition.details || [];
  const homeId = competition.competitors?.find(c => c.homeAway === "home")?.id;

  return details.map(d => {
    const minute = Math.round((d.clock?.value || 0) / 60);
    const team   = d.team?.id === homeId ? "home" : "away";

    if (d.scoringPlay)   return { type: "score_change", time: minute, team };
    if (d.redCard)       return { type: "red_card",     time: minute, team };
    if (d.yellowCard)    return { type: "yellow_card",  time: minute, team };
    if (d.type?.text?.toLowerCase().includes("substitut")) return { type: "substitution", time: minute, team };
    return null;
  }).filter(Boolean);
}

// Parse a full ESPN scoreboard response into our game list
function parseScoreboard(data, leagueId) {
  const leagueLabel = LEAGUES.find(l => l.id === leagueId)?.label || leagueId;
  return (data.events || []).map(event => {
    const comp = event.competitions?.[0];
    if (!comp) return null;
    const home = comp.competitors?.find(c => c.homeAway === "home");
    const away = comp.competitors?.find(c => c.homeAway === "away");
    const status = parseStatus(comp);
    const keyEvents = parseDetails(comp);

    // Live clock label
    let liveMinute = null;
    if (status === "inprogress") {
      liveMinute = comp.status?.displayClock || null;
    }

    return {
      id: event.id,
      homeTeam: home?.team?.displayName || "Home",
      awayTeam: away?.team?.displayName || "Away",
      homeLogo: home?.team?.logo || null,
      awayLogo: away?.team?.logo || null,
      homeColor: home?.team?.color ? `#${home.team.color}` : "#333",
      awayColor: away?.team?.color ? `#${away.team.color}` : "#333",
      status,
      liveMinute,
      startTime: comp.date || event.date,
      date: toDateStr(new Date(event.date)),
      league: leagueLabel,
      leagueId,
      venue: comp.venue?.fullName || null,
      keyEvents,    // ← real ESPN data, no AI needed
    };
  }).filter(Boolean);
}

// ─── Heat helpers ─────────────────────────────────────────────────────────────
const WEIGHTS = { score_change:8, red_card:6, yellow_card:2, substitution:1 };
const BUCKETS = 18; // 5-min segments × 18 = 90 min

function buildBuckets(keyEvents=[]) {
  const c = new Array(BUCKETS).fill(0);
  keyEvents.forEach(ev => {
    const t = Math.max(1, Math.min(ev.time||1, 90));
    const b = Math.min(Math.floor((t-1)/5), BUCKETS-1);
    c[b] += WEIGHTS[ev.type] ?? 1;
  });
  return c;
}

function heatColor(v, max) {
  if (!max || v===0) return "#0d0d1c";
  const r = v/max;
  if (r < 0.2)  return "#0d3b2e";
  if (r < 0.4)  return "#1a5c1a";
  if (r < 0.55) return "#7a8c00";
  if (r < 0.7)  return "#c47000";
  if (r < 0.85) return "#d44000";
  return "#e81020";
}

function excScore(buckets) {
  return Math.round((Math.min(buckets.reduce((a,b)=>a+b,0),40)/40)*100);
}

function actionLabel(s) {
  if (s===0)   return "Quiet";
  if (s<25)    return "Low";
  if (s<50)    return "Moderate";
  if (s<75)    return "High";
  return "🔥 Intense";
}

// ─── Heat strip ───────────────────────────────────────────────────────────────
function HeatStrip({ buckets, compact }) {
  const max = Math.max(...buckets, 1);
  return (
    <div style={{ display:"flex", gap:2, borderRadius:6, overflow:"hidden", height:compact?22:34 }}>
      {buckets.map((v,i) => (
        <div key={i} title={`${i*5+1}–${(i+1)*5}′`}
          style={{ flex:1, background:heatColor(v,max), transition:"background 0.3s", position:"relative" }}>
          {!compact && v>0 && v===Math.max(...buckets) && (
            <div style={{ position:"absolute", bottom:3, left:"50%", transform:"translateX(-50%)",
              width:3, height:3, borderRadius:"50%", background:"#fff", boxShadow:"0 0 5px #fff" }} />
          )}
        </div>
      ))}
    </div>
  );
}

function ExcBar({ score }) {
  const color = score<30?"#2d6a4f":score<60?"#f0a500":"#e81020";
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:5 }}>
      <div style={{ flex:1, background:"#0a0a18", borderRadius:99, height:5, overflow:"hidden" }}>
        <div style={{ width:`${score}%`, height:"100%",
          background:`linear-gradient(90deg,#2d6a4f,${color})`,
          transition:"width 0.8s cubic-bezier(.4,0,.2,1)" }} />
      </div>
      <span style={{ fontSize:10, color, fontWeight:700, minWidth:24 }}>{score}</span>
    </div>
  );
}

// ─── Calendar popup ───────────────────────────────────────────────────────────
function CalendarPicker({ selected, onSelect, onClose, validDates }) {
  const [view, setView] = useState(new Date(selected.getFullYear(), selected.getMonth(), 1));
  const y=view.getFullYear(), m=view.getMonth();
  const days=new Date(y,m+1,0).getDate();
  const startDay=new Date(y,m,1).getDay();
  const MIN=addDays(TODAY,-120), MAX=addDays(TODAY,60);

  // Build set of YYYYMMDD strings that have known matches
  const validSet = new Set((validDates||[]).map(s => s.replace(/-/g,"")));

  const cells=[];
  for(let i=0;i<startDay;i++) cells.push(null);
  for(let d=1;d<=days;d++) cells.push(new Date(y,m,d));

  const lastSat=(() => { const d=new Date(TODAY); d.setDate(d.getDate()-((d.getDay()+1)%7+1)); return d; })();

  return (
    <div style={{
      position:"absolute", top:"calc(100% + 6px)", right:0, zIndex:300,
      background:"#0c0c1a", border:"1px solid rgba(255,255,255,0.12)",
      borderRadius:16, padding:18, width:272,
      boxShadow:"0 28px 70px rgba(0,0,0,0.85)",
    }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
        <button onClick={()=>setView(new Date(y,m-1,1))}
          style={{ background:"none", border:"none", color:"#888", cursor:"pointer", fontSize:20, padding:"0 4px" }}>‹</button>
        <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:15, fontWeight:700, color:"#fff" }}>
          {fmtMonthYear(view)}
        </span>
        <button onClick={()=>setView(new Date(y,m+1,1))}
          style={{ background:"none", border:"none", color:"#888", cursor:"pointer", fontSize:20, padding:"0 4px" }}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2, marginBottom:4 }}>
        {["S","M","T","W","T","F","S"].map((d,i)=>(
          <div key={i} style={{ textAlign:"center", fontSize:10, color:"#333", fontWeight:600 }}>{d}</div>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
        {cells.map((d,i)=>{
          if(!d) return <div key={i}/>;
          const isSel=sameDay(d,selected), isTod=sameDay(d,TODAY);
          const disabled=d<MIN||d>MAX;
          const espnStr=toESPN(d);
          const hasMatches=validSet.size===0 || validSet.has(espnStr);
          return (
            <button key={i} disabled={disabled} onClick={()=>{ onSelect(d); onClose(); }}
              style={{
                background: isSel?"#e81020": isTod?"rgba(232,16,32,0.15)":"transparent",
                border: isTod&&!isSel?"1px solid rgba(232,16,32,0.4)":"1px solid transparent",
                color: disabled?"#252535": isSel?"#fff": d<TODAY?"#777":"#ccc",
                borderRadius:7, padding:"5px 0", cursor:disabled?"default":"pointer",
                fontSize:12, fontWeight: isSel||isTod?700:400,
                position:"relative",
              }}>
              {d.getDate()}
              {hasMatches && !disabled && !isSel && (
                <div style={{ position:"absolute", bottom:2, left:"50%", transform:"translateX(-50%)",
                  width:3, height:3, borderRadius:"50%", background: isTod?"#e81020":"#2d6a4f" }} />
              )}
            </button>
          );
        })}
      </div>
      <div style={{ display:"flex", gap:5, marginTop:12 }}>
        {[["Today",TODAY],["Yesterday",addDays(TODAY,-1)],["Last Sat",lastSat]].map(([lbl,date])=>(
          <button key={lbl} onClick={()=>{ onSelect(date); onClose(); }}
            style={{ flex:1, background:"rgba(255,255,255,0.04)",
              border:"1px solid rgba(255,255,255,0.07)",
              color:"#888", borderRadius:7, padding:"5px 0",
              cursor:"pointer", fontSize:10, fontWeight:600 }}>{lbl}</button>
        ))}
      </div>
    </div>
  );
}

// ─── Date strip ───────────────────────────────────────────────────────────────
function DateNav({ date, onDate, validDates }) {
  const [calOpen, setCalOpen]=useState(false);
  const ref=useRef();
  const strip=Array.from({length:9},(_,i)=>addDays(date,i-4));

  useEffect(()=>{
    const h=e=>{ if(ref.current&&!ref.current.contains(e.target)) setCalOpen(false); };
    document.addEventListener("mousedown",h);
    return ()=>document.removeEventListener("mousedown",h);
  },[]);

  return (
    <div style={{ display:"flex", alignItems:"center", gap:6, padding:"10px 20px",
      borderBottom:"1px solid rgba(255,255,255,0.05)", background:"rgba(6,6,15,0.5)" }}>

      <button onClick={()=>onDate(addDays(date,-1))}
        style={{ background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)",
          color:"#777", borderRadius:7, width:30, height:30, cursor:"pointer",
          fontSize:17, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>‹</button>

      <div style={{ display:"flex", gap:3, flex:1, overflowX:"auto", scrollbarWidth:"none" }}>
        {strip.map((d,i)=>{
          const sel=sameDay(d,date), tod=sameDay(d,TODAY), past=d<TODAY;
          return (
            <button key={i} onClick={()=>onDate(d)}
              style={{ flexShrink:0, minWidth:50,
                background: sel?"#e81020":"rgba(255,255,255,0.03)",
                border: tod&&!sel?"1px solid rgba(232,16,32,0.45)":"1px solid rgba(255,255,255,0.05)",
                borderRadius:9, padding:"5px 10px", cursor:"pointer",
                display:"flex", flexDirection:"column", alignItems:"center", gap:1,
                transition:"all 0.12s" }}>
              <span style={{ fontSize:9, letterSpacing:0.5, fontWeight:600,
                color: sel?"rgba(255,255,255,0.65)":tod?"#e81020":"#444" }}>
                {d.toLocaleDateString("en-US",{weekday:"short"}).toUpperCase()}
              </span>
              <span style={{ fontSize:14, fontWeight:700,
                color: sel?"#fff":past?"#777":"#ccc" }}>{d.getDate()}</span>
              {tod&&!sel&&<div style={{ width:3,height:3,borderRadius:"50%",background:"#e81020" }}/>}
            </button>
          );
        })}
      </div>

      <button onClick={()=>onDate(addDays(date,1))}
        style={{ background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)",
          color:"#777", borderRadius:7, width:30, height:30, cursor:"pointer",
          fontSize:17, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>›</button>

      <div ref={ref} style={{ position:"relative", flexShrink:0 }}>
        <button onClick={()=>setCalOpen(o=>!o)}
          style={{ background:calOpen?"rgba(232,16,32,0.18)":"rgba(255,255,255,0.04)",
            border:`1px solid ${calOpen?"rgba(232,16,32,0.45)":"rgba(255,255,255,0.07)"}`,
            color:calOpen?"#e88":"#888",
            borderRadius:7, height:30, padding:"0 11px", cursor:"pointer",
            fontSize:12, fontWeight:600, display:"flex", alignItems:"center", gap:5 }}>
          📅 <span style={{ color:"#bbb" }}>{date.toLocaleDateString("en-US",{month:"short",day:"numeric"})}</span>
        </button>
        {calOpen&&(
          <CalendarPicker selected={date} onSelect={onDate}
            onClose={()=>setCalOpen(false)} validDates={validDates} />
        )}
      </div>
    </div>
  );
}

// ─── Game card ────────────────────────────────────────────────────────────────
function GameCard({ game, onSelect, isSelected }) {
  const played = game.status==="final"||game.status==="inprogress";
  const buckets = buildBuckets(game.keyEvents);
  const score   = excScore(buckets);

  const statusColor = game.status==="inprogress"?"#00ff88":game.status==="final"?"#a0a0a0":"#4488ff";
  const statusLabel = game.status==="inprogress"
    ? `● ${game.liveMinute||"LIVE"}`
    : game.status==="final" ? "FT"
    : fmtTime(game.startTime);

  return (
    <div onClick={()=>onSelect(game)}
      style={{ background:isSelected?"rgba(255,255,255,0.07)":"rgba(255,255,255,0.025)",
        border:`1px solid ${isSelected?"rgba(255,255,255,0.22)":"rgba(255,255,255,0.06)"}`,
        borderRadius:13, padding:"13px 15px", cursor:"pointer", transition:"all 0.18s" }}>

      {/* Status row */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:9 }}>
        <span style={{ fontSize:10, color:statusColor, fontWeight:700, letterSpacing:0.8 }}>{statusLabel}</span>
        {played && (
          <span style={{ fontSize:9, fontWeight:800, borderRadius:99, padding:"2px 7px",
            background:"rgba(255,255,255,0.05)",
            color: score>60?"#e81020":score>35?"#f0a500":"#2d8a5f" }}>
            {actionLabel(score)}
          </span>
        )}
      </div>

      {/* Teams row */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:9, gap:6 }}>
        <div style={{ display:"flex", alignItems:"center", gap:7, flex:1, minWidth:0 }}>
          {game.homeLogo&&<img src={game.homeLogo} alt="" width={20} height={20}
            style={{ flexShrink:0, objectFit:"contain" }}/>}
          <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:16, fontWeight:700,
            color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {game.homeTeam}
          </span>
        </div>
        <span style={{ fontSize:10, color:"#333", flexShrink:0 }}>vs</span>
        <div style={{ display:"flex", alignItems:"center", gap:7, flex:1, minWidth:0, justifyContent:"flex-end" }}>
          <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:16, fontWeight:700,
            color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textAlign:"right" }}>
            {game.awayTeam}
          </span>
          {game.awayLogo&&<img src={game.awayLogo} alt="" width={20} height={20}
            style={{ flexShrink:0, objectFit:"contain" }}/>}
        </div>
      </div>

      {/* Heat map or kickoff info */}
      {played ? (
        game.keyEvents.length===0 ? (
          <div style={{ height:22, background:"rgba(255,255,255,0.03)", borderRadius:5,
            display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ fontSize:9, color:"#333" }}>No event data available</span>
          </div>
        ) : (
          <>
            <HeatStrip buckets={buckets} compact />
            <ExcBar score={score} />
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:2 }}>
              <span style={{ fontSize:8, color:"#222" }}>1′</span>
              <span style={{ fontSize:8, color:"#222" }}>45′</span>
              <span style={{ fontSize:8, color:"#222" }}>90′</span>
            </div>
          </>
        )
      ) : (
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          {game.venue&&(
            <span style={{ fontSize:10, color:"#333", flex:1,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              📍 {game.venue}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────
function DetailPanel({ game, onClose }) {
  const buckets = buildBuckets(game.keyEvents);
  const events  = [...game.keyEvents].sort((a,b)=>a.time-b.time);
  const icon    = { score_change:"⚽", yellow_card:"🟨", red_card:"🟥", substitution:"🔄" };

  return (
    <div style={{ position:"fixed", top:0, right:0, bottom:0, width:330,
      background:"#07070f", borderLeft:"1px solid rgba(255,255,255,0.07)",
      zIndex:100, overflowY:"auto", padding:22,
      boxShadow:"-16px 0 50px rgba(0,0,0,0.9)" }}>

      <button onClick={onClose}
        style={{ background:"none", border:"1px solid rgba(255,255,255,0.1)",
          color:"#888", borderRadius:7, padding:"5px 13px",
          cursor:"pointer", marginBottom:18, fontSize:12 }}>← Back</button>

      {/* Team logos + names */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
        {game.homeLogo&&<img src={game.homeLogo} alt="" width={32} height={32} style={{ objectFit:"contain" }}/>}
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, fontWeight:800, color:"#fff", lineHeight:1.1 }}>
          {game.homeTeam}
        </div>
      </div>
      <div style={{ color:"#2a2a3a", fontSize:11, margin:"3px 0 3px 42px" }}>vs</div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
        {game.awayLogo&&<img src={game.awayLogo} alt="" width={32} height={32} style={{ objectFit:"contain" }}/>}
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, fontWeight:800, color:"#fff", lineHeight:1.1 }}>
          {game.awayTeam}
        </div>
      </div>

      <div style={{ fontSize:10, color:"#2a2a3a", marginBottom:18 }}>
        {fmtShort(fromDateStr(game.date))} · {game.league}
        {game.venue&&<span> · {game.venue}</span>}
      </div>

      {/* Heat map */}
      <div style={{ marginBottom:18 }}>
        <div style={{ fontSize:9, color:"#2a2a3a", letterSpacing:2, marginBottom:7 }}>MATCH HEAT MAP — 90 MINUTES</div>
        <HeatStrip buckets={buckets} />
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:3 }}>
          <span style={{ fontSize:8, color:"#1a1a2a" }}>1′</span>
          <span style={{ fontSize:8, color:"#1a1a2a" }}>45′</span>
          <span style={{ fontSize:8, color:"#1a1a2a" }}>90′</span>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display:"flex", gap:5, marginBottom:18, flexWrap:"wrap" }}>
        {[["#1a5c1a","Low"],["#7a8c00","Moderate"],["#c47000","High"],["#e81020","🔥 Intense"]].map(([c,l])=>(
          <div key={l} style={{ display:"flex", alignItems:"center", gap:3, fontSize:9, color:"#555" }}>
            <div style={{ width:7,height:7,borderRadius:1,background:c }}/>{l}
          </div>
        ))}
      </div>

      {/* Event feed */}
      <div style={{ fontSize:9, color:"#2a2a3a", letterSpacing:2, marginBottom:9 }}>ACTION FEED</div>
      <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
        {events.length===0&&(
          <div style={{ color:"#2a2a3a", fontSize:12 }}>No event data from ESPN for this match.</div>
        )}
        {events.map((ev,i)=>(
          <div key={i} style={{ display:"flex", alignItems:"center", gap:9,
            background:"rgba(255,255,255,0.03)", borderRadius:7, padding:"7px 11px" }}>
            <span style={{ fontSize:15 }}>{icon[ev.type]||"•"}</span>
            <div>
              <div style={{ fontSize:11, color:"#e8e8e8", fontWeight:600 }}>
                {ev.type.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())}
              </div>
              <div style={{ fontSize:9, color:"#a0a0a0" }}>
                {ev.time}′
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main app ─────────────────────────────────────────────────────────────────
export default function App() {
  const [league,   setLeague]   = useState("eng.1");
  const [date,     setDate]     = useState(TODAY);
  const [games,    setGames]    = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [selected, setSelected] = useState(null);
  const [filter,   setFilter]   = useState("all");
  // calendar dates from ESPN (days that have fixtures for this league/season)
  const [validDates, setValidDates] = useState([]);

  // Fetch scoreboard for a specific date from ESPN (no proxy, no key needed)
  const fetchGames = useCallback(async (leagueId, d) => {
    setLoading(true); setError(null); setGames([]); setSelected(null);
    const espnDate = toESPN(d);
    try {
      const res = await fetch(
        `${ESPN}/${leagueId}/scoreboard?dates=${espnDate}&lang=en&region=us`
      );
      if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
      const data = await res.json();

      // Also grab the league calendar for date hints
      if (data.leagues?.[0]?.calendar) {
        setValidDates(
          data.leagues[0].calendar.map(iso => iso.slice(0,10))
        );
      }

      setGames(parseScoreboard(data, leagueId));
    } catch(e) {
      setError(e.message);
      setGames([]);
    }
    setLoading(false);
  }, []);

  useEffect(()=>{ fetchGames(league, date); }, [league, date]);

  const filtered = games.filter(g => {
    if (filter==="played")   return g.status==="final"||g.status==="inprogress";
    if (filter==="upcoming") return g.status==="scheduled";
    return true;
  });

  const leagueLabel = LEAGUES.find(l=>l.id===league)?.label;
  const dateLabel   = sameDay(date,TODAY)?"Today":sameDay(date,addDays(TODAY,-1))?"Yesterday":fmtShort(date);

  return (
    <div style={{ minHeight:"100vh", background:"#06060f", color:"#fff", fontFamily:"'DM Sans',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=DM+Sans:wght@300;400;500;600&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:#06060f; }
        ::-webkit-scrollbar-thumb { background:#1a1a2e; border-radius:2px; }
        @keyframes pulse { 0%,100%{opacity:0.25} 50%{opacity:0.7} }
        button:hover:not(:disabled) { opacity:0.82; }
      `}</style>

      {/* ── Sticky header ── */}
      <div style={{ position:"sticky", top:0, zIndex:50,
        background:"rgba(6,6,15,0.97)", backdropFilter:"blur(14px)",
        borderBottom:"1px solid rgba(255,255,255,0.05)" }}>

        <div style={{ padding:"16px 20px 0", display:"flex", alignItems:"flex-end" }}>
          {/* Logo */}
          <div style={{ display:"flex", alignItems:"center", gap:9, marginRight:24, paddingBottom:10 }}>
            <div style={{ width:28, height:28, borderRadius:7,
              background:"linear-gradient(135deg,#e81020,#ff5020)",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:14 }}>📺</div>
            <div>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:19, fontWeight:800, letterSpacing:1.5 }}>
                PREMIER HEAT
              </div>
              <div style={{ fontSize:8, color:"#2a2a3a", letterSpacing:2 }}>FIND THE GAMES WORTH WATCHING</div>
            </div>
          </div>
          {/* League tabs */}
          <div style={{ display:"flex", gap:0, overflowX:"auto", flex:1 }}>
            {LEAGUES.map(l=>(
              <button key={l.id} onClick={()=>setLeague(l.id)}
                style={{ background:"transparent", border:"none",
                  borderBottom: league===l.id?"2px solid #e81020":"2px solid transparent",
                  color: league===l.id?"#fff":"#a0a0a0",
                  padding:"7px 13px 9px", cursor:"pointer",
                  fontSize:12, fontWeight:600, whiteSpace:"nowrap", transition:"all 0.12s" }}>
                {l.flag} {l.label}
              </button>
            ))}
          </div>
        </div>

        <DateNav date={date} onDate={setDate} validDates={validDates} />
      </div>

      {/* ── Content ── */}
      <div style={{ display:"flex" }}>
        <div style={{ flex:1, padding:18, maxWidth:selected?"calc(100% - 330px)":"100%" }}>

          {/* Toolbar */}
          <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:16, flexWrap:"wrap" }}>
            <div style={{ fontSize:12, fontWeight:600, color:"#555" }}>
              <span style={{ color:"#888" }}>{dateLabel}</span>
              {" · "}
              <span style={{ color:"#a0a0a0" }}>{leagueLabel}</span>
              {!loading&&games.length>0&&(
                <span style={{ color:"#a0a0a0" }}> · {games.length} match{games.length!==1?"es":""}</span>
              )}
            </div>
            <div style={{ flex:1 }}/>
            {[["all","All"],["played","Played"],["upcoming","Upcoming"]].map(([v,l])=>(
              <button key={v} onClick={()=>setFilter(v)}
                style={{ background:filter===v?"rgba(255,255,255,0.08)":"transparent",
                  border:`1px solid ${filter===v?"rgba(255,255,255,0.15)":"rgba(255,255,255,0.05)"}`,
                  color:filter===v?"#fff":"#444",
                  borderRadius:99, padding:"4px 13px",
                  cursor:"pointer", fontSize:11, fontWeight:600 }}>{l}</button>
            ))}
            <div style={{ display:"flex", gap:5 }}>
              {[["#e81020","Goals/Cards"],["#7a8c00","Action"],["#0d0d1c","Quiet"]].map(([c,l])=>(
                <div key={l} style={{ display:"flex", alignItems:"center", gap:3, fontSize:9, color:"#333" }}>
                  <div style={{ width:7,height:7,borderRadius:1,background:c,
                    border:"1px solid rgba(255,255,255,0.08)" }}/>{l}
                </div>
              ))}
            </div>
          </div>

          {/* States */}
          {loading ? (
            <div style={{ textAlign:"center", padding:"56px 0", color:"#282835" }}>
              <div style={{ fontSize:34, marginBottom:12, animation:"pulse 1.4s infinite" }}>⚽</div>
              <div style={{ fontSize:12 }}>Fetching {leagueLabel} fixtures for {dateLabel}…</div>
            </div>
          ) : error ? (
            <div style={{ textAlign:"center", padding:"56px 0" }}>
              <div style={{ fontSize:34, marginBottom:12 }}>⚠️</div>
              <div style={{ color:"#a0a0a0", fontSize:13 }}>ESPN API error: {error}</div>
              <button onClick={()=>fetchGames(league,date)}
                style={{ marginTop:14, background:"rgba(255,255,255,0.06)",
                  border:"1px solid rgba(255,255,255,0.1)", color:"#aaa",
                  borderRadius:8, padding:"7px 18px", cursor:"pointer", fontSize:12 }}>
                Retry
              </button>
            </div>
          ) : filtered.length===0 ? (
            <div style={{ textAlign:"center", padding:"56px 0" }}>
              <div style={{ fontSize:34, marginBottom:12 }}>📋</div>
              <div style={{ color:"#333", fontSize:13 }}>
                {games.length===0
                  ? `No ${leagueLabel} matches on ${fmtShort(date)}`
                  : "No matches match this filter"}
              </div>
              {games.length===0&&(
                <div style={{ color:"#252535", fontSize:11, marginTop:6 }}>
                  Try a different date or league
                </div>
              )}
            </div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(290px,1fr))", gap:10 }}>
              {filtered.map(g=>(
                <GameCard key={g.id} game={g}
                  onSelect={game=>setSelected(game)}
                  isSelected={selected?.id===g.id} />
              ))}
            </div>
          )}

          {/* Footer tip */}
          {!loading&&!error&&(
            <div style={{ marginTop:24, padding:14, borderRadius:9,
              background:"rgba(255,255,255,0.012)", border:"1px solid rgba(255,255,255,0.03)",
              display:"flex", gap:9, alignItems:"flex-start" }}>
              <span style={{ fontSize:16, flexShrink:0 }}>💡</span>
              <div style={{ fontSize:11, color:"#a0a0a0", lineHeight:1.7 }}>
                Heat maps show real event data from ESPN — goal minutes, cards & substitution times.{" "}
                <strong style={{ color:"#a0a0a0" }}>No scores are ever shown.</strong>{" "}
                Click any finished match to see the full minute-by-minute breakdown.
              </div>
            </div>
          )}
        </div>

        {selected&&(
          <DetailPanel game={selected} onClose={()=>setSelected(null)} />
        )}
      </div>
    </div>
  );
}