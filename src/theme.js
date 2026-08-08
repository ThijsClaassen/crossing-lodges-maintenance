export const T = {
  bg:"#1E1D2B",
  panel:"#28273A",
  border:"#3A3850",
  navy:"#3C3B5A",
  navyLt:"#4E4D72",
  gold:"#B8935A",
  goldLt:"#D4AF7A",
  cream:"#F0EDE6",
  muted:"#8A8899",
  danger:"#C05858",
  ok:"#5A9B72",
  warn:"#C8973A",
};


// CSS is injected by the build script — T and LOC_COLORS are defined before this block
export const css = `
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&family=Space+Mono&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:${T.bg};color:${T.cream};font-family:'Inter',sans-serif;min-height:100vh;-webkit-tap-highlight-color:transparent}
  .mono{font-family:'Space Mono',monospace}
  .shell{display:flex;height:100vh;overflow:hidden}
  .sidebar{width:230px;background:${T.panel};border-right:1px solid ${T.border};display:flex;flex-direction:column;flex-shrink:0}
  .main{flex:1;overflow-y:auto;background:${T.bg}}
  .bottom-nav{display:none}
  .logo{padding:18px 18px 12px;border-bottom:1px solid ${T.border};display:flex;flex-direction:column;align-items:center;gap:7px}
  .logo img{width:136px;height:auto;filter:brightness(0) invert(1) opacity(.9)}
  .logo-sub{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:${T.gold};font-weight:600;text-align:center}
  .loc-switcher{padding:10px 12px;border-bottom:1px solid ${T.border};display:flex;flex-direction:column;gap:3px}
  .loc-label{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:${T.muted};font-weight:600;margin-bottom:4px;padding-left:2px}
  .loc-btn{padding:7px 10px;border-radius:6px;border:1px solid transparent;font-family:'Inter',sans-serif;font-size:12px;font-weight:500;cursor:pointer;text-align:left;transition:all .15s;background:transparent;color:${T.muted};display:flex;align-items:center;gap:7px}
  .loc-btn:hover{color:${T.cream};background:rgba(255,255,255,.04)}
  .loc-btn.active-ZC{background:rgba(184,147,90,.15);border-color:rgba(184,147,90,.45);color:#B8935A}
  .loc-btn.active-EC{background:rgba(91,140,196,.15);border-color:rgba(91,140,196,.45);color:#5B8CC4}
  .loc-btn.active-SC{background:rgba(107,140,110,.15);border-color:rgba(107,140,110,.45);color:#7BAE7F}
  .loc-dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .nav{flex:1;padding:6px 0;overflow-y:auto}
  .nav-section{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:${T.muted};padding:10px 16px 3px;font-weight:600;opacity:.7}
  .nav-item{display:flex;align-items:center;padding:8px 16px;cursor:pointer;font-size:13px;font-weight:500;color:${T.muted};transition:all .15s;border:none;background:none;width:100%;text-align:left}
  .nav-item:hover{color:${T.cream};background:rgba(184,147,90,.06)}
  .nav-item.active{color:${T.gold};background:rgba(184,147,90,.12);border-right:2px solid ${T.gold};font-weight:600}
  .topbar{background:${T.panel};border-bottom:1px solid ${T.border};padding:13px 26px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;gap:12px}
  .page-title{font-size:19px;font-weight:600;color:${T.cream};font-family:'Cormorant Garamond',serif;letter-spacing:.02em}
  .loc-badge{font-size:11px;font-weight:600;padding:4px 10px;border-radius:4px;letter-spacing:.04em;white-space:nowrap;cursor:pointer;border:none;display:flex;align-items:center;gap:5px;font-family:'Inter',sans-serif}
  .month-badge{background:rgba(184,147,90,.18);border:1px solid rgba(184,147,90,.45);color:${T.gold};font-size:11px;font-weight:600;padding:4px 12px;border-radius:4px;letter-spacing:.06em}
  .kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:20px 26px 0}
  .kpi{background:${T.panel};border:1px solid ${T.border};border-radius:8px;padding:14px 16px;position:relative;overflow:hidden}
  .kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--accent,${T.gold})}
  .kpi-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:${T.muted};font-weight:600;margin-bottom:5px}
  .kpi-value{font-size:21px;font-weight:700;color:${T.cream};font-family:'Space Mono',monospace}
  .kpi-sub{font-size:11px;color:${T.muted};margin-top:2px}
  .section{padding:20px 26px}
  .section-title{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${T.gold};margin-bottom:10px;opacity:.9}
  .tbl-wrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .tbl{width:100%;border-collapse:collapse;font-size:13px;min-width:500px}
  .tbl th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:${T.muted};font-weight:600;padding:7px 10px;border-bottom:1px solid ${T.border};white-space:nowrap}
  .tbl td{padding:8px 10px;border-bottom:1px solid rgba(58,56,80,.5);color:${T.cream};vertical-align:middle}
  .tbl tr:hover td{background:rgba(184,147,90,.04)}
  .tbl .num{font-family:'Space Mono',monospace;text-align:right}
  .ok{color:${T.ok}} .bad{color:${T.danger}} .warn{color:${T.warn}}
  .badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;letter-spacing:.04em}
  .badge-ok{background:rgba(90,155,114,.18);color:${T.ok};border:1px solid rgba(90,155,114,.3)}
  .badge-warn{background:rgba(200,151,58,.18);color:${T.warn};border:1px solid rgba(200,151,58,.3)}
  .badge-bad{background:rgba(192,88,88,.18);color:${T.danger};border:1px solid rgba(192,88,88,.3)}
  .badge-neu{background:rgba(138,136,153,.15);color:${T.muted};border:1px solid rgba(138,136,153,.3)}
  .tabs{display:flex;border-bottom:1px solid ${T.border};margin-bottom:16px;overflow-x:auto}
  .tab{padding:8px 16px;font-size:12px;font-weight:600;cursor:pointer;border:none;background:none;color:${T.muted};border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;flex-shrink:0}
  .tab.active{color:${T.gold};border-bottom-color:${T.gold}}
  .tab:hover:not(.active){color:${T.cream}}
  .field{margin-bottom:12px}
  .field label{display:block;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:${T.muted};font-weight:600;margin-bottom:4px}
  .field input,.field select,.field textarea{width:100%;background:rgba(0,0,0,.25);border:1px solid ${T.border};border-radius:6px;padding:10px 11px;color:${T.cream};font-family:'Inter',sans-serif;font-size:16px;outline:none;transition:border .15s}
  .field input:focus,.field select:focus,.field textarea:focus{border-color:${T.gold}}
  .field select option{background:${T.panel}}
  .field textarea{resize:vertical;font-size:14px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:9px 15px;border-radius:6px;font-family:'Inter',sans-serif;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
  .btn-primary{background:${T.navy};color:${T.cream};border:1px solid ${T.navyLt}}
  .btn-primary:hover{background:${T.navyLt}}
  .btn-ghost{background:transparent;color:${T.muted};border:1px solid ${T.border}}
  .btn-ghost:hover{color:${T.cream};border-color:${T.muted}}
  .btn-danger{background:rgba(192,88,88,.15);color:${T.danger};border:1px solid rgba(192,88,88,.35)}
  .btn-sm{padding:4px 9px;font-size:11px}
  .overlay{position:fixed;inset:0;background:rgba(10,9,20,.85);z-index:200;display:flex;align-items:flex-end;justify-content:center;padding:0}
  .modal{background:${T.panel};border:1px solid ${T.border};border-radius:16px 16px 0 0;width:100%;max-width:560px;padding:22px 20px 36px;max-height:92vh;overflow-y:auto}
  .modal-title{font-size:18px;font-weight:600;color:${T.cream};margin-bottom:16px;display:flex;align-items:center;gap:8px;font-family:'Cormorant Garamond',serif}
  .modal-title span{color:${T.gold}}
  .strip{background:rgba(184,147,90,.06);border:1px solid rgba(184,147,90,.2);border-radius:8px;padding:11px 14px;display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
  .strip-item{text-align:center;min-width:75px}
  .strip-label{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${T.muted};font-weight:600}
  .strip-val{font-size:16px;font-weight:700;color:${T.gold};font-family:'Space Mono',monospace;margin-top:1px}
  .info-box{background:rgba(184,147,90,.08);border:1px solid rgba(184,147,90,.25);border-radius:6px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:11px}
  .empty{padding:32px;text-align:center;color:${T.muted};font-size:13px}
  .count-input{width:90px;background:rgba(0,0,0,.3);border:1px solid ${T.border};border-radius:6px;padding:7px 10px;color:${T.cream};font-family:'Space Mono',monospace;font-size:14px;text-align:right;outline:none;transition:border .15s}
  .count-input:focus{border-color:${T.gold}}
  .reorder-qty{display:inline-block;background:rgba(192,88,88,.18);color:${T.danger};border:1px solid rgba(192,88,88,.3);border-radius:4px;font-family:'Space Mono',monospace;font-size:12px;font-weight:700;padding:2px 10px}
  .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:8px}
  .cal-head{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${T.muted};font-weight:600;text-align:center;padding:5px 0}
  .cal-cell{background:${T.panel};border:1px solid ${T.border};border-radius:6px;min-height:88px;padding:5px 4px;display:flex;flex-direction:column;gap:3px}
  .cal-empty{background:transparent;border-color:transparent}
  .cal-today{border-color:${T.gold};box-shadow:0 0 0 1px rgba(184,147,90,.3)}
  .cal-drop-target{border-color:${T.ok};background:rgba(90,155,114,.1);box-shadow:0 0 0 1px rgba(90,155,114,.4)}
  .cal-job[draggable="true"]:active{opacity:.6}
  .cal-date{font-family:'Space Mono',monospace;font-size:11px;color:${T.muted};padding-left:3px}
  .cal-today .cal-date{color:${T.gold};font-weight:700}
  .cal-job{background:rgba(0,0,0,.28);border:none;border-radius:3px;padding:3px 5px;font-family:'Inter',sans-serif;font-size:10px;font-weight:500;text-align:left;cursor:pointer;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%}
  .cal-job:hover{background:rgba(184,147,90,.15)}
  .mobile-loc-bar{display:none}
  @media (max-width:768px){
    .sidebar{display:none}
    .bottom-nav{display:flex;position:fixed;bottom:0;left:0;right:0;background:${T.panel};border-top:1px solid ${T.border};z-index:100;padding-bottom:env(safe-area-inset-bottom)}
    .bn-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:7px 2px;border:none;background:none;color:${T.muted};font-family:'Inter',sans-serif;font-size:9px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;min-height:54px}
    .bn-item.active{color:${T.gold}}
    .main{padding-bottom:70px}
    .topbar{padding:9px 14px}
    .page-title{font-size:15px}
    .month-badge,.loc-badge{font-size:10px;padding:3px 8px}
    .mobile-loc-bar{display:flex;gap:5px;padding:7px 12px;background:${T.panel};border-bottom:1px solid ${T.border};overflow-x:auto;-webkit-overflow-scrolling:touch}
    .mobile-loc-btn{flex-shrink:0;padding:5px 11px;border-radius:20px;border:1px solid transparent;font-family:'Inter',sans-serif;font-size:11px;font-weight:600;cursor:pointer;background:transparent;color:${T.muted};display:flex;align-items:center;gap:5px;white-space:nowrap}
    .mobile-loc-btn.active-ZC{background:rgba(184,147,90,.18);border-color:rgba(184,147,90,.5);color:#B8935A}
    .mobile-loc-btn.active-EC{background:rgba(91,140,196,.18);border-color:rgba(91,140,196,.5);color:#5B8CC4}
    .mobile-loc-btn.active-SC{background:rgba(107,140,110,.18);border-color:rgba(107,140,110,.5);color:#7BAE7F}
    .section{padding:12px 14px}
    .kpi-row{grid-template-columns:1fr 1fr;gap:9px;padding:12px 14px 0}
    .kpi-value{font-size:17px}
    .grid2,.grid3{grid-template-columns:1fr}
    .count-input{width:75px}
    .cal-cell{min-height:62px;padding:3px 2px}
    .cal-job{font-size:8px;padding:2px 3px}
    .cal-grid{gap:2px}
  }
  @media (min-width:769px){.mobile-loc-bar{display:none!important}}
  ::-webkit-scrollbar{width:4px;height:4px}
  ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px}
`;
