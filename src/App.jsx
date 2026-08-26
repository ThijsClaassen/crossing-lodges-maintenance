import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { sb, LOCATIONS, LOC_COLORS } from "./sb.js";
import { supabase } from "./supabaseClient.js";
import { T, css } from "./theme.js";
import { LOGO_DATA } from "./logo.js";
import Login from "./Login.jsx";
import SetPassword from "./SetPassword.jsx";
import { CompanyProvider, useCompany } from "./CompanyContext.jsx";
import { uploadPurchaseSlip, getSlipUrl } from "./slipUpload.js";
import { availableMaintenanceStaff, normalizeDepartment } from "./maintenanceStaffEngine.js";
import { listMembers as listBillingMembers, logMemberPurchase, listPendingCharges, addPendingCharges, billPendingCharges, deletePendingCharge } from "./memberPurchase.js";

const fmtR  = n=>`R ${Number(n||0).toLocaleString("en-ZA",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtN  = n=>Number(n||0).toLocaleString("en-ZA",{maximumFractionDigits:3});
const uid   = ()=>crypto.randomUUID();
const toISO   = d=>{ if(!d)return""; const[dd,mm,yyyy]=d.split("/"); return `${yyyy}-${mm}-${dd}`; };
const fromISO = d=>{ if(!d)return""; const[yyyy,mm,dd]=d.split("-"); return `${dd}/${mm}/${yyyy}`; };
const today = ()=>{ const d=new Date(); return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`; };

// Supplier Credit Notes (2026-08-25) — when the wrong item was bought and
// has to go back to the supplier. Reasons match the shared
// supplier_credit_notes table's check constraint (see
// add_supplier_credit_notes.sql) — keep in sync across all 5 apps.
const CREDIT_REASONS = [
  { value: "wrong_item", label: "Wrong item" },
  { value: "damaged", label: "Damaged" },
  { value: "short_delivery", label: "Short delivery" },
  { value: "overcharged", label: "Overcharged" },
  { value: "duplicate", label: "Duplicate" },
  { value: "other", label: "Other" },
];

// ─── SLIP SCANNING HELPERS ───────────────────────────────────────────────────
// Shared by the Purchases tab's "Scan slip" flow (2026-08-12) — resize a
// photo before it's sent anywhere (keeps it well under the serverless body
// limit and speeds up the AI read), fuzzy-match the OCR'd line text against
// the item list so confident matches can be pre-filled, and apply/re-apply
// VAT the same transparent way Food/Beverage's slip scanner does.
async function resizeImageFile(file, maxDim=1800, quality=0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim/Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width*scale), h = Math.round(bitmap.height*scale);
  const canvas = document.createElement("canvas");
  canvas.width=w; canvas.height=h;
  canvas.getContext("2d").drawImage(bitmap,0,0,w,h);
  return new Promise(resolve=>canvas.toBlob(blob=>resolve(blob),"image/jpeg",quality));
}
function blobToBase64(blob) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");
    reader.onerror=reject;
    reader.readAsDataURL(blob);
  });
}
function normalizeForMatch(s){ return (s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function matchScore(a,b){
  const na=normalizeForMatch(a), nb=normalizeForMatch(b);
  if(!na||!nb)return 0;
  if(na===nb)return 1;
  const ta=na.split(" ").filter(Boolean), tb=nb.split(" ").filter(Boolean);
  const setB=new Set(tb);
  let overlap=0; for(const t of ta) if(setB.has(t)) overlap++;
  const overlapScore=overlap/Math.max(ta.length,tb.length);
  const bonus=(na.includes(nb)||nb.includes(na))?0.2:0;
  return Math.min(1, overlapScore+bonus);
}
const MATCH_CONFIDENT=0.55;
function findBestItemMatch(text, items){
  let best=null, bestScore=0;
  for(const it of items){ const s=matchScore(text,it.description); if(s>bestScore){bestScore=s;best=it;} }
  return {match:best, score:bestScore, confident:bestScore>=MATCH_CONFIDENT};
}
function round2(n){ return Math.round((Number(n)||0)*100)/100; }
function applyVatToRows(rows, incl, vatRate){
  const divisor = incl ? 1+(Number(vatRate)||0)/100 : 1;
  return rows.map(r=>({...r, total_cost: round2(r.raw_total/divisor)}));
}
// Member purchases are never VAT-stripped — the VAT-INCLUSIVE amount as
// printed on the slip is what gets forwarded to the member's account,
// unlike total_cost above which strips VAT for this app's own costing.
function vatInclusiveAmount(row, incl, vatRate){
  const multiplier = incl ? 1 : 1+(Number(vatRate)||0)/100;
  return round2(row.raw_total*multiplier);
}

// ─── AUTH ────────────────────────────────────────────────────────────────────
// Real Supabase Auth replaces the old shared staff/admin password checked
// against app_access (2026-08-08 — Maintenance 3b of the multi-tenant
// rebuild). app_access is deliberately left in the schema, unused by this
// app from here on — it's a shared table other apps may still read.
//
// Supabase's invite/recovery links land back here with a #type=invite or
// #type=recovery hash fragment when someone lands back in the app from an
// email link — read once, synchronously, on first render, before
// supabase-js has a chance to process and clear it.
function getAuthHashType() {
  if (typeof window === "undefined" || !window.location.hash) return null;
  return new URLSearchParams(window.location.hash.slice(1)).get("type");
}

function AuthMessageScreen({ children }) {
  return (<><style>{css}</style>
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",background:T.bg,padding:24,textAlign:"center"}}>
      <img src={LOGO_DATA} alt="Crossing Lodges" style={{width:150,filter:"brightness(0) invert(1) opacity(.8)",marginBottom:16}}/>
      <div style={{maxWidth:320}}>{children}</div>
    </div>
  </>);
}

function DateField({ value, onChange }) {
  return <input type="date" value={toISO(value)} onChange={e=>onChange(fromISO(e.target.value))}
    style={{width:"100%",background:"rgba(0,0,0,.25)",border:`1px solid ${T.border}`,borderRadius:6,
      padding:"10px 11px",color:T.cream,fontFamily:"'Inter',sans-serif",fontSize:16,outline:"none",colorScheme:"dark"}}
    onFocus={e=>e.target.style.borderColor=T.gold} onBlur={e=>e.target.style.borderColor=T.border}/>;
}

function KPI({ label, value, sub, accent }) {
  return (
    <div className="kpi" style={{"--accent":accent||T.gold}}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub&&<div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function Dashboard({ items, purchases, issues, counts }) {
  const totalValue = items.reduce((s,i)=>s+(i.open_qty||0)*(i.open_cost||0),0);
  const issuedUnits = issues.reduce((s,i)=>s+(i.qty||0),0);
  const calcTheo = item => {
    const b=purchases.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
    const iss=issues.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
    return (item.open_qty||0)+b-iss;
  };
  const lowStock = items.filter(i=>i.min_units>0&&calcTheo(i)<=i.min_units).length;
  return (<>
    <div className="kpi-row">
      <KPI label="Stock Items"      value={items.length}       sub="Active items"          accent={T.gold}/>
      <KPI label="Opening Value"    value={fmtR(totalValue)}   sub="At weighted avg cost"  accent={T.ok}/>
      <KPI label="Units Issued"     value={fmtN(issuedUnits)}  sub="This month"            accent={T.muted}/>
      <KPI label="Low Stock Alerts" value={lowStock}            sub="At or below minimum"   accent={lowStock>0?T.danger:T.ok}/>
    </div>
    <div className="section">
      <div className="section-title">Stock Overview</div>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>Code</th><th>Description</th><th>Location</th>
          <th className="num">Open Qty</th><th className="num">Purchased</th>
          <th className="num">Issued</th><th className="num">Theoretical</th><th>Status</th></tr></thead>
        <tbody>
          {items.map(item=>{
            const bought=purchases.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
            const issued=issues.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
            const theo=calcTheo(item);
            const low=item.min_units>0&&theo<=item.min_units;
            const veryLow=item.min_units>0&&theo<item.min_units;
            return (<tr key={item.id}>
              <td className="mono" style={{fontSize:11,color:T.muted}}>{item.item_code||"—"}</td>
              <td style={{fontWeight:600}}>{item.description}</td>
              <td style={{fontSize:11,color:T.muted}}>{[item.storeroom,item.shelf,item.position].filter(Boolean).join(" / ")}</td>
              <td className="num">{fmtN(item.open_qty)} <span style={{fontSize:10,color:T.muted}}>{item.unit}</span></td>
              <td className="num" style={{color:bought>0?T.ok:T.muted}}>{bought>0?`+${fmtN(bought)}`:"—"}</td>
              <td className="num" style={{color:issued>0?T.warn:T.muted}}>{issued>0?`-${fmtN(issued)}`:"—"}</td>
              <td className="num" style={{fontWeight:700,color:veryLow?T.danger:low?T.warn:T.cream}}>{fmtN(theo)}</td>
              <td>{veryLow?<span className="badge badge-bad">Low</span>:low?<span className="badge badge-warn">Min</span>:<span className="badge badge-ok">OK</span>}</td>
            </tr>);
          })}
          {items.length===0&&<tr><td colSpan={8} className="empty">No items in this location yet</td></tr>}
        </tbody>
      </table></div>
    </div>
  </>);
}

// ─── STOCK ITEMS (Admin) ─────────────────────────────────────────────────────
function StockItems({ locId, items, setItems, companyId }) {
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [newCategory,setNewCategory]=useState(false);
  const blank={item_code:"",description:"",category:"",storeroom:"",shelf:"",position:"",unit:"ea",open_qty:"",open_cost:"",min_units:"",max_units:""};
  const [form,setForm]=useState(blank);
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));

  const categories = useMemo(()=>[...new Set(items.map(i=>i.category).filter(Boolean))].sort(),[items]);

  const openAdd=()=>{setForm(blank);setEditId(null);setNewCategory(categories.length===0);setShowForm(true);};
  const openEdit=i=>{
    setForm({...i,open_qty:String(i.open_qty),open_cost:String(i.open_cost),min_units:String(i.min_units),max_units:String(i.max_units)});
    setEditId(i.id);setNewCategory(!i.category || !categories.includes(i.category));setShowForm(true);
  };
  const save=async()=>{
    if(!form.description?.trim())return;
    const row={location_id:locId,item_code:form.item_code||null,description:form.description.trim(),
      category:form.category?.trim()||null,
      storeroom:form.storeroom||null,shelf:form.shelf||null,position:form.position||null,
      unit:form.unit||"ea",open_qty:parseFloat(form.open_qty)||0,open_cost:parseFloat(form.open_cost)||0,
      min_units:parseFloat(form.min_units)||0,max_units:parseFloat(form.max_units)||0,sort_order:items.length+1};
    try{
      if(editId){await sb.update("maint_items",editId,row);setItems(p=>p.map(i=>i.id===editId?{...i,...row}:i));}
      else{const ins=await sb.insert("maint_items",{...row,id:uid(),company_id:companyId});setItems(p=>[...p,{...row,id:ins.id,active:true}]);}
      setShowForm(false);
    }catch(e){alert("Save failed: "+e.message);}
  };
  const remove=async i=>{
    if(!window.confirm(`Remove ${i.description}?`))return;
    try{await sb.delete("maint_items",i.id);setItems(p=>p.filter(x=>x.id!==i.id));}
    catch(e){alert("Error: "+e.message);}
  };
  const totalVal=items.reduce((s,i)=>s+(i.open_qty||0)*(i.open_cost||0),0);

  const grouped = useMemo(()=>{
    const g={};
    items.forEach(i=>{ const c=i.category||"Uncategorised"; (g[c]||(g[c]=[])).push(i); });
    return Object.entries(g).sort((a,b)=>a[0].localeCompare(b[0]));
  },[items]);

  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Items</div><div className="strip-val">{items.length}</div></div>
      <div className="strip-item"><div className="strip-label">Categories</div><div className="strip-val">{categories.length}</div></div>
      <div className="strip-item"><div className="strip-label">Opening Value</div><div className="strip-val">{fmtR(totalVal)}</div></div>
      <div style={{marginLeft:"auto"}}><button className="btn btn-primary" onClick={openAdd}>+ Add Item</button></div>
    </div>
    {grouped.map(([cat,catItems])=>(
      <div key={cat} style={{marginBottom:22}}>
        <div className="section-title">{cat} <span style={{color:T.muted,fontWeight:400}}>({catItems.length})</span></div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Code</th><th>Description</th><th>Storeroom</th><th>Shelf</th><th>Position</th><th>Unit</th>
            <th className="num">Open Qty</th><th className="num">Open Cost</th><th className="num">Min</th><th className="num">Max</th><th></th></tr></thead>
          <tbody>
            {catItems.map(i=>(
              <tr key={i.id}>
                <td className="mono" style={{fontSize:11,color:T.muted}}>{i.item_code||"—"}</td>
                <td style={{fontWeight:600}}>{i.description}</td>
                <td style={{color:T.muted,fontSize:12}}>{i.storeroom||"—"}</td>
                <td style={{color:T.muted,fontSize:12}}>{i.shelf||"—"}</td>
                <td style={{color:T.muted,fontSize:12}}>{i.position||"—"}</td>
                <td><span className="badge badge-neu">{i.unit}</span></td>
                <td className="num">{fmtN(i.open_qty)}</td>
                <td className="num">{fmtR(i.open_cost)}</td>
                <td className="num" style={{color:T.muted}}>{i.min_units||"—"}</td>
                <td className="num" style={{color:T.muted}}>{i.max_units||"—"}</td>
                <td style={{display:"flex",gap:5}}>
                  <button className="btn btn-ghost btn-sm" onClick={()=>openEdit(i)}>Edit</button>
                  <button className="btn btn-danger btn-sm" onClick={()=>remove(i)}>x</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    ))}
    {items.length===0 && <div className="empty">No items for this location yet. Add one above.</div>}
    {showForm&&(
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowForm(false)}>
        <div className="modal">
          <div className="modal-title">{editId?"Edit":"Add"} <span>Stock Item</span></div>
          <div className="grid2">
            <div className="field"><label>Item Code (optional)</label>
              <input type="text" placeholder="e.g. MAINT-011" value={form.item_code||""} onChange={f("item_code")}/>
            </div>
            <div className="field"><label>Unit</label>
              <select value={form.unit||"ea"} onChange={f("unit")}>
                {["ea","mtr","kg","litre","set","box","pair","roll"].map(u=><option key={u}>{u}</option>)}
              </select>
            </div>
          </div>
          <div className="field"><label>Description</label><input type="text" value={form.description||""} onChange={f("description")}/></div>

          <div className="field"><label>Category</label>
            {newCategory || categories.length===0 ? (
              <div style={{display:"flex",gap:7}}>
                <input type="text" placeholder="e.g. Plumbing" value={form.category||""} onChange={f("category")} style={{flex:1}}/>
                {categories.length>0 && (
                  <button className="btn btn-ghost btn-sm" type="button" onClick={()=>{setNewCategory(false);setForm(p=>({...p,category:""}));}}>
                    Choose existing
                  </button>
                )}
              </div>
            ) : (
              <div style={{display:"flex",gap:7}}>
                <select value={form.category||""} onChange={f("category")} style={{flex:1}}>
                  <option value="">-- Select category --</option>
                  {categories.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
                <button className="btn btn-ghost btn-sm" type="button" onClick={()=>{setNewCategory(true);setForm(p=>({...p,category:""}));}}>
                  + New
                </button>
              </div>
            )}
          </div>

          <div className="grid3">
            <div className="field"><label>Storeroom</label><input type="text" value={form.storeroom||""} onChange={f("storeroom")}/></div>
            <div className="field"><label>Shelf</label><input type="text" value={form.shelf||""} onChange={f("shelf")}/></div>
            <div className="field"><label>Position</label><input type="text" value={form.position||""} onChange={f("position")}/></div>
          </div>
          <div className="grid2">
            <div className="field"><label>Opening Qty</label><input type="number" inputMode="decimal" value={form.open_qty||""} onChange={f("open_qty")}/></div>
            <div className="field"><label>Opening Cost / Unit (R)</label><input type="number" inputMode="decimal" step="0.01" value={form.open_cost||""} onChange={f("open_cost")}/></div>
            <div className="field"><label>Min Units (reorder trigger)</label><input type="number" inputMode="decimal" value={form.min_units||""} onChange={f("min_units")}/></div>
            <div className="field"><label>Max Units (target stock)</label><input type="number" inputMode="decimal" value={form.max_units||""} onChange={f("max_units")}/></div>
          </div>
          <div style={{display:"flex",gap:9}}>
            <button className="btn btn-primary" onClick={save}>{editId?"Save Changes":"Add Item"}</button>
            <button className="btn btn-ghost" onClick={()=>setShowForm(false)}>Cancel</button>
          </div>
        </div>
      </div>
    )}
  </>);
}

// ─── DESTINATIONS (Admin) ────────────────────────────────────────────────────
function Destinations({ locId, destinations, setDestinations, companyId }) {
  const locDests = destinations.filter(d=>d.location_id===locId).sort((a,b)=>a.sort_order-b.sort_order);
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [name,setName]=useState("");
  const openAdd=()=>{setName("");setEditId(null);setShowForm(true);};
  const openEdit=d=>{setName(d.name);setEditId(d.id);setShowForm(true);};
  const save=async()=>{
    if(!name.trim())return;
    try{
      if(editId){
        await sb.update("maint_destinations",editId,{name:name.trim()});
        setDestinations(p=>p.map(d=>d.id===editId?{...d,name:name.trim()}:d));
      }else{
        const row={id:uid(),location_id:locId,name:name.trim(),sort_order:locDests.length+1,company_id:companyId};
        await sb.insert("maint_destinations",row);
        setDestinations(p=>[...p,row]);
      }
      setShowForm(false);
    }catch(e){alert("Save failed: "+e.message);}
  };
  const remove=async d=>{
    if(!window.confirm(`Remove "${d.name}"?\n\nExisting issue records will keep the recorded destination name.`))return;
    try{await sb.delete("maint_destinations",d.id);setDestinations(p=>p.filter(x=>x.id!==d.id));}
    catch(e){alert("Error: "+e.message);}
  };
  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Destinations</div><div className="strip-val">{locDests.length}</div></div>
      <div style={{marginLeft:"auto"}}><button className="btn btn-primary" onClick={openAdd}>+ Add Destination</button></div>
    </div>
    <div style={{fontSize:12,color:T.muted,marginBottom:14,lineHeight:1.6}}>
      Buildings and rooms you can issue stock to from this location.
      Renaming or removing a destination does not affect existing issue records.
    </div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>#</th><th>Destination Name</th><th></th></tr></thead>
      <tbody>
        {locDests.map((d,i)=>(
          <tr key={d.id}>
            <td className="mono" style={{fontSize:11,color:T.muted}}>{i+1}</td>
            <td style={{fontWeight:600}}>{d.name}</td>
            <td style={{display:"flex",gap:5}}>
              <button className="btn btn-ghost btn-sm" onClick={()=>openEdit(d)}>Rename</button>
              <button className="btn btn-danger btn-sm" onClick={()=>remove(d)}>x</button>
            </td>
          </tr>
        ))}
        {locDests.length===0&&<tr><td colSpan={3} className="empty">No destinations yet. Add buildings and rooms above.</td></tr>}
      </tbody>
    </table></div>
    {showForm&&(
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowForm(false)}>
        <div className="modal" style={{maxWidth:400}}>
          <div className="modal-title">{editId?"Rename":"Add"} <span>Destination</span></div>
          <div className="field"><label>Name</label>
            <input type="text" autoFocus placeholder="e.g. ZC Room 4" value={name} onChange={e=>setName(e.target.value)}/>
          </div>
          <div style={{display:"flex",gap:9}}>
            <button className="btn btn-primary" onClick={save}>Save</button>
            <button className="btn btn-ghost" onClick={()=>setShowForm(false)}>Cancel</button>
          </div>
        </div>
      </div>
    )}
  </>);
}

// Type-to-search dropdown (2026-08-25) — same value/onChange contract as a
// plain <select> (value = selected option's `value`, onChange receives the
// new value), but lets staff type a few letters to filter instead of
// scrolling a long native list. Used for item/supplier/member-style
// pickers with many options; short toggles/enums (job type, destination,
// status, recurrence, unit) stay as plain <select>s since search doesn't
// help there. `options` is [{ value, label }].
const searchSelectInput = {width:"100%",background:"rgba(0,0,0,.25)",border:`1px solid ${T.border}`,borderRadius:6,
  padding:"10px 11px",color:T.cream,fontFamily:"'Inter',sans-serif",fontSize:16,outline:"none"};

function SearchableSelect({ value, onChange, options, placeholder = "Select…", style, inputStyle, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);

  const selected = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  useEffect(() => {
    function onDocDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, []);

  function choose(opt) {
    onChange(opt.value);
    setQuery("");
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setOpen(true);
        setHighlight(0);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlight]) choose(filtered[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div ref={wrapRef} style={{ position: "relative", ...style }}>
      <input
        type="text"
        style={inputStyle || searchSelectInput}
        placeholder={selected && !open ? selected.label : placeholder}
        value={open ? query : selected ? selected.label : ""}
        onFocus={() => { setOpen(true); setQuery(""); setHighlight(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
      {open && (
        <div
          style={{
            position: "absolute", top: "100%", left: 0, right: 0, marginTop: 2, zIndex: 50,
            background: T.panel, border: `1px solid ${T.border}`, borderRadius: 8,
            maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
          }}
        >
          {filtered.length === 0 && (
            <div style={{ padding: "7px 10px", fontSize: 12, color: T.muted }}>No matches</div>
          )}
          {filtered.map((o, i) => (
            <div
              key={o.value}
              onMouseDown={(e) => { e.preventDefault(); choose(o); }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: "7px 10px", fontSize: 13, cursor: "pointer", color: T.cream,
                background: i === highlight ? "rgba(184,147,90,.14)" : "transparent",
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SCAN A SLIP (Purchases) ─────────────────────────────────────────────────
// Photograph or upload a purchase slip/invoice, let /api/parse-slip (Claude
// vision, server-side) read the line items, then review/correct before
// anything saves. The photo itself is uploaded and kept regardless of
// whether the OCR read is used — that's the actual 7-year compliance
// record (see add_purchase_slips.sql); the parsed line items are just a
// convenience so nobody has to retype what's already printed on the slip.
function MaintSlipScanCard({ items, locId, companyId, onSaved, memberBillingEnabled, onMemberPending }) {
  const [scanning,setScanning]=useState(false);
  const [scanError,setScanError]=useState("");
  const [review,setReview]=useState(null);
  const [saving,setSaving]=useState(false);
  const [saveStatus,setSaveStatus]=useState("");
  const fileRef=useRef(null);

  const handleFile=async e=>{
    const file=e.target.files?.[0];
    e.target.value="";
    if(!file)return;
    setScanError(""); setSaveStatus(""); setScanning(true);
    try{
      const resized=await resizeImageFile(file);
      const base64=await blobToBase64(resized);
      const res=await fetch("/api/parse-slip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({image_base64:base64,media_type:"image/jpeg"})});
      const data=await res.json();
      if(!res.ok) throw new Error(data.error||"Could not read that slip.");
      const pricesIncludeVat = typeof data.amounts_include_vat_guess==="boolean" ? data.amounts_include_vat_guess : true;
      const vatRate = data.vat_rate_guess ?? 15;
      const rowsRaw=(data.line_items||[]).map((li,idx)=>{
        const m=findBestItemMatch(li.raw_text, items);
        const rawTotal = li.total_price ?? ((li.unit_price&&li.qty) ? li.unit_price*li.qty : 0);
        return { key: idx, raw_text: li.raw_text, item_id: m.confident?m.match.id:"", confident:m.confident, guessName:m.match?.description||"", qty: li.qty??1, raw_total:rawTotal, total_cost:rawTotal, skip:false, billToMember:false };
      });
      setReview({
        date: fromISO(data.date_guess || new Date().toISOString().slice(0,10)),
        supplier: data.supplier_guess||"",
        slipTotal: data.slip_total ?? null,
        pricesIncludeVat, vatRate,
        rows: applyVatToRows(rowsRaw, pricesIncludeVat, vatRate),
        photoBlob: resized,
      });
    }catch(err){ setScanError(err.message||"Something went wrong reading that slip."); }
    finally{ setScanning(false); }
  };

  const updateRow=(key,patch)=>setReview(r=>({...r, rows:r.rows.map(row=>row.key===key?{...row,...patch}:row)}));
  const setPricesIncludeVat=val=>setReview(r=>({...r, pricesIncludeVat:val, rows:applyVatToRows(r.rows,val,r.vatRate)}));
  const setVatRate=val=>setReview(r=>({...r, vatRate:val, rows:applyVatToRows(r.rows,r.pricesIncludeVat,val)}));
  const cancelReview=()=>{ setReview(null); setScanError(""); setSaveStatus(""); };

  const approve=async()=>{
    const toSave=review.rows.filter(r=>!r.skip && !r.billToMember && r.item_id && Number(r.qty)>0);
    const toMember=review.rows.filter(r=>!r.skip && r.billToMember);
    if(toSave.length===0 && toMember.length===0){ setSaveStatus("Nothing to save — pick an item (or tick Bill to Member) for at least one line, or cancel."); return; }
    setSaving(true); setSaveStatus("");
    try{
      const slip = await uploadPurchaseSlip({
        companyId, locationId: locId, blob: review.photoBlob,
        supplierGuess: review.supplier, dateGuess: toISO(review.date), slipTotalGuess: review.slipTotal,
      });
      const saved=[];
      for(const r of toSave){
        const row={id:uid(), location_id:locId, item_id:r.item_id, date:review.date,
          qty:Number(r.qty), total_cost:Number(r.total_cost)||0,
          supplier:review.supplier||null, notes:null, company_id:companyId, slip_id:slip.id};
        await sb.insert("maint_purchases", row);
        saved.push(row);
      }
      if(toMember.length){
        await addPendingCharges({
          companyId, locationId: locId, slipId: slip.id,
          rows: toMember.map(r=>({
            chargeDate: toISO(review.date),
            description: r.guessName||r.raw_text,
            qty: Number(r.qty)||null,
            amount: vatInclusiveAmount(r, review.pricesIncludeVat, review.vatRate),
          })),
        });
        onMemberPending?.();
      }
      onSaved(saved, slip);
      const parts=[];
      if(saved.length) parts.push(`${saved.length} purchase${saved.length===1?"":"s"}`);
      if(toMember.length) parts.push(`${toMember.length} line${toMember.length===1?"":"s"} sent to Member Purchase`);
      setSaveStatus(`Saved ${parts.join(" and ")} and attached the slip photo.`);
      setReview(null);
    }catch(err){ setSaveStatus(`Could not save: ${err.message}`); }
    finally{ setSaving(false); }
  };

  return (
    <div className="card" style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div className="section-title" style={{margin:0}}>Scan a purchase slip</div>
        {!review && <button className="btn btn-ghost" onClick={()=>fileRef.current?.click()} disabled={scanning}>{scanning?"Reading slip…":"Scan / photograph slip"}</button>}
      </div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={handleFile}/>
      {!review && <div style={{fontSize:12,color:T.muted,marginTop:6}}>Take a photo (or upload one) of a supplier delivery slip or invoice — items, quantities and prices are read automatically, and the photo itself is kept for your records. Nothing saves until you check the list and press Approve.</div>}
      {scanError && <div style={{color:T.danger,fontSize:12,marginTop:8}}>{scanError}</div>}

      {review && (
        <div style={{marginTop:10}}>
          <div className="grid2">
            <div className="field"><label>Date</label><DateField value={review.date} onChange={v=>setReview({...review,date:v})}/></div>
            <div className="field"><label>Supplier</label><input type="text" value={review.supplier} onChange={e=>setReview({...review,supplier:e.target.value})}/></div>
            <div className="field"><label>Slip prices</label>
              <select value={review.pricesIncludeVat?"incl":"excl"} onChange={e=>setPricesIncludeVat(e.target.value==="incl")}>
                <option value="incl">Include VAT</option>
                <option value="excl">Already exclude VAT</option>
              </select>
            </div>
            {review.pricesIncludeVat && <div className="field"><label>VAT rate %</label><input type="number" inputMode="decimal" value={review.vatRate} onChange={e=>setVatRate(e.target.value)}/></div>}
          </div>
          <div style={{fontSize:12,color:T.muted,margin:"8px 0"}}>
            {review.rows.length} line{review.rows.length===1?"":"s"} read from the slip. Green = matched automatically — check it's right. Amber = pick the item, or tick Skip to leave it out.
            {memberBillingEnabled && <> A line bought on a member's behalf can be ticked <strong>Bill to Member</strong> instead — it skips this app's stock and lands in the Member Purchase list to be billed to whoever it's for, at the full VAT-inclusive amount as printed on the slip.</>}
            {review.slipTotal!=null && <> Slip total printed: <strong style={{color:T.cream}}>{fmtR(review.slipTotal)}</strong>.</>}
          </div>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>Slip text</th><th>Item</th><th className="num">Qty</th><th className="num">Total cost</th><th>Skip</th>{memberBillingEnabled && <th>Bill to Member</th>}</tr></thead>
            <tbody>
              {review.rows.map(r=>(
                <tr key={r.key} style={{background:r.skip?"rgba(0,0,0,.15)":r.billToMember?"rgba(184,147,90,.10)":r.confident?"rgba(90,155,106,.06)":"rgba(184,147,90,.08)"}}>
                  <td style={{fontSize:12,color:T.muted,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.raw_text}</td>
                  <td>
                    <SearchableSelect
                      value={r.item_id}
                      onChange={v=>updateRow(r.key,{item_id:v})}
                      options={items.map(it=>({value:it.id,label:it.description}))}
                      placeholder="— Select item —"
                      style={{minWidth:160}}
                    />
                  </td>
                  <td className="num"><input type="number" inputMode="decimal" style={{width:70}} value={r.qty} onChange={e=>updateRow(r.key,{qty:e.target.value})}/></td>
                  <td className="num"><input type="number" inputMode="decimal" step="0.01" style={{width:90}} value={r.total_cost} onChange={e=>updateRow(r.key,{total_cost:e.target.value})}/></td>
                  <td><input type="checkbox" checked={r.skip} onChange={e=>updateRow(r.key,{skip:e.target.checked})}/></td>
                  {memberBillingEnabled && <td><input type="checkbox" checked={r.billToMember} onChange={e=>updateRow(r.key,{billToMember:e.target.checked, skip:e.target.checked?false:r.skip})}/></td>}
                </tr>
              ))}
            </tbody>
          </table></div>
          {saveStatus && <div style={{fontSize:12,color:saveStatus.startsWith("Could not")?T.danger:T.ok,marginTop:8}}>{saveStatus}</div>}
          <div style={{display:"flex",gap:9,marginTop:12}}>
            <button className="btn btn-primary" onClick={approve} disabled={saving}>{saving?"Saving…":"Approve & save"}</button>
            <button className="btn btn-ghost" onClick={cancelReview} disabled={saving}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Manual fallback for when the scanner can't read a slip (or wasn't used) —
// just uploads the photo and links it, no OCR. Used both for a brand-new
// hand-entered purchase (attaches while saving) and for an already-saved
// purchase row that didn't get a slip at the time (attaches after the fact).
function AttachSlipButton({ companyId, locId, purchaseId, onAttached, label="Attach slip" }) {
  const [uploading,setUploading]=useState(false);
  const fileRef=useRef(null);
  const handleFile=async e=>{
    const file=e.target.files?.[0]; e.target.value="";
    if(!file)return;
    setUploading(true);
    try{
      const resized=await resizeImageFile(file);
      const slip=await uploadPurchaseSlip({companyId, locationId:locId, blob:resized});
      if(purchaseId) await sb.update("maint_purchases", purchaseId, {slip_id:slip.id});
      onAttached(slip, purchaseId);
    }catch(err){ alert("Could not attach the slip: "+err.message); }
    finally{ setUploading(false); }
  };
  return (<>
    <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={handleFile}/>
    <button type="button" className="btn btn-ghost btn-sm" onClick={()=>fileRef.current?.click()} disabled={uploading}>{uploading?"Uploading…":label}</button>
  </>);
}

function ViewSlipLink({ storagePath }) {
  const [loading,setLoading]=useState(false);
  const open=async()=>{
    setLoading(true);
    try{ const url=await getSlipUrl(storagePath); window.open(url,"_blank","noopener"); }
    catch(err){ alert("Could not open the slip: "+err.message); }
    finally{ setLoading(false); }
  };
  return <button className="btn btn-ghost btn-sm" onClick={open} disabled={loading}>{loading?"…":"View slip"}</button>;
}

// ─── PURCHASES ───────────────────────────────────────────────────────────────
// Quick-log a purchase straight to a member's account instead of this
// app's own stock — see memberPurchase.js. Only rendered when
// memberBillingEnabled is true for the current company (Demo only today).
function MemberPurchaseModal({ companyId, locId, onClose, pendingRefresh, onBilled }) {
  const [members,setMembers]=useState([]);
  const [form,setForm]=useState({member_id:"",date:new Date().toISOString().slice(0,10),description:"",amount:""});
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState("");

  // Pending queue — lines ticked "Bill to Member" during a slip scan land
  // here first (see MaintSlipScanCard/memberPurchase.js) instead of
  // billing immediately, so nothing gets forgotten and a slip mixing
  // parts/stock + member items can still be scanned in one go.
  const [pending,setPending]=useState([]);
  const [pendingLoading,setPendingLoading]=useState(false);
  const [selected,setSelected]=useState(()=>new Set());
  const [billMemberId,setBillMemberId]=useState("");
  const [billing,setBilling]=useState(false);
  const [billMessage,setBillMessage]=useState("");

  const loadPending=()=>{
    setPendingLoading(true);
    listPendingCharges({companyId}).then(rows=>setPending(rows)).catch(()=>setPending([])).finally(()=>setPendingLoading(false));
  };

  useEffect(()=>{
    listBillingMembers({companyId}).then(m=>{
      setMembers(m);
      setForm(f=>({...f,member_id:f.member_id||m[0]?.id||""}));
      setBillMemberId(id=>id||m[0]?.id||"");
    }).catch(()=>setMembers([]));
  },[companyId]);

  useEffect(()=>{ loadPending(); },[companyId,pendingRefresh]);

  const toggleSelected=id=>setSelected(s=>{const next=new Set(s); if(next.has(id))next.delete(id); else next.add(id); return next;});
  const toggleSelectAll=()=>setSelected(s=>s.size===pending.length?new Set():new Set(pending.map(p=>p.id)));

  const billSelected=async()=>{
    setBillMessage("");
    if(!billMemberId||selected.size===0){setBillMessage("Pick a member and tick at least one line.");return;}
    setBilling(true);
    try{
      await billPendingCharges({companyId,memberId:billMemberId,locationId:locId,pendingIds:Array.from(selected)});
      setSelected(new Set());
      setBillMessage("Billed to their member account.");
      loadPending();
      onBilled?.();
    }catch(e){setBillMessage(e.message||"Could not bill those lines.");}
    finally{setBilling(false);}
  };

  const removePending=async(id)=>{
    if(!window.confirm("Remove this line without billing it to anyone?"))return;
    try{ await deletePendingCharge({id}); loadPending(); }
    catch(e){ alert("Could not remove that line: "+e.message); }
  };

  const save=async()=>{
    setMessage("");
    if(!form.member_id||!form.description||!form.amount){setMessage("Pick a member and fill in description + amount.");return;}
    setSaving(true);
    try{
      await logMemberPurchase({companyId,memberId:form.member_id,locationId:locId,chargeDate:form.date,description:form.description,amount:form.amount});
      setMessage("Logged to their member account.");
      setForm(f=>({...f,description:"",amount:""}));
    }catch(e){setMessage(e.message||"Could not save.");}
    finally{setSaving(false);}
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-title">Log <span>Member Purchase</span></div>
        <div style={{fontSize:12,color:T.muted,marginBottom:10}}>Bought on a member's behalf — goes straight to their account, not this app's stock.</div>

        {(pendingLoading||pending.length>0) && (
          <div style={{marginBottom:14,paddingBottom:12,borderBottom:`1px solid ${T.border}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <div style={{fontSize:13,fontWeight:600}}>Pending — tick lines to bill</div>
              {pending.length>0 && <button className="btn btn-ghost btn-sm" type="button" onClick={toggleSelectAll}>{selected.size===pending.length?"Clear all":"Select all"}</button>}
            </div>
            <div style={{fontSize:12,color:T.muted,marginBottom:8}}>Lines ticked "Bill to Member" when scanning a slip land here first — nothing bills until you tick them below and pick who to bill.</div>
            {pendingLoading&&pending.length===0&&<div style={{fontSize:12,color:T.muted}}>Loading…</div>}
            {pending.map(p=>(
              <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderTop:`1px solid ${T.border}`}}>
                <label style={{display:"flex",gap:8,alignItems:"center",cursor:"pointer",flex:1}}>
                  <input type="checkbox" checked={selected.has(p.id)} onChange={()=>toggleSelected(p.id)}/>
                  <span style={{fontSize:13}}>{p.description}{p.qty?` × ${p.qty}`:""} — {fmtR(p.amount)}<span style={{color:T.muted,fontSize:11}}> ({p.charge_date})</span></span>
                </label>
                <button className="btn btn-ghost btn-sm" type="button" onClick={()=>removePending(p.id)}>Remove</button>
              </div>
            ))}
            <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
              <SearchableSelect
                value={billMemberId}
                onChange={setBillMemberId}
                options={members.map(m=>({value:m.id,label:m.name}))}
                style={{minWidth:180}}
              />
              <button className="btn btn-primary" type="button" onClick={billSelected} disabled={billing||selected.size===0}>{billing?"Billing…":`Bill ${selected.size||""} selected to member`}</button>
            </div>
            {billMessage&&<div style={{fontSize:12,marginTop:6,color:T.muted}}>{billMessage}</div>}
          </div>
        )}

        <div className="field"><label>Member</label>
          <SearchableSelect
            value={form.member_id}
            onChange={v=>setForm(p=>({...p,member_id:v}))}
            options={members.map(m=>({value:m.id,label:m.name}))}
          />
        </div>
        <div className="grid2">
          <div className="field"><label>Date</label><input type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))}/></div>
          <div className="field"><label>Amount (R)</label><input type="number" inputMode="decimal" step="0.01" value={form.amount} onChange={e=>setForm(p=>({...p,amount:e.target.value}))}/></div>
        </div>
        <div className="field"><label>Description</label><input type="text" value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} placeholder="e.g. Hardware for repair"/></div>
        {message&&<div style={{fontSize:12,color:T.muted,marginBottom:8}}>{message}</div>}
        <div style={{display:"flex",gap:9}}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving?"Saving…":"Log to member account"}</button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function Purchases({ locId, items, purchases, setPurchases, isAdmin, companyId, slips, onSlipAttached, creditNotes, setCreditNotes, setIssues }) {
  const { memberBillingEnabled } = useCompany();
  const [showMemberForm,setShowMemberForm]=useState(false);
  const [memberPendingRefresh,setMemberPendingRefresh]=useState(0);
  const [showForm,setShowForm]=useState(false);
  // Credit Notes (2026-08-25) — lives inside Purchases as a toggle rather
  // than its own nav page: it's the same "wrong thing was bought" moment as
  // a purchase, just the reverse direction, so it belongs next to the
  // purchase form instead of forcing a page switch to find it.
  const [showCredits,setShowCredits]=useState(false);
  const blank={item_id:"",date:today(),qty:"",total_cost:"",supplier:"",notes:"",pendingSlipBlob:null,pendingSlipName:""};
  const [form,setForm]=useState(blank);
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));
  const pickSlipFile=async e=>{
    const file=e.target.files?.[0]; e.target.value="";
    if(!file)return;
    const resized=await resizeImageFile(file);
    setForm(p=>({...p,pendingSlipBlob:resized,pendingSlipName:file.name}));
  };
  const save=async()=>{
    if(!form.item_id||!form.qty)return;
    let slipId=null;
    try{
      if(form.pendingSlipBlob){
        const slip=await uploadPurchaseSlip({companyId, locationId:locId, blob:form.pendingSlipBlob});
        slipId=slip.id;
        onSlipAttached(slip);
      }
      const row={id:uid(),location_id:locId,item_id:form.item_id,date:form.date,
        qty:parseFloat(form.qty)||0,total_cost:parseFloat(form.total_cost)||0,
        supplier:form.supplier||null,notes:form.notes||null,company_id:companyId,slip_id:slipId};
      await sb.insert("maint_purchases",row);setPurchases(p=>[...p,row]);setForm(blank);setShowForm(false);
    }
    catch(e){alert("Save failed: "+e.message);}
  };
  const remove=async id=>{
    try{await sb.delete("maint_purchases",id);setPurchases(p=>p.filter(x=>x.id!==id));}
    catch(e){alert("Error: "+e.message);}
  };
  const totalSpend=purchases.reduce((s,p)=>s+(p.total_cost||0),0);
  const totalUnits=purchases.reduce((s,p)=>s+(p.qty||0),0);
  const itemName=id=>items.find(i=>i.id===id)?.description||id;
  return (<>
    <MaintSlipScanCard items={items} locId={locId} companyId={companyId} onSaved={(saved,slip)=>{setPurchases(p=>[...p,...saved]);onSlipAttached(slip);}} memberBillingEnabled={memberBillingEnabled} onMemberPending={()=>setMemberPendingRefresh(n=>n+1)}/>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Total Spend</div><div className="strip-val">{fmtR(totalSpend)}</div></div>
      <div className="strip-item"><div className="strip-label">Units Purchased</div><div className="strip-val">{fmtN(totalUnits)}</div></div>
      <div className="strip-item"><div className="strip-label">Entries</div><div className="strip-val">{purchases.length}</div></div>
      <div style={{marginLeft:"auto",display:"flex",gap:9}}>
        {memberBillingEnabled && <button className="btn btn-ghost" onClick={()=>setShowMemberForm(true)}>+ Log Member Purchase</button>}
        <button className="btn btn-ghost" onClick={()=>setShowCredits(s=>!s)}>{showCredits?"Hide Credit Notes":"Credit Note"}</button>
        <button className="btn btn-primary" onClick={()=>{setForm({...blank,date:today()});setShowForm(true);}}>+ Log Purchase</button>
      </div>
    </div>
    {showMemberForm && <MemberPurchaseModal companyId={companyId} locId={locId} onClose={()=>setShowMemberForm(false)} pendingRefresh={memberPendingRefresh}/>}
    {showCredits && <CreditNotes locId={locId} items={items} creditNotes={creditNotes} setCreditNotes={setCreditNotes} setIssues={setIssues} isAdmin={isAdmin} companyId={companyId} slips={slips} onSlipAttached={onSlipAttached}/>}
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Date</th><th>Item</th><th className="num">Qty</th><th className="num">Total Cost</th>
        <th className="num">Cost/Unit</th><th>Supplier</th><th>Notes</th><th>Slip</th><th></th></tr></thead>
      <tbody>
        {purchases.map(p=>(
          <tr key={p.id}>
            <td className="mono" style={{fontSize:11}}>{p.date}</td>
            <td style={{fontWeight:600}}>{itemName(p.item_id)}</td>
            <td className="num ok">{fmtN(p.qty)}</td>
            <td className="num">{fmtR(p.total_cost)}</td>
            <td className="num" style={{color:T.muted,fontSize:12}}>{p.qty>0?fmtR((p.total_cost||0)/p.qty):"—"}</td>
            <td style={{fontSize:12,color:T.muted}}>{p.supplier||"—"}</td>
            <td style={{fontSize:12,color:T.muted}}>{p.notes||"—"}</td>
            <td>
              {p.slip_id && slips[p.slip_id] ? <ViewSlipLink storagePath={slips[p.slip_id].storage_path}/>
                : <AttachSlipButton companyId={companyId} locId={locId} purchaseId={p.id}
                    onAttached={(slip)=>{onSlipAttached(slip);setPurchases(ps=>ps.map(x=>x.id===p.id?{...x,slip_id:slip.id}:x));}}/>}
            </td>
            <td>{isAdmin&&<button className="btn btn-danger btn-sm" onClick={()=>remove(p.id)}>x</button>}</td>
          </tr>
        ))}
        {purchases.length===0&&<tr><td colSpan={9} className="empty">No purchases logged yet</td></tr>}
      </tbody>
    </table></div>
    {showForm&&(
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowForm(false)}>
        <div className="modal">
          <div className="modal-title">Log <span>Purchase</span></div>
          <div className="field"><label>Item</label>
            <SearchableSelect
              value={form.item_id}
              onChange={v=>setForm(p=>({...p,item_id:v}))}
              options={items.map(i=>({value:i.id,label:i.description}))}
              placeholder="-- Select item --"
            />
          </div>
          <div className="grid2">
            <div className="field"><label>Date</label><DateField value={form.date} onChange={v=>setForm(p=>({...p,date:v}))}/></div>
            <div className="field"><label>Qty Purchased</label><input type="number" inputMode="decimal" value={form.qty} onChange={f("qty")}/></div>
            <div className="field"><label>Total Cost (R excl VAT)</label><input type="number" inputMode="decimal" step="0.01" value={form.total_cost} onChange={f("total_cost")}/></div>
            <div className="field"><label>Supplier</label><input type="text" value={form.supplier} onChange={f("supplier")}/></div>
          </div>
          {form.qty&&form.total_cost&&(
            <div className="info-box">
              <span style={{fontSize:11,color:T.muted}}>Cost per unit</span>
              <strong style={{fontFamily:"'Space Mono'",color:T.ok}}>{fmtR((parseFloat(form.total_cost)||0)/(parseFloat(form.qty)||1))}</strong>
            </div>
          )}
          <div className="field"><label>Notes</label><input type="text" value={form.notes} onChange={f("notes")}/></div>
          <div className="field">
            <label>Slip photo (optional — use if you didn't use Scan above)</label>
            <input type="file" accept="image/*" capture="environment" onChange={pickSlipFile}/>
            {form.pendingSlipName && <div style={{fontSize:11,color:T.ok,marginTop:4}}>Attached: {form.pendingSlipName}</div>}
          </div>
          <div style={{display:"flex",gap:9}}>
            <button className="btn btn-primary" onClick={save}>Save Purchase</button>
            <button className="btn btn-ghost" onClick={()=>setShowForm(false)}>Cancel</button>
          </div>
        </div>
      </div>
    )}
  </>);
}

// ─── ISSUES ──────────────────────────────────────────────────────────────────
function Issues({ locId, items, issues, setIssues, destinations, purchases, jobs, isAdmin, companyId }) {
  const [destDetail,setDestDetail] = useState(null);
  const openDest = (iss) => {
    const rows = buildDestinationCosts({destinations, issues, items, purchases:purchases||[], jobs:jobs||[]});
    const key  = iss.destination_id || null;
    const hit  = rows.find(r => key ? r.id===key : r.name===(iss.dest_name||"Unassigned"));
    if (hit) setDestDetail(hit);
  };
  const locDests = destinations.filter(d=>d.location_id===locId).sort((a,b)=>a.sort_order-b.sort_order);
  const [showForm,setShowForm]=useState(false);
  const blank={item_id:"",date:today(),qty:"",destination_id:"",notes:""};
  const [form,setForm]=useState(blank);
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));

  // Category-then-item picker (2026-08-17) — same two-step pattern as
  // MaterialPicker (used on job cards/templates) so choosing what's being
  // issued works the same way everywhere in the app instead of scrolling one
  // long flat item list here.
  const [category,setCategory]=useState("");
  const categories = useMemo(()=>[...new Set(items.map(it=>it.category).filter(Boolean))].sort(),[items]);
  const uncategorisedCount = items.filter(it=>!it.category).length;
  const itemsInCat = category
    ? items.filter(it => category==="__none__" ? !it.category : it.category===category)
    : [];

  const save=async()=>{
    if(!form.item_id||!form.qty)return;
    const dest=locDests.find(d=>d.id===form.destination_id);
    const row={id:uid(),location_id:locId,item_id:form.item_id,date:form.date,
      qty:parseFloat(form.qty)||0,destination_id:form.destination_id||null,
      dest_name:dest?.name||null,notes:form.notes||null,company_id:companyId};
    try{await sb.insert("maint_issues",row);setIssues(p=>[...p,row]);setForm({...blank,date:today()});setCategory("");setShowForm(false);}
    catch(e){alert("Save failed: "+e.message);}
  };
  const remove=async id=>{
    try{await sb.delete("maint_issues",id);setIssues(p=>p.filter(x=>x.id!==id));}
    catch(e){alert("Error: "+e.message);}
  };
  const totalIssued=issues.reduce((s,i)=>s+(i.qty||0),0);
  const itemName=id=>items.find(i=>i.id===id)?.description||id;
  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Total Units Issued</div><div className="strip-val">{fmtN(totalIssued)}</div></div>
      <div className="strip-item"><div className="strip-label">Issue Entries</div><div className="strip-val">{issues.length}</div></div>
      <div style={{marginLeft:"auto"}}>
        <button className="btn btn-primary" onClick={()=>{setForm({...blank,date:today(),destination_id:locDests[0]?.id||""});setCategory("");setShowForm(true);}}>+ Log Issue</button>
      </div>
    </div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Date</th><th>Item</th><th className="num">Qty</th><th>Issued To</th><th>Notes</th><th></th></tr></thead>
      <tbody>
        {issues.map(i=>(
          <tr key={i.id}>
            <td className="mono" style={{fontSize:11}}>{i.date}</td>
            <td style={{fontWeight:600}}>{itemName(i.item_id)}</td>
            <td className="num warn">{fmtN(i.qty)}</td>
            <td style={{fontSize:12}}>
              {i.dest_name
                ? <button onClick={()=>openDest(i)}
                    style={{background:"none",border:"none",padding:0,textAlign:"left",cursor:"pointer",
                      fontFamily:"'Inter',sans-serif",fontSize:12,color:T.cream,
                      borderBottom:`1px dotted ${T.border}`}}>{i.dest_name}</button>
                : "—"}
            </td>
            <td style={{fontSize:12,color:T.muted}}>{i.notes||"—"}</td>
            <td>{isAdmin&&<button className="btn btn-danger btn-sm" onClick={()=>remove(i.id)}>x</button>}</td>
          </tr>
        ))}
        {issues.length===0&&<tr><td colSpan={6} className="empty">No issues logged yet</td></tr>}
      </tbody>
    </table></div>
    {showForm&&(
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowForm(false)}>
        <div className="modal">
          <div className="modal-title">Log <span>Issue</span></div>
          <div className="field"><label>Category</label>
            <select value={category} onChange={e=>{setCategory(e.target.value);setForm(p=>({...p,item_id:""}));}}>
              <option value="">-- Select category --</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
              {uncategorisedCount>0 && <option value="__none__">Uncategorised</option>}
            </select>
          </div>
          <div className="field"><label>Item</label>
            <SearchableSelect
              value={form.item_id}
              onChange={v=>setForm(p=>({...p,item_id:v}))}
              options={itemsInCat.map(i=>({value:i.id,label:`${i.description} (${i.unit})`}))}
              placeholder={category ? "-- Select item --" : "Pick a category first"}
              disabled={!category}
            />
          </div>
          <div className="grid2">
            <div className="field"><label>Date</label><DateField value={form.date} onChange={v=>setForm(p=>({...p,date:v}))}/></div>
            <div className="field"><label>Qty Issued</label><input type="number" inputMode="decimal" value={form.qty} onChange={f("qty")}/></div>
          </div>
          <div className="field"><label>Issued To</label>
            <select value={form.destination_id} onChange={f("destination_id")}>
              <option value="">-- Select destination --</option>
              {locDests.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {locDests.length===0&&<div style={{fontSize:11,color:T.warn,marginTop:5}}>No destinations set up yet. Go to Management > Destinations.</div>}
          </div>
          <div className="field"><label>Notes</label><input type="text" value={form.notes} onChange={f("notes")}/></div>
          <div style={{display:"flex",gap:9}}>
            <button className="btn btn-primary" onClick={save}>Save Issue</button>
            <button className="btn btn-ghost" onClick={()=>setShowForm(false)}>Cancel</button>
          </div>
        </div>
      </div>
    )}
    {destDetail && <DestinationDetail row={destDetail} onClose={()=>setDestDetail(null)}/>}
  </>);
}

// ─── CREDIT NOTES ────────────────────────────────────────────────────────────
// When the wrong item was bought and has to go back to the supplier: reduces
// stock the same way a normal issue does (a plain maint_issues row, tagged in
// its notes rather than a reason column — this app's issues have never had
// one, they're tracked by destination instead) and logs a row to the shared
// supplier_credit_notes table so Finance Dashboard can cross-check it
// against the supplier's statement, same as purchases already are.
function CreditNotes({ locId, items, creditNotes, setCreditNotes, setIssues, isAdmin, companyId, slips, onSlipAttached }) {
  const [showForm,setShowForm]=useState(false);
  const blank={item_id:"",date:today(),qty:"",unit_cost:"",supplier:"",reason:"wrong_item",credit_note_number:"",notes:"",pendingSlipBlob:null,pendingSlipName:""};
  const [form,setForm]=useState(blank);
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));

  const pickSlipFile=async e=>{
    const file=e.target.files?.[0]; e.target.value="";
    if(!file)return;
    const resized=await resizeImageFile(file);
    setForm(p=>({...p,pendingSlipBlob:resized,pendingSlipName:file.name}));
  };

  const itemName=id=>items.find(i=>i.id===id)?.description||id;
  const qtyNum = parseFloat(form.qty)||0;
  const unitCostNum = parseFloat(form.unit_cost)||0;
  const totalCreditPreview = Math.round(qtyNum*unitCostNum*100)/100;

  const save=async()=>{
    if(!form.item_id||!form.qty||!form.supplier)return;
    try{
      let slipId=null;
      if(form.pendingSlipBlob){
        const slip=await uploadPurchaseSlip({companyId, locationId:locId, blob:form.pendingSlipBlob});
        slipId=slip.id;
        onSlipAttached(slip);
      }

      // Dual-write: a normal stock-reducing issue first (so every existing
      // stock-count/reorder calculation just works), then the financial
      // credit-note record, linked back to the issue it created.
      const issueRow={id:uid(),location_id:locId,item_id:form.item_id,date:form.date,
        qty:qtyNum,destination_id:null,dest_name:null,
        notes:`Credit note${form.credit_note_number?" #"+form.credit_note_number:""} — ${form.supplier}`,
        company_id:companyId};
      await sb.insert("maint_issues", issueRow);
      setIssues(p=>[...p,issueRow]);

      const cnRow={id:uid(),company_id:companyId,app:"maintenance",location_id:locId,period:null,
        item_id:form.item_id,item_description:itemName(form.item_id),issue_id:issueRow.id,
        qty:qtyNum,unit_cost:unitCostNum,total_credit:totalCreditPreview,supplier:form.supplier,
        reason:form.reason,credit_note_number:form.credit_note_number||null,
        date:toISO(form.date),notes:form.notes||null,slip_id:slipId};
      await sb.insert("supplier_credit_notes", cnRow);
      setCreditNotes(p=>[...p,cnRow]);

      setForm({...blank,date:form.date});
      setShowForm(false);
    }catch(e){alert("Save failed: "+e.message);}
  };

  const remove=async c=>{
    if(!window.confirm("Delete this credit note? This also reverses the stock it returned."))return;
    try{
      await sb.delete("supplier_credit_notes", c.id);
      setCreditNotes(p=>p.filter(x=>x.id!==c.id));
      if(c.issue_id){
        await sb.delete("maint_issues", c.issue_id);
        setIssues(p=>p.filter(x=>x.id!==c.issue_id));
      }
    }catch(e){alert("Error: "+e.message);}
  };

  const totalCredit = creditNotes.reduce((s,c)=>s+(c.total_credit||0),0);

  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Total Credits</div><div className="strip-val">{fmtR(totalCredit)}</div></div>
      <div className="strip-item"><div className="strip-label">Entries</div><div className="strip-val">{creditNotes.length}</div></div>
      <div style={{marginLeft:"auto"}}>
        <button className="btn btn-primary" onClick={()=>{setForm({...blank,date:today()});setShowForm(true);}}>+ Log Credit Note</button>
      </div>
    </div>
    <div style={{fontSize:12,color:T.muted,marginBottom:10}}>
      For when the wrong item was bought and has to go back to the supplier. This reduces stock (as
      an issue) and records a credit against the supplier for Finance Dashboard to reconcile.
    </div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Date</th><th>Item</th><th className="num">Qty</th><th className="num">Credit R</th>
        <th>Supplier</th><th>Reason</th><th>Credit note #</th><th>Slip</th><th></th></tr></thead>
      <tbody>
        {creditNotes.map(c=>(
          <tr key={c.id}>
            <td className="mono" style={{fontSize:11}}>{fromISO(c.date)}</td>
            <td style={{fontWeight:600}}>{c.item_description}</td>
            <td className="num warn">{fmtN(c.qty)}</td>
            <td className="num">{fmtR(c.total_credit)}</td>
            <td style={{fontSize:12,color:T.muted}}>{c.supplier}</td>
            <td style={{fontSize:12,color:T.muted}}>{CREDIT_REASONS.find(r=>r.value===c.reason)?.label||c.reason}</td>
            <td style={{fontSize:12,color:T.muted}}>{c.credit_note_number||"—"}</td>
            <td>{c.slip_id && slips[c.slip_id] ? <ViewSlipLink storagePath={slips[c.slip_id].storage_path}/> : "—"}</td>
            <td>{isAdmin&&<button className="btn btn-danger btn-sm" onClick={()=>remove(c)}>x</button>}</td>
          </tr>
        ))}
        {creditNotes.length===0&&<tr><td colSpan={9} className="empty">No credit notes logged yet</td></tr>}
      </tbody>
    </table></div>
    {showForm&&(
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowForm(false)}>
        <div className="modal">
          <div className="modal-title">Log <span>Credit Note</span></div>
          <div className="field"><label>Item</label>
            <SearchableSelect
              value={form.item_id}
              onChange={v=>setForm(p=>({...p,item_id:v}))}
              options={items.map(i=>({value:i.id,label:i.description}))}
              placeholder="-- Select item --"
            />
          </div>
          <div className="grid2">
            <div className="field"><label>Date</label><DateField value={form.date} onChange={v=>setForm(p=>({...p,date:v}))}/></div>
            <div className="field"><label>Qty returned</label><input type="number" inputMode="decimal" value={form.qty} onChange={f("qty")}/></div>
            <div className="field"><label>Unit cost (R excl VAT)</label><input type="number" inputMode="decimal" step="0.01" value={form.unit_cost} onChange={f("unit_cost")}/></div>
            <div className="field"><label>Supplier</label><input type="text" value={form.supplier} onChange={f("supplier")}/></div>
          </div>
          <div className="field"><label>Reason</label>
            <select value={form.reason} onChange={f("reason")}>
              {CREDIT_REASONS.map(r=><option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Credit note # (if known)</label><input type="text" value={form.credit_note_number} onChange={f("credit_note_number")}/></div>
          {form.qty&&form.unit_cost&&(
            <div className="info-box">
              <span style={{fontSize:11,color:T.muted}}>Total credit</span>
              <strong style={{fontFamily:"'Space Mono'",color:T.ok}}>{fmtR(totalCreditPreview)}</strong>
            </div>
          )}
          <div className="field"><label>Notes</label><input type="text" value={form.notes} onChange={f("notes")}/></div>
          <div className="field">
            <label>Slip / credit note photo (optional)</label>
            <input type="file" accept="image/*" capture="environment" onChange={pickSlipFile}/>
            {form.pendingSlipName && <div style={{fontSize:11,color:T.ok,marginTop:4}}>Attached: {form.pendingSlipName}</div>}
          </div>
          <div style={{display:"flex",gap:9}}>
            <button className="btn btn-primary" onClick={save}>Save Credit Note</button>
            <button className="btn btn-ghost" onClick={()=>setShowForm(false)}>Cancel</button>
          </div>
        </div>
      </div>
    )}
  </>);
}

// ─── STOCK COUNT ─────────────────────────────────────────────────────────────
function StockCount({ locId, items, purchases, issues, counts, setCounts, companyId }) {
  const [countDate,setCountDate]=useState(today());
  const [draft,setDraft]=useState({});
  const [saving,setSaving]=useState(false);
  const latestCount=useMemo(()=>{
    const m={};
    counts.forEach(c=>{if(!m[c.item_id]||c.created_at>m[c.item_id].created_at)m[c.item_id]=c;});
    return m;
  },[counts]);
  const theoretical=item=>{
    const b=purchases.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
    const iss=issues.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
    return (item.open_qty||0)+b-iss;
  };
  const saveAll=async()=>{
    const entries=Object.entries(draft).filter(([,v])=>v!=="");
    if(!entries.length)return;
    setSaving(true);
    try{
      const rows=entries.map(([item_id,count_qty])=>({id:uid(),location_id:locId,item_id,count_date:countDate,count_qty:parseFloat(count_qty)||0,company_id:companyId}));
      for(const row of rows){await sb.insert("maint_stock_counts",row);}
      setCounts(p=>[...p,...rows]);
      setDraft({});
    }catch(e){alert("Save failed: "+e.message);}
    finally{setSaving(false);}
  };
  const draftCount=Object.values(draft).filter(v=>v!=="").length;
  const totalVarianceValue=items.reduce((s,item)=>{
    const lc=latestCount[item.id];if(!lc)return s;
    return s+(lc.count_qty-theoretical(item))*(item.open_cost||0);
  },0);
  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Items</div><div className="strip-val">{items.length}</div></div>
      <div className="strip-item"><div className="strip-label">Draft Entries</div><div className="strip-val">{draftCount}</div></div>
      <div className="strip-item"><div className="strip-label">Variance Value</div>
        <div className="strip-val" style={{color:Math.abs(totalVarianceValue)<1?T.ok:T.danger}}>{fmtR(totalVarianceValue)}</div>
      </div>
      <div style={{marginLeft:"auto",display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:10,letterSpacing:".1em",textTransform:"uppercase",color:T.muted,fontWeight:600,marginBottom:4}}>Count Date</div>
          <DateField value={countDate} onChange={setCountDate}/>
        </div>
        <button className="btn btn-primary" onClick={saveAll} disabled={saving||draftCount===0}
          style={{alignSelf:"flex-end",opacity:draftCount===0?.5:1}}>
          {saving?"Saving...":"Save Count"}
        </button>
      </div>
    </div>
    <div style={{fontSize:12,color:T.muted,marginBottom:12,lineHeight:1.6}}>
      Enter the physical count for each item. Leave blank to skip. Hit Save Count when done.
    </div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Code</th><th>Description</th><th className="num">Theoretical</th>
        <th className="num">Last Count</th><th className="num">Physical Count</th>
        <th className="num">Variance</th><th className="num">Variance Value</th></tr></thead>
      <tbody>
        {items.map(item=>{
          const theo=theoretical(item);
          const lc=latestCount[item.id];
          const dv=draft[item.id];
          const countVal=dv!==undefined&&dv!==""?parseFloat(dv)||0:lc?.count_qty;
          const variance=countVal!==undefined?countVal-theo:null;
          const vOk=variance===null||Math.abs(variance)<0.01;
          return (<tr key={item.id}>
            <td className="mono" style={{fontSize:11,color:T.muted}}>{item.item_code||"—"}</td>
            <td style={{fontWeight:600}}>{item.description}</td>
            <td className="num">{fmtN(theo)} <span style={{fontSize:10,color:T.muted}}>{item.unit}</span></td>
            <td className="num" style={{color:T.muted}}>
              {lc?<>{fmtN(lc.count_qty)} <span style={{fontSize:9,color:T.border}}>{lc.count_date}</span></>:"—"}
            </td>
            <td className="num">
              <input className="count-input" type="number" inputMode="decimal"
                value={draft[item.id]||""} placeholder={lc?fmtN(lc.count_qty):"—"}
                onChange={e=>setDraft(d=>({...d,[item.id]:e.target.value}))}/>
            </td>
            <td className="num" style={{fontWeight:700,color:vOk?T.ok:T.danger}}>
              {variance!==null?(variance>0?"+":"")+fmtN(variance):"—"}
            </td>
            <td className="num" style={{color:T.muted,fontSize:12}}>
              {variance!==null?fmtR(Math.abs(variance)*(item.open_cost||0)):"—"}
            </td>
          </tr>);
        })}
      </tbody>
    </table></div>
  </>);
}

// ─── ORDERS ──────────────────────────────────────────────────────────────────
function Orders({ items, purchases, issues, counts, jobs, jobMaterials, templates, templateMaterials }) {
  const latestCount=useMemo(()=>{
    const m={};counts.forEach(c=>{if(!m[c.item_id]||c.created_at>m[c.item_id].created_at)m[c.item_id]=c;});return m;
  },[counts]);
  const orderList=useMemo(()=>{
    return items.map(item=>{
      const b=purchases.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
      const iss=issues.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
      const theo=(item.open_qty||0)+b-iss;
      const lc=latestCount[item.id];
      const actual=lc?lc.count_qty:theo;
      const toOrder=item.max_units>0?Math.max(0,item.max_units-actual):0;
      const isLow=item.min_units>0&&actual<=item.min_units;
      return{...item,theo,actual,toOrder,isLow,hasCount:!!lc};
    }).filter(i=>i.isLow||i.toOrder>0).sort((a,b)=>b.toOrder-a.toOrder);
  },[items,purchases,issues,counts]);
  const totalOrderValue=orderList.reduce((s,i)=>s+i.toOrder*(i.open_cost||0),0);
  const forecast = useMemo(()=>buildForecast({
    jobs, jobMaterials, templates, templateMaterials, items, purchases, issues
  }),[jobs,jobMaterials,templates,templateMaterials,items,purchases,issues]);
  const forecastValue = forecast.reduce((s,r)=>s+r.shortfall*(r.item.open_cost||0),0);
  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Items to Order</div><div className="strip-val">{orderList.length}</div></div>
      <div className="strip-item"><div className="strip-label">Est. Order Value</div><div className="strip-val">{fmtR(totalOrderValue)}</div></div>
      <div className="strip-item"><div className="strip-label">Job Shortfalls</div>
        <div className="strip-val" style={{color:forecast.length>0?T.warn:T.ok}}>{forecast.length}</div></div>
    </div>
    <div className="section-title">Below Minimum Stock</div>
    {orderList.length===0?(
      <div className="empty" style={{padding:"22px 32px"}}>
        All items are above their minimum stock level.
      </div>
    ):(
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>Item</th><th>Location</th><th className="num">Min</th><th className="num">Max</th>
          <th className="num">Current</th><th className="num">To Order</th><th className="num">Est. Cost</th><th>Status</th></tr></thead>
        <tbody>
          {orderList.map(item=>(
            <tr key={item.id}>
              <td>
                <div style={{fontWeight:600}}>{item.description}</div>
                <div style={{fontSize:10,color:T.muted,fontFamily:"'Space Mono'"}}>{item.item_code}</div>
              </td>
              <td style={{fontSize:11,color:T.muted}}>{[item.storeroom,item.shelf].filter(Boolean).join(" / ")}</td>
              <td className="num" style={{color:T.muted}}>{fmtN(item.min_units)}</td>
              <td className="num" style={{color:T.muted}}>{item.max_units>0?fmtN(item.max_units):"—"}</td>
              <td className="num" style={{fontWeight:700,color:item.actual<=item.min_units?T.danger:T.warn}}>
                {fmtN(item.actual)} {item.unit}
                {!item.hasCount&&<span style={{fontSize:9,color:T.muted,marginLeft:4}}>(theo)</span>}
              </td>
              <td className="num"><span className="reorder-qty">{fmtN(item.toOrder)} {item.unit}</span></td>
              <td className="num" style={{color:T.muted}}>{item.toOrder>0?fmtR(item.toOrder*(item.open_cost||0)):"—"}</td>
              <td>
                {item.actual<=0?<span className="badge badge-bad">Out of stock</span>
                :item.actual<=item.min_units?<span className="badge badge-bad">Below min</span>
                :<span className="badge badge-warn">At min</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    )}

    <div className="section-title" style={{marginTop:26}}>Required For Scheduled Jobs</div>
    <div style={{fontSize:12,color:T.muted,marginBottom:12,lineHeight:1.6}}>
      Materials needed by jobs due in the next {FORECAST_DAYS} working days, beyond what is currently in stock.
      Sorted by deadline &mdash; the <strong style={{color:T.cream}}>Needed By</strong> date is when the earliest
      job needing that item is scheduled, so stock has to be on site by then.
      Recurring jobs are counted for every occurrence that falls inside the window.
      This list is separate from the one above &mdash; an item can appear in both.
    </div>
    {forecast.length===0?(
      <div className="empty" style={{padding:"22px 32px"}}>
        Enough stock on hand for every job scheduled in the next {FORECAST_DAYS} working days.
      </div>
    ):(<>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>Item</th><th className="num">Needed</th><th className="num">In Stock</th>
          <th className="num">Short By</th><th className="num">Est. Cost</th>
          <th>Needed By</th><th>Scheduled Jobs</th></tr></thead>
        <tbody>
          {forecast.map(r=>(
            <tr key={r.item.id}>
              <td>
                <div style={{fontWeight:600}}>{r.item.description}</div>
                <div style={{fontSize:10,color:T.muted,fontFamily:"'Space Mono'"}}>{r.item.item_code||""}</div>
              </td>
              <td className="num">{fmtN(r.needed)} <span style={{fontSize:10,color:T.muted}}>{r.item.unit}</span></td>
              <td className="num" style={{color:T.muted}}>{fmtN(r.available)}</td>
              <td className="num"><span className="reorder-qty">{fmtN(r.shortfall)} {r.item.unit}</span></td>
              <td className="num" style={{color:T.muted}}>{fmtR(r.shortfall*(r.item.open_cost||0))}</td>
              <td style={{whiteSpace:"nowrap"}}>
                {r.neededBy ? (<>
                  <div className="mono" style={{fontSize:12,fontWeight:700,
                    color: r.daysUntil<=0 ? T.danger : r.daysUntil<=3 ? T.warn : T.cream}}>
                    {r.neededBy}
                  </div>
                  <div style={{fontSize:10,color:T.muted,marginTop:1}}>
                    {r.daysUntil<0  ? `${Math.abs(r.daysUntil)} day${Math.abs(r.daysUntil)===1?"":"s"} overdue`
                     : r.daysUntil===0 ? "today"
                     : `in ${r.daysUntil} day${r.daysUntil===1?"":"s"}`}
                  </div>
                </>) : <span style={{color:T.border}}>&mdash;</span>}
              </td>
              <td style={{fontSize:11,color:T.muted,lineHeight:1.6,minWidth:170}}>
                {r.sources.map((s,i)=>(
                  <div key={i}>
                    <span className="mono" style={{color:T.muted}}>{s.date}</span>
                    {"  "}{s.name}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="info-box" style={{marginTop:12}}>
        <span style={{fontSize:11,color:T.muted}}>Estimated cost to cover job shortfalls</span>
        <strong style={{fontFamily:"'Space Mono'",color:T.warn}}>{fmtR(forecastValue)}</strong>
      </div>
    </>)}

  </>);
}


// ─── DATE UTILITIES FOR SCHEDULING ───────────────────────────────────────────
const parseDMY = s => { if(!s) return null; const[d,m,y]=s.split("/").map(Number); return new Date(y,m-1,d); };
const fmtDMY   = dt => `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${dt.getFullYear()}`;
// DD/MM/YYYY -> YYYY-MM-DD (2026-08-26, Internal Invoicing) — job dates in
// this app are all DD/MM/YYYY text, but the get_employee_hourly_rate/
// get_maintenance_department_cost RPCs take a real Postgres `date`, which
// PostgREST expects as ISO. Distinct from Projects' own dates, which are
// already ISO via <input type="date">.
const dmyToIso = s => { const d = parseDMY(s); if(!d) return null; return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const addPeriod = (dt,type,n) => {
  const d = new Date(dt.getTime());
  if(type==="days")   d.setDate(d.getDate()+n);
  if(type==="weeks")  d.setDate(d.getDate()+n*7);
  if(type==="months") d.setMonth(d.getMonth()+n);
  return d;
};
// End of an N-working-day window from today (skips Sat/Sun)
const workingDaysAhead = n => {
  const d = new Date(); d.setHours(0,0,0,0);
  let added = 0;
  while(added < n){
    d.setDate(d.getDate()+1);
    const day = d.getDay();
    if(day!==0 && day!==6) added++;
  }
  return d;
};
const startOfToday = () => { const d=new Date(); d.setHours(0,0,0,0); return d; };
const sameDay = (a,b) => a && b && a.getDate()===b.getDate() && a.getMonth()===b.getMonth() && a.getFullYear()===b.getFullYear();
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_NAMES   = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const FORECAST_DAYS = 10; // 2 working weeks

const JOB_TYPES = [
  {id:"preventive", label:"Preventive"},
  {id:"reactive",   label:"Reactive / Breakdown"},
  {id:"inspection", label:"Inspection"},
  {id:"other",      label:"Other"},
];
const RECURRENCE = [
  {id:"none",   label:"Once off"},
  {id:"days",   label:"Every N days"},
  {id:"weeks",  label:"Every N weeks"},
  {id:"months", label:"Every N months"},
];
const recurLabel = (t,n) => {
  if(t==="none"||!n) return "Once off";
  const unit = t==="days"?"day":t==="weeks"?"week":"month";
  return n===1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
};

// Current available stock for an item (same maths as elsewhere in the app)
const availableStock = (item, purchases, issues) => {
  const b   = purchases.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
  const iss = issues.filter(x=>x.item_id===item.id).reduce((s,x)=>s+(x.qty||0),0);
  return (item.open_qty||0)+b-iss;
};

// ─── MATERIAL FORECAST ───────────────────────────────────────────────────────
// Open jobs inside the window count once. Recurring templates then project
// additional (unsaved) occurrences inside the same window so a weekly job
// counts twice over two weeks without cluttering the calendar.
function buildForecast({ jobs, jobMaterials, templates, templateMaterials, items, purchases, issues }) {
  const windowEnd = workingDaysAhead(FORECAST_DAYS);
  const todayD    = startOfToday();
  const demand    = {};   // item_id -> { qty, sources:Set }

  const add = (itemId, qty, name, date) => {
    if(!demand[itemId]) demand[itemId] = { qty:0, sources:new Map() };
    demand[itemId].qty += qty;
    // key on job + date so the same job on two dates shows as two lines
    demand[itemId].sources.set(`${name}|${date}`, { name, date });
  };

  // 1. Real open jobs due inside the window (overdue ones count too)
  const openJobs = jobs.filter(j=>j.status==="scheduled"||j.status==="in_progress");
  openJobs.forEach(job=>{
    const due = parseDMY(job.due_date);
    if(!due || due > windowEnd) return;
    jobMaterials.filter(m=>m.job_id===job.id).forEach(m=>add(m.item_id, m.qty_planned||0, job.name, job.due_date));
  });

  // 2. Projected extra occurrences from recurring templates
  templates.filter(t=>t.active!==false && t.recurrence_type!=="none" && t.recurrence_n>0).forEach(t=>{
    const mats = templateMaterials.filter(m=>m.template_id===t.id);
    if(!mats.length) return;
    // Start from the template's open job if there is one, else its next_due
    const openForT = openJobs.find(j=>j.template_id===t.id);
    let cursor = openForT ? parseDMY(openForT.due_date) : parseDMY(t.next_due);
    if(!cursor) return;
    // Step forward; every occurrence AFTER the first that lands in the window is extra
    let guard = 0;
    while(guard++ < 60){
      cursor = addPeriod(cursor, t.recurrence_type, t.recurrence_n);
      if(cursor > windowEnd) break;
      if(cursor < todayD) continue;
      mats.forEach(m=>add(m.item_id, m.qty||0, `${t.name} (projected)`, fmtDMY(cursor)));
    }
  });

  // 3. Compare against available stock
  return Object.entries(demand).map(([itemId,d])=>{
    const item = items.find(i=>i.id===itemId);
    if(!item) return null;
    const avail = availableStock(item, purchases, issues);
    const sources = [...d.sources.values()].sort((a,b)=>{
      const da=parseDMY(a.date), db=parseDMY(b.date);
      return (da?da.getTime():0)-(db?db.getTime():0);
    });
    const neededBy = sources.length ? sources[0].date : null;
    return {
      item, needed:d.qty, available:avail,
      shortfall: Math.max(0, d.qty - avail),
      sources, neededBy,
      daysUntil: neededBy ? Math.round((parseDMY(neededBy) - todayD)/86400000) : null,
    };
  }).filter(Boolean).filter(r=>r.shortfall>0).sort((a,b)=>{
    // Most urgent deadline first, then biggest shortfall
    const da=parseDMY(a.neededBy), db=parseDMY(b.neededBy);
    const ta=da?da.getTime():Infinity, tb=db?db.getTime():Infinity;
    if(ta!==tb) return ta-tb;
    return b.shortfall-a.shortfall;
  });
}

// ─── CALENDAR ────────────────────────────────────────────────────────────────
function Calendar({ locId, jobs, jobMaterials, items, purchases, issues, destinations,
                    templates, setJobs, setJobMaterials, setIssues, setTemplates, isAdmin, companyId,
                    projects, workstreamStatus, progressLogs, workstreams, hrEmployees }) {
  const [cursor, setCursor]     = useState(()=>{ const d=new Date(); return new Date(d.getFullYear(),d.getMonth(),1); });
  const [view, setView]         = useState("month");   // month | list
  const [openJob, setOpenJob]   = useState(null);
  const [showAdHoc, setShowAdHoc] = useState(false);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [dragging, setDragging] = useState(false);

  const todayD = startOfToday();

  const rescheduleJob = async (jobId, newDate) => {
    const job = jobs.find(j=>j.id===jobId);
    if(!job || job.due_date===newDate) return;
    if(job.status!=="scheduled" && job.status!=="in_progress") return; // guard, shouldn't happen given draggable is gated already
    try{
      await sb.update("maint_jobs", jobId, {due_date:newDate});
      setJobs(p=>p.map(j=>j.id===jobId?{...j,due_date:newDate}:j));
    }catch(e){ alert("Could not reschedule: "+e.message); }
  };

  // Build month grid (Mon-first)
  const grid = useMemo(()=>{
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startPad = (first.getDay()+6)%7;              // Mon=0
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth()+1, 0).getDate();
    const cells = [];
    for(let i=0;i<startPad;i++) cells.push(null);
    for(let d=1;d<=daysInMonth;d++) cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
    while(cells.length%7!==0) cells.push(null);
    return cells;
  },[cursor]);

  const jobsOn = dt => jobs.filter(j=>sameDay(parseDMY(j.due_date), dt));

  // Project activity (2026-08-19) — unioned in at render time from live
  // data, never written as static maint_jobs/calendar rows, so it always
  // reflects current reality rather than a stale snapshot. Three kinds:
  // each project's own target_end_date, each workstream's live
  // projected_finish_date (from project_workstream_status), and each
  // logged week of progress (project_progress_logs) — so the calendar
  // gives a full picture of farm activity, not just job cards. Scoped to
  // the current location, same as jobs above.
  const parseISODate = d => d ? new Date(d+"T00:00:00") : null;
  const wsById = useMemo(()=>{ const m={}; (workstreams||[]).forEach(w=>{m[w.id]=w;}); return m; },[workstreams]);
  const projectLocIds = useMemo(()=>{ const m={}; (projects||[]).forEach(p=>{m[p.id]=p.location_id;}); return m; },[projects]);
  const milestones = useMemo(()=>{
    const list = [];
    (projects||[]).filter(p=>p.location_id===locId && p.target_end_date).forEach(p=>{
      list.push({ key:`proj-${p.id}`, date:p.target_end_date, label:`${p.name} — Target Finish`, kind:"project" });
    });
    (workstreamStatus||[]).filter(s=>s.location_id===locId && s.projected_finish_date).forEach(s=>{
      list.push({ key:`ws-${s.id}`, date:s.projected_finish_date, label:`${s.name} — Projected Finish`, kind:"workstream" });
    });
    (progressLogs||[]).forEach(l=>{
      const ws = wsById[l.workstream_id];
      if (!ws || projectLocIds[ws.project_id]!==locId) return;
      const crewNote = l.crew_size!=null?`, crew ${l.crew_size}`:"";
      list.push({ key:`log-${l.id}`, date:l.week_ending, label:`${ws.name}: ${fmtQty(l.qty_done, ws.unit)} logged${crewNote}`, kind:"progress" });
    });
    return list;
  },[projects, workstreamStatus, progressLogs, wsById, projectLocIds, locId]);
  const milestonesOn = dt => milestones.filter(m=>sameDay(parseISODate(m.date), dt));

  // Workstream date spans (2026-08-19) — Thijs wanted a workstream visible
  // across its whole run, not just as a single-day marker on its finish
  // date. Runs from baseline_date to its live projected_finish_date
  // (falls back to the project's target_end_date while there's no
  // progress logged yet to project from, and to today if neither is set
  // — so it never spans indefinitely). Rendered as a thin strip on every
  // day in range, separate from the point-in-time milestone/progress
  // markers above.
  const wsStatusById = useMemo(()=>{ const m={}; (workstreamStatus||[]).forEach(s=>{m[s.id]=s;}); return m; },[workstreamStatus]);
  const workstreamSpans = useMemo(()=>{
    const list = [];
    (workstreams||[]).forEach(w=>{
      if (projectLocIds[w.project_id]!==locId || !w.baseline_date) return;
      const s = wsStatusById[w.id];
      const endStr = s?.projected_finish_date || s?.project_target_end_date || w.baseline_date;
      const start = parseISODate(w.baseline_date), end = parseISODate(endStr);
      if (!start || !end || end<start) return;
      list.push({ id:w.id, name:w.name, start, end });
    });
    return list;
  },[workstreams, wsStatusById, projectLocIds, locId]);
  const spansOn = dt => workstreamSpans.filter(sp=>dt>=sp.start && dt<=sp.end);

  const statusOf = job => {
    if(job.status==="completed") return "completed";
    if(job.status==="cancelled") return "cancelled";
    const due = parseDMY(job.due_date);
    return due && due < todayD ? "overdue" : "scheduled";
  };
  const statusColor = s => s==="completed" ? T.ok : s==="overdue" ? T.danger : s==="cancelled" ? T.muted : T.gold;

  const upcoming = useMemo(()=>{
    return jobs
      .filter(j=>j.status!=="cancelled")
      .sort((a,b)=>{
        const da=parseDMY(a.due_date), db=parseDMY(b.due_date);
        return (da?da.getTime():0)-(db?db.getTime():0);
      });
  },[jobs]);

  const openCount     = jobs.filter(j=>j.status==="scheduled"||j.status==="in_progress").length;
  const overdueCount  = jobs.filter(j=>statusOf(j)==="overdue").length;
  const doneThisMonth = jobs.filter(j=>{
    if(j.status!=="completed"||!j.completed_date) return false;
    const c=parseDMY(j.completed_date);
    return c && c.getMonth()===new Date().getMonth() && c.getFullYear()===new Date().getFullYear();
  }).length;

  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Open Jobs</div><div className="strip-val">{openCount}</div></div>
      <div className="strip-item"><div className="strip-label">Overdue</div>
        <div className="strip-val" style={{color:overdueCount>0?T.danger:T.ok}}>{overdueCount}</div></div>
      <div className="strip-item"><div className="strip-label">Done This Month</div><div className="strip-val">{doneThisMonth}</div></div>
      <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap"}}>
        <button className="btn btn-ghost" onClick={()=>setView(v=>v==="month"?"list":"month")}>
          {view==="month"?"List view":"Month view"}
        </button>
        <button className="btn btn-primary" onClick={()=>setShowAdHoc(true)}>+ Log Job</button>
      </div>
    </div>

    {view==="month" ? (<>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <button className="btn btn-ghost btn-sm" onClick={()=>setCursor(c=>new Date(c.getFullYear(),c.getMonth()-1,1))}>&#8592; Prev</button>
        <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:19,fontWeight:600,color:T.cream}}>
          {MONTH_NAMES[cursor.getMonth()]} {cursor.getFullYear()}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={()=>setCursor(c=>new Date(c.getFullYear(),c.getMonth()+1,1))}>Next &#8594;</button>
      </div>

      <div className="cal-grid">
        {DAY_NAMES.map(d=><div key={d} className="cal-head">{d}</div>)}
        {grid.map((dt,i)=>{
          if(!dt) return <div key={i} className="cal-cell cal-empty"/>;
          const dayJobs = jobsOn(dt);
          const isToday = sameDay(dt, todayD);
          const dateKey = fmtDMY(dt);
          const isDragOver = dragOverKey===dateKey;
          return (
            <div key={i} className={`cal-cell${isToday?" cal-today":""}${isDragOver?" cal-drop-target":""}`}
              onDragOver={e=>{ if(isAdmin){ e.preventDefault(); setDragOverKey(dateKey); } }}
              onDragLeave={()=>{ if(dragOverKey===dateKey) setDragOverKey(null); }}
              onDrop={e=>{
                e.preventDefault(); setDragOverKey(null); setDragging(false);
                const jobId = e.dataTransfer.getData("text/plain");
                if(jobId) rescheduleJob(jobId, dateKey);
              }}>
              <div className="cal-date">{dt.getDate()}</div>
              {spansOn(dt).length>0 && (
                <div title={spansOn(dt).map(sp=>sp.name).join(", ")}
                  style={{height:4,borderRadius:2,background:T.ok,opacity:.55,marginBottom:3}}/>
              )}
              {dayJobs.slice(0,3).map(j=>{
                const st=statusOf(j);
                const canDrag = isAdmin && (st==="scheduled"||st==="overdue");
                return (
                  <button key={j.id} className="cal-job" onClick={()=>setOpenJob(j)}
                    draggable={canDrag}
                    onDragStart={e=>{ e.dataTransfer.setData("text/plain", j.id); e.dataTransfer.effectAllowed="move"; setDragging(true); }}
                    onDragEnd={()=>{ setDragging(false); setDragOverKey(null); }}
                    style={{borderLeft:`3px solid ${statusColor(st)}`,
                            color:st==="completed"?T.muted:T.cream,
                            textDecoration:st==="completed"?"line-through":"none",
                            cursor:canDrag?"grab":"pointer"}}>
                    {j.name}
                  </button>
                );
              })}
              {dayJobs.length>3 && <div style={{fontSize:9,color:T.muted,paddingLeft:4}}>+{dayJobs.length-3} more</div>}
              {milestonesOn(dt).map(m=>(
                <div key={m.key} className="cal-job" title={m.label}
                  style={m.kind==="progress"
                    ?{borderLeft:`3px solid ${T.ok}`,color:T.ok,cursor:"default"}
                    :{borderLeft:`3px dashed ${T.gold}`,color:T.gold,fontStyle:"italic",cursor:"default"}}>
                  {m.kind==="progress"?"●":"◆"} {m.label}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {isAdmin && (
        <div style={{fontSize:11,color:T.muted,marginTop:8}}>
          Tip: drag a scheduled job onto another date to reschedule it.
        </div>
      )}
    </>) : (
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>Due</th><th>Job</th><th>Type</th><th>Where</th><th>Assigned</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {upcoming.map(j=>{
            const st=statusOf(j);
            return (
              <tr key={j.id}>
                <td className="mono" style={{fontSize:11}}>{j.due_date}</td>
                <td style={{fontWeight:600}}>
                  {j.name}
                  {j.vehicle_id && <span className="badge badge-neu" style={{marginLeft:7}}>Vehicle</span>}
                </td>
                <td style={{fontSize:11,color:T.muted}}>{JOB_TYPES.find(t=>t.id===j.job_type)?.label||j.job_type}</td>
                <td style={{fontSize:12,color:T.muted}}>{j.dest_name||"—"}</td>
                <td style={{fontSize:12,color:T.muted}}>{j.assigned_to||"—"}</td>
                <td>
                  <span className="badge" style={{background:`${statusColor(st)}22`,color:statusColor(st),border:`1px solid ${statusColor(st)}55`}}>
                    {st==="overdue"?"Overdue":st==="completed"?"Done":st==="cancelled"?"Cancelled":"Scheduled"}
                  </span>
                </td>
                <td><button className="btn btn-ghost btn-sm" onClick={()=>setOpenJob(j)}>Open</button></td>
              </tr>
            );
          })}
          {upcoming.length===0&&<tr><td colSpan={7} className="empty">No jobs scheduled yet</td></tr>}
        </tbody>
      </table></div>
    )}

    {milestones.length>0 && (
      <div style={{marginTop:22}}>
        <div className="section-title">Project Activity <span style={{color:T.muted,fontWeight:400}}>({milestones.length})</span></div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Date</th><th>Activity</th><th>Type</th></tr></thead>
          <tbody>
            {[...milestones].sort((a,b)=>b.date.localeCompare(a.date)).map(m=>{
              const color = m.kind==="progress"?T.ok:T.gold;
              const typeLabel = m.kind==="progress"?"Logged Progress":m.kind==="project"?"Project Target":"Workstream Projection";
              return (
                <tr key={m.key}>
                  <td className="mono" style={{fontSize:11,color}}>{fmtDMY(parseISODate(m.date))}</td>
                  <td style={{color, fontStyle:m.kind==="progress"?"normal":"italic"}}>
                    {m.kind==="progress"?"●":"◆"} {m.label}
                  </td>
                  <td><span className="badge badge-neu">{typeLabel}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
    )}

    {openJob && (
      <JobDetail job={openJob} onClose={()=>setOpenJob(null)}
        locId={locId} jobs={jobs} jobMaterials={jobMaterials} items={items}
        purchases={purchases} issues={issues} templates={templates} destinations={destinations}
        setJobs={setJobs} setJobMaterials={setJobMaterials} setIssues={setIssues}
        setTemplates={setTemplates} isAdmin={isAdmin} companyId={companyId} hrEmployees={hrEmployees}/>
    )}

    {showAdHoc && (
      <AdHocJob locId={locId} items={items} destinations={destinations}
        setJobs={setJobs} setJobMaterials={setJobMaterials} onClose={()=>setShowAdHoc(false)} companyId={companyId} hrEmployees={hrEmployees}/>
    )}
  </>);
}

// ─── JOB DETAIL ──────────────────────────────────────────────────────────────
function JobDetail({ job, onClose, locId, jobs, jobMaterials, items, purchases, issues,
                     templates, destinations, setJobs, setJobMaterials, setIssues, setTemplates, isAdmin, companyId, hrEmployees }) {
  const [completing, setCompleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const mats = jobMaterials.filter(m=>m.job_id===job.id);
  const isOpen = job.status==="scheduled"||job.status==="in_progress";

  const cancel = async () => {
    if(!window.confirm("Cancel this job?")) return;
    try{
      await sb.update("maint_jobs", job.id, {status:"cancelled"});
      setJobs(p=>p.map(j=>j.id===job.id?{...j,status:"cancelled"}:j));
      onClose();
    }catch(e){ alert("Error: "+e.message); }
  };

  const remove = async () => {
    if(!window.confirm("Delete this job permanently?")) return;
    try{
      await sb.delete("maint_jobs", job.id);
      setJobs(p=>p.filter(j=>j.id!==job.id));
      setJobMaterials(p=>p.filter(m=>m.job_id!==job.id));
      onClose();
    }catch(e){ alert("Error: "+e.message); }
  };

  if(completing) return (
    <CompleteJob job={job} mats={mats} items={items} purchases={purchases} issues={issues}
      locId={locId} templates={templates} hrEmployees={hrEmployees}
      setJobs={setJobs} setJobMaterials={setJobMaterials} setIssues={setIssues} setTemplates={setTemplates}
      onDone={()=>{setCompleting(false);onClose();}} onBack={()=>setCompleting(false)} companyId={companyId}/>
  );

  if(editing) return (
    <EditJob job={job} mats={mats} items={items} destinations={destinations}
      setJobs={setJobs} setJobMaterials={setJobMaterials} hrEmployees={hrEmployees}
      onDone={()=>{setEditing(false);onClose();}} onBack={()=>setEditing(false)} companyId={companyId}/>
  );

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-title">
          {job.name}
          {job.vehicle_id && <span className="badge badge-neu" style={{marginLeft:9,verticalAlign:"middle"}}>Vehicle Service</span>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 16px",marginBottom:14}}>
          {[["Due date",job.due_date],
            ["Type",JOB_TYPES.find(t=>t.id===job.job_type)?.label||job.job_type],
            ["Where",job.dest_name||"—"],
            ["Assigned to",job.assigned_to||"—"]].map(([l,v])=>(
            <div key={l} style={{padding:"7px 0",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:9,letterSpacing:".12em",textTransform:"uppercase",color:T.muted,fontWeight:600,marginBottom:2}}>{l}</div>
              <div style={{fontSize:13,fontWeight:600,color:T.cream}}>{v}</div>
            </div>
          ))}
        </div>

        {job.description && (
          <div style={{background:"rgba(0,0,0,.25)",border:`1px solid ${T.border}`,borderRadius:7,padding:"11px 13px",marginBottom:14}}>
            <div style={{fontSize:9,letterSpacing:".1em",textTransform:"uppercase",color:T.muted,fontWeight:600,marginBottom:5}}>Description</div>
            <div style={{fontSize:13,color:T.cream,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{job.description}</div>
          </div>
        )}

        <div className="section-title">Materials Required</div>
        {mats.length===0 ? (
          <div style={{fontSize:12,color:T.muted,marginBottom:14}}>No materials planned for this job.</div>
        ) : (
          <div className="tbl-wrap" style={{marginBottom:14}}><table className="tbl" style={{minWidth:0}}>
            <thead><tr><th>Item</th><th className="num">Needed</th><th className="num">In Stock</th><th>Status</th></tr></thead>
            <tbody>
              {mats.map(m=>{
                const item = items.find(i=>i.id===m.item_id);
                if(!item) return null;
                const avail = availableStock(item, purchases, issues);
                const short = (m.qty_planned||0) - avail;
                return (
                  <tr key={m.id}>
                    <td style={{fontWeight:600}}>{item.description}</td>
                    <td className="num">{fmtN(m.qty_planned)} <span style={{fontSize:10,color:T.muted}}>{item.unit}</span></td>
                    <td className="num" style={{color:T.muted}}>{fmtN(avail)}</td>
                    <td>{short>0
                      ? <span className="badge badge-bad">Short {fmtN(short)}</span>
                      : <span className="badge badge-ok">Available</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}

        {job.status==="completed" && (
          <div className="info-box" style={{background:"rgba(90,155,114,.1)",border:`1px solid rgba(90,155,114,.3)`}}>
            <span style={{fontSize:11,color:T.muted}}>Completed</span>
            <strong style={{color:T.ok,fontFamily:"'Space Mono'"}}>{job.completed_date}</strong>
          </div>
        )}
        {job.completion_notes && (
          <div style={{fontSize:12,color:T.muted,marginBottom:12}}>
            <strong style={{color:T.cream}}>Notes:</strong> {job.completion_notes}
          </div>
        )}

        <div style={{display:"flex",gap:9,flexWrap:"wrap"}}>
          {isOpen && <button className="btn btn-primary" onClick={()=>setCompleting(true)}>Complete Job</button>}
          {isOpen && isAdmin && <button className="btn btn-ghost" onClick={()=>setEditing(true)}>Edit</button>}
          {isOpen && isAdmin && <button className="btn btn-ghost" onClick={cancel}>Cancel Job</button>}
          {isAdmin && <button className="btn btn-danger" onClick={remove}>Delete</button>}
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── COMPLETE JOB ────────────────────────────────────────────────────────────
function CompleteJob({ job, mats, items, purchases, issues, locId, templates, hrEmployees,
                       setJobs, setJobMaterials, setIssues, setTemplates, onDone, onBack, companyId }) {
  const [date, setDate]   = useState(today());
  const [notes, setNotes] = useState("");
  const [used, setUsed]   = useState(()=>{
    const m={}; mats.forEach(x=>m[x.id]=String(x.qty_planned||0)); return m;
  });
  const [extras, setExtras] = useState([]); // [{item_id, qty}] — unplanned materials
  const [odometer, setOdometer] = useState("");
  const [busy, setBusy]   = useState(false);

  // Who worked this job + hours (2026-08-25) — a tick-list of active
  // Maintenance-department staff (cross-app read of hr_employees, same
  // source as the Projects AI Suggestions panel), not gated to the job's
  // lodge or this week's rotation — deliberately broader, since limiting to
  // "on duty here today" risks silently hiding whoever actually helped.
  // Required before a job can be marked complete, so this data is reliably
  // captured from day one for later payroll/labor-cost reporting.
  const maintenanceStaff = useMemo(()=>
    (hrEmployees||[])
      .filter(e=>e.active && normalizeDepartment(e.department)==="Maintenance")
      .map(e=>({id:e.id, name:`${e.first_name||""} ${e.last_name||""}`.trim()||"(unnamed)"}))
      .sort((a,b)=>a.name.localeCompare(b.name))
  ,[hrEmployees]);
  const [ticked, setTicked]   = useState({}); // employee_id -> true
  const [hours, setHours]     = useState({}); // employee_id -> hours string
  const toggleStaff = id => setTicked(t=>({...t, [id]: !t[id]}));
  const laborRows = maintenanceStaff.filter(e=>ticked[e.id] && parseFloat(hours[e.id])>0);

  const plannedIds = new Set(mats.map(m=>m.item_id));
  const addExtra    = ()=>setExtras(r=>[...r,{item_id:"",qty:""}]);
  const updExtra     = (i,k,v)=>setExtras(r=>r.map((x,j)=>j===i?{...x,[k]:v}:x));
  const removeExtra  = i=>setExtras(r=>r.filter((_,j)=>j!==i));

  const save = async () => {
    if(laborRows.length===0){
      alert("Tick at least one employee who worked this job and enter their hours before completing it.");
      return;
    }
    setBusy(true);
    try{
      // 0. Log who worked it + how many hours each
      const laborInserts = laborRows.map(e=>({
        id: uid(), job_id: job.id, employee_id: e.id, employee_name: e.name,
        hours: parseFloat(hours[e.id]), company_id: companyId,
      }));
      for(const row of laborInserts) await sb.insert("maint_job_labor", row);
      // 1. Write a stock issue for each planned material actually used
      const newIssues = [];
      for(const m of mats){
        const qty = parseFloat(used[m.id])||0;
        if(qty<=0) continue;
        const row = {
          id: uid(), location_id: locId, item_id: m.item_id, date,
          qty, destination_id: job.destination_id||null,
          dest_name: job.dest_name||null,
          notes: `Job: ${job.name}`,
          company_id: companyId,
        };
        await sb.insert("maint_issues", row);
        newIssues.push(row);
        await sb.update("maint_job_materials", m.id, {qty_used:qty});
      }
      setJobMaterials(p=>p.map(m=>mats.find(x=>x.id===m.id)
        ? {...m, qty_used: parseFloat(used[m.id])||0} : m));

      // 2. Write extra materials that weren't on the original job card —
      //    both as a stock issue and as a new maint_job_materials row so the
      //    job's history shows everything that was actually used.
      const newJobMats = [];
      for(const ex of extras){
        const qty = parseFloat(ex.qty)||0;
        if(!ex.item_id || qty<=0) continue;
        const row = {
          id: uid(), location_id: locId, item_id: ex.item_id, date,
          qty, destination_id: job.destination_id||null,
          dest_name: job.dest_name||null,
          notes: `Job: ${job.name} (added at completion)`,
          company_id: companyId,
        };
        await sb.insert("maint_issues", row);
        newIssues.push(row);

        const jm = {id:uid(), job_id:job.id, item_id:ex.item_id, qty_planned:0, qty_used:qty, company_id: companyId};
        await sb.insert("maint_job_materials", jm);
        newJobMats.push(jm);
      }
      if(newIssues.length) setIssues(p=>[...p, ...newIssues]);
      if(newJobMats.length) setJobMaterials(p=>[...p, ...newJobMats]);

      // 3. Mark this job complete
      await sb.update("maint_jobs", job.id, {status:"completed", completed_date:date, completion_notes:notes||null});
      setJobs(p=>p.map(j=>j.id===job.id?{...j,status:"completed",completed_date:date,completion_notes:notes||null}:j));

      // 3a. Internal Invoicing (2026-08-26) — bill this job's labor +
      // material cost back to whichever site/destination it was done for.
      // Uses the labor rows and stock issues we just built above, so no
      // extra fetch is needed. Never blocks completion on failure.
      await generateJobInvoice({
        job, laborInserts, materialLines: newIssues,
        items, purchases, companyId, completedDate: date,
      });

      // 3b. This job was auto-created for a self-serviced vehicle (Operations
      // app) — completing it here needs to feed the service date (and
      // optionally the odometer) back into that vehicle's record, or the
      // Operations app will see it as still due and create another job card.
      if (job.vehicle_id) {
        const patch = { last_service_date: date };
        const km = parseFloat(odometer);
        if (!isNaN(km) && km > 0) patch.last_service_km = km;
        try { await sb.update("fleet", job.vehicle_id, patch); }
        catch(e) { console.error("Could not update vehicle service date:", e); }
      }

      // 4. If recurring, schedule the next one from the ACTUAL completion date
      const tpl = templates.find(t=>t.id===job.template_id);
      if(tpl && tpl.recurrence_type!=="none" && tpl.recurrence_n>0 && tpl.active!==false){
        const nextDue = fmtDMY(addPeriod(parseDMY(date), tpl.recurrence_type, tpl.recurrence_n));
        const nextJob = {
          id: uid(), location_id: locId, template_id: tpl.id, name: tpl.name,
          description: tpl.description||null, job_type: tpl.job_type||"preventive",
          destination_id: tpl.destination_id||null, dest_name: tpl.dest_name||null,
          assigned_to: tpl.assigned_to||null, due_date: nextDue, status:"scheduled",
          company_id: companyId,
        };
        await sb.insert("maint_jobs", nextJob);
        setJobs(p=>[...p, nextJob]);

        // Copy the template's material list onto the new job
        // (note: this deliberately does NOT carry forward one-off extras —
        // only the template's own planned list, so ad-hoc additions don't
        // silently become permanent parts of the recurring job)
        const tplMats = await sb.select("maint_template_materials", `template_id=eq.${tpl.id}&company_id=eq.${companyId}`);
        const nextMats = [];
        for(const tm of tplMats){
          const row = {id:uid(), job_id:nextJob.id, item_id:tm.item_id, qty_planned:+tm.qty, company_id: companyId};
          await sb.insert("maint_job_materials", row);
          nextMats.push(row);
        }
        if(nextMats.length) setJobMaterials(p=>[...p, ...nextMats]);

        await sb.update("maint_job_templates", tpl.id, {next_due: nextDue});
        setTemplates(p=>p.map(t=>t.id===tpl.id?{...t,next_due:nextDue}:t));
      }

      onDone();
    }catch(e){ alert("Could not complete job: "+e.message); }
    finally{ setBusy(false); }
  };

  const tpl = templates.find(t=>t.id===job.template_id);
  const willRepeat = tpl && tpl.recurrence_type!=="none" && tpl.recurrence_n>0;
  const nextPreview = willRepeat && date ? fmtDMY(addPeriod(parseDMY(date), tpl.recurrence_type, tpl.recurrence_n)) : null;

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onBack()}>
      <div className="modal">
        <div className="modal-title">Complete <span>{job.name}</span></div>

        {job.vehicle_id && (
          <div style={{background:"rgba(184,147,90,.06)",border:`1px solid rgba(184,147,90,.2)`,borderRadius:7,padding:"11px 13px",marginBottom:14}}>
            <div style={{fontSize:10,letterSpacing:".1em",textTransform:"uppercase",color:T.gold,fontWeight:700,marginBottom:6}}>Vehicle Service</div>
            <div style={{fontSize:11,color:T.muted,lineHeight:1.5,marginBottom:10}}>
              This updates the vehicle's Last Service Date in Operations automatically.
              Add the current odometer too if you know it, so the km-based service alert stays accurate.
            </div>
            <div className="field" style={{marginBottom:0}}>
              <label>Current Odometer (optional)</label>
              <input type="number" inputMode="decimal" min="0" placeholder="e.g. 84500" value={odometer} onChange={e=>setOdometer(e.target.value)}/>
            </div>
          </div>
        )}

        <div className="field"><label>Completion Date</label>
          <DateField value={date} onChange={setDate}/>
        </div>

        {mats.length>0 && (<>
          <div className="section-title">Materials Used</div>
          <div style={{fontSize:11,color:T.muted,marginBottom:10,lineHeight:1.5}}>
            Pre-filled with planned quantities. Adjust to what was actually used — this issues the stock.
          </div>
          <div className="tbl-wrap" style={{marginBottom:14}}><table className="tbl" style={{minWidth:0}}>
            <thead><tr><th>Item</th><th className="num">Planned</th><th className="num">Actually Used</th></tr></thead>
            <tbody>
              {mats.map(m=>{
                const item = items.find(i=>i.id===m.item_id);
                if(!item) return null;
                return (
                  <tr key={m.id}>
                    <td style={{fontWeight:600}}>{item.description} <span style={{fontSize:10,color:T.muted}}>({item.unit})</span></td>
                    <td className="num" style={{color:T.muted}}>{fmtN(m.qty_planned)}</td>
                    <td className="num">
                      <input className="count-input" type="number" inputMode="decimal" value={used[m.id]??""}
                        onChange={e=>setUsed(u=>({...u,[m.id]:e.target.value}))}/>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        </>)}

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
          <div className="section-title" style={{margin:0}}>Additional Materials Used</div>
          <button className="btn btn-ghost btn-sm" onClick={addExtra}>+ Add Item</button>
        </div>
        <div style={{fontSize:11,color:T.muted,marginBottom:10,lineHeight:1.5}}>
          Anything used that wasn't on the original job card &mdash; this also issues the stock.
        </div>
        {extras.length===0 && (
          <div style={{fontSize:11,color:T.muted,marginBottom:14}}>Nothing added.</div>
        )}
        {extras.length>0 && (
          <div style={{marginBottom:14}}>
            {extras.map((ex,i)=>(
              <div key={i} style={{display:"flex",gap:7,marginBottom:7,alignItems:"center"}}>
                <SearchableSelect
                  value={ex.item_id}
                  onChange={v=>updExtra(i,"item_id",v)}
                  options={items.map(it=>({value:it.id,label:`${it.description} (${it.unit})${plannedIds.has(it.id)?" — already on card":""}`}))}
                  placeholder="-- Select item --"
                  style={{flex:1}}
                  inputStyle={{...searchSelectInput,padding:"9px 10px",fontSize:14}}
                />
                <input className="count-input" type="number" inputMode="decimal" placeholder="Qty" value={ex.qty}
                  onChange={e=>updExtra(i,"qty",e.target.value)}/>
                <button className="btn btn-danger btn-sm" onClick={()=>removeExtra(i)}>x</button>
              </div>
            ))}
          </div>
        )}

        <div className="section-title">Who Worked This Job</div>
        <div style={{fontSize:11,color:T.muted,marginBottom:10,lineHeight:1.5}}>
          Tick everyone who worked on it and enter their hours — required before the job can be marked complete.
        </div>
        {maintenanceStaff.length===0 && (
          <div style={{fontSize:11,color:T.muted,marginBottom:14}}>
            No active Maintenance-department staff found. Add them in HR/Linen first.
          </div>
        )}
        {maintenanceStaff.length>0 && (
          <div style={{marginBottom:14}}>
            {maintenanceStaff.map(e=>(
              <div key={e.id} style={{display:"flex",gap:9,alignItems:"center",marginBottom:7}}>
                <label style={{display:"flex",gap:8,alignItems:"center",cursor:"pointer",flex:1}}>
                  <input type="checkbox" checked={!!ticked[e.id]} onChange={()=>toggleStaff(e.id)}/>
                  <span style={{fontSize:13,color:T.cream}}>{e.name}</span>
                </label>
                <input className="count-input" type="number" inputMode="decimal" step="0.5" placeholder="Hours"
                  disabled={!ticked[e.id]} value={hours[e.id]||""}
                  onChange={ev=>setHours(h=>({...h,[e.id]:ev.target.value}))}/>
              </div>
            ))}
          </div>
        )}

        <div className="field"><label>Completion Notes</label>
          <textarea rows={3} value={notes} onChange={e=>setNotes(e.target.value)}
            placeholder="What was done, anything to flag..."/>
        </div>

        {willRepeat && (
          <div className="info-box">
            <span style={{fontSize:11,color:T.muted}}>Next occurrence will be scheduled for</span>
            <strong style={{fontFamily:"'Space Mono'",color:T.gold}}>{nextPreview}</strong>
          </div>
        )}

        <div style={{display:"flex",gap:9}}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy?"Saving...":"Confirm Complete"}
          </button>
          <button className="btn btn-ghost" onClick={onBack} disabled={busy}>Back</button>
        </div>
      </div>
    </div>
  );
}

// ─── AD-HOC JOB ──────────────────────────────────────────────────────────────
function AdHocJob({ locId, items, destinations, setJobs, setJobMaterials, onClose, companyId, hrEmployees }) {
  const locDests = destinations.filter(d=>d.location_id===locId).sort((a,b)=>a.sort_order-b.sort_order);
  const blank = {name:"",description:"",job_type:"reactive",destination_id:"",assigned_to:"",due_date:today()};
  const [form,setForm] = useState(blank);
  const [rows,setRows] = useState([]);   // {item_id, qty}
  const [busy,setBusy] = useState(false);
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));

  const save = async () => {
    if(!form.name.trim()) return;
    setBusy(true);
    try{
      const dest = locDests.find(d=>d.id===form.destination_id);
      const job = {
        id:uid(), location_id:locId, template_id:null, name:form.name.trim(),
        description:form.description||null, job_type:form.job_type,
        destination_id:form.destination_id||null, dest_name:dest?.name||null,
        assigned_to:form.assigned_to||null, due_date:form.due_date, status:"scheduled",
        company_id: companyId,
      };
      await sb.insert("maint_jobs", job);
      setJobs(p=>[...p, job]);

      const newMats=[];
      for(const r of rows){
        if(!r.item_id||!(parseFloat(r.qty)>0)) continue;
        const m={id:uid(), job_id:job.id, item_id:r.item_id, qty_planned:parseFloat(r.qty), company_id: companyId};
        await sb.insert("maint_job_materials", m);
        newMats.push(m);
      }
      if(newMats.length) setJobMaterials(p=>[...p,...newMats]);
      onClose();
    }catch(e){ alert("Save failed: "+e.message); }
    finally{ setBusy(false); }
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-title">Log <span>Job</span></div>
        <div className="field"><label>Job Name</label>
          <input type="text" value={form.name} onChange={f("name")} placeholder="e.g. Replace geyser element Room 2"/>
        </div>
        <div className="grid2">
          <div className="field"><label>Due Date</label>
            <DateField value={form.due_date} onChange={v=>setForm(p=>({...p,due_date:v}))}/>
          </div>
          <div className="field"><label>Job Type</label>
            <select value={form.job_type} onChange={f("job_type")}>
              {JOB_TYPES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Where</label>
            <select value={form.destination_id} onChange={f("destination_id")}>
              <option value="">-- Select --</option>
              {locDests.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Assigned To</label>
            <AssignedToField hrEmployees={hrEmployees} value={form.assigned_to} onChange={v=>setForm(p=>({...p,assigned_to:v}))}/>
          </div>
        </div>
        <div className="field"><label>Description</label>
          <textarea rows={2} value={form.description} onChange={f("description")}/>
        </div>

        <MaterialPicker items={items} rows={rows} setRows={setRows}/>

        <div style={{display:"flex",gap:9,marginTop:4}}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy?"Saving...":"Save Job"}</button>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── EDIT JOB (Admin) ─────────────────────────────────────────────────────────
// Edits an existing scheduled job instance -- its own date/details/materials,
// not the recurring template it may have come from. Only available while the
// job is still scheduled/in_progress; completed jobs are historical record.
function EditJob({ job, mats, items, destinations, setJobs, setJobMaterials, onDone, onBack, companyId, hrEmployees }) {
  const locDests = destinations.filter(d=>d.location_id===job.location_id).sort((a,b)=>a.sort_order-b.sort_order);
  const [form,setForm] = useState({
    name:job.name, description:job.description||"", job_type:job.job_type||"preventive",
    destination_id:job.destination_id||"", assigned_to:job.assigned_to||"", due_date:job.due_date,
  });
  const [rows,setRows] = useState(()=>mats.map(m=>{
    const it = items.find(x=>x.id===m.item_id);
    return {id:m.id, item_id:m.item_id, qty:String(m.qty_planned), category:it?.category||"__none__"};
  }));
  const [busy,setBusy] = useState(false);
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));

  const save = async () => {
    if(!form.name.trim()) return;
    setBusy(true);
    try{
      const dest = locDests.find(d=>d.id===form.destination_id);
      const patch = {
        name:form.name.trim(), description:form.description||null, job_type:form.job_type,
        destination_id:form.destination_id||null, dest_name:dest?.name||null,
        assigned_to:form.assigned_to||null, due_date:form.due_date,
      };
      await sb.update("maint_jobs", job.id, patch);
      setJobs(p=>p.map(j=>j.id===job.id?{...j,...patch}:j));

      // Replace the material list wholesale rather than trying to diff it --
      // simplest and matches how templates handle their own material edits.
      for(const m of mats) await sb.delete("maint_job_materials", m.id);
      const newMats=[];
      for(const r of rows){
        if(!r.item_id||!(parseFloat(r.qty)>0)) continue;
        const m={id:uid(), job_id:job.id, item_id:r.item_id, qty_planned:parseFloat(r.qty), company_id: companyId};
        await sb.insert("maint_job_materials", m);
        newMats.push(m);
      }
      setJobMaterials(p=>[...p.filter(m=>m.job_id!==job.id), ...newMats]);
      onDone();
    }catch(e){ alert("Save failed: "+e.message); }
    finally{ setBusy(false); }
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onBack()}>
      <div className="modal">
        <div className="modal-title">Edit <span>{job.name}</span></div>
        {job.template_id && (
          <div style={{fontSize:11,color:T.muted,marginBottom:14,lineHeight:1.5}}>
            This job came from a recurring template. Changes here affect only this occurrence --
            the template itself is unchanged, and future occurrences will still follow it.
          </div>
        )}
        <div className="field"><label>Job Name</label>
          <input type="text" value={form.name} onChange={f("name")}/>
        </div>
        <div className="grid2">
          <div className="field"><label>Due Date</label>
            <DateField value={form.due_date} onChange={v=>setForm(p=>({...p,due_date:v}))}/>
          </div>
          <div className="field"><label>Job Type</label>
            <select value={form.job_type} onChange={f("job_type")}>
              {JOB_TYPES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Where</label>
            <select value={form.destination_id} onChange={f("destination_id")}>
              <option value="">-- Select --</option>
              {locDests.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Assigned To</label>
            <AssignedToField hrEmployees={hrEmployees} value={form.assigned_to} onChange={v=>setForm(p=>({...p,assigned_to:v}))}/>
          </div>
        </div>
        <div className="field"><label>Description</label>
          <textarea rows={2} value={form.description} onChange={f("description")}/>
        </div>

        <MaterialPicker items={items} rows={rows} setRows={setRows}/>

        <div style={{display:"flex",gap:9,marginTop:4}}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy?"Saving...":"Save Changes"}</button>
          <button className="btn btn-ghost" onClick={onBack} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── ASSIGNED TO (shared) ─────────────────────────────────────────────────────
// A dropdown of active Maintenance-department staff (2026-08-25), same
// cross-app hr_employees read/filter as CompleteJob's labor tick-list and
// the Projects AI Suggestions panel — reused here rather than duplicated.
// Job Card's assigned_to column stays plain text (no FK, no migration), so
// this writes the picked name straight into it; "Other…" reveals a text
// input for a name not on the Maintenance staff list (a contractor, a
// manager filling in, etc.) so nothing that worked before is lost.
function maintenanceStaffNames(hrEmployees) {
  return (hrEmployees||[])
    .filter(e=>e.active && normalizeDepartment(e.department)==="Maintenance")
    .map(e=>`${e.first_name||""} ${e.last_name||""}`.trim()||"(unnamed)")
    .sort((a,b)=>a.localeCompare(b));
}

function AssignedToField({ hrEmployees, value, onChange }) {
  const names = useMemo(()=>maintenanceStaffNames(hrEmployees),[hrEmployees]);
  const [showOther, setShowOther] = useState(()=>!!value && !names.includes(value));

  return (<>
    <select value={showOther?"__other__":(value||"")} onChange={e=>{
      if(e.target.value==="__other__"){ setShowOther(true); onChange(""); }
      else { setShowOther(false); onChange(e.target.value); }
    }}>
      <option value="">-- Unassigned --</option>
      {names.map(n=><option key={n} value={n}>{n}</option>)}
      <option value="__other__">Other…</option>
    </select>
    {showOther && (
      <input type="text" value={value} onChange={e=>onChange(e.target.value)}
        placeholder="Name" style={{marginTop:6}}/>
    )}
  </>);
}

// ─── CREW PICKER (shared) ─────────────────────────────────────────────────────
// Who's on the crew for a workstream's weekly progress log (2026-08-25) —
// replaces the old plain "Crew Size" number with real people: tick-list of
// active Maintenance-department staff (same hr_employees source as
// AssignedToField/CompleteJob) plus free-text "casual worker" entries for
// temp labor brought in when short-handed, which was the whole point of
// this ask. crew_size is auto-computed as the count of both put together,
// so project_workstream_status's rate/suggestion math keeps working
// unchanged — it just gets a real headcount instead of a typed guess.
function useMaintenanceStaffList(hrEmployees) {
  return useMemo(()=>
    (hrEmployees||[])
      .filter(e=>e.active && normalizeDepartment(e.department)==="Maintenance")
      .map(e=>({id:e.id, name:`${e.first_name||""} ${e.last_name||""}`.trim()||"(unnamed)"}))
      .sort((a,b)=>a.name.localeCompare(b.name))
  ,[hrEmployees]);
}

function CrewPicker({ hrEmployees, ticked, setTicked, casuals, setCasuals }) {
  const staff = useMaintenanceStaffList(hrEmployees);
  const toggle = id => setTicked(t=>({...t, [id]: !t[id]}));
  const addCasual    = ()=>setCasuals(c=>[...c,""]);
  const updCasual    = (i,v)=>setCasuals(c=>c.map((x,j)=>j===i?v:x));
  const removeCasual = i=>setCasuals(c=>c.filter((_,j)=>j!==i));
  const count = staff.filter(s=>ticked[s.id]).length + casuals.filter(c=>c.trim()).length;

  return (
    <div style={{marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <div className="section-title" style={{margin:0}}>Crew ({count})</div>
        <button className="btn btn-ghost btn-sm" onClick={addCasual}>+ Add Casual Worker</button>
      </div>
      {staff.length===0 && (
        <div style={{fontSize:11,color:T.muted,marginBottom:8}}>No active Maintenance-department staff on file.</div>
      )}
      {staff.length>0 && (
        <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:casuals.length?10:0}}>
          {staff.map(s=>(
            <label key={s.id} style={{display:"flex",alignItems:"center",gap:6,fontSize:12,
              background:"rgba(0,0,0,.25)",border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 10px",cursor:"pointer"}}>
              <input type="checkbox" checked={!!ticked[s.id]} onChange={()=>toggle(s.id)}/>
              {s.name}
            </label>
          ))}
        </div>
      )}
      {casuals.map((c,i)=>(
        <div key={i} style={{display:"flex",gap:7,marginBottom:7,alignItems:"center"}}>
          <input type="text" value={c} onChange={e=>updCasual(i,e.target.value)}
            placeholder="Casual worker name" style={{flex:1}}/>
          <span className="badge badge-neu" style={{fontSize:10}}>Casual</span>
          <button className="btn btn-danger btn-sm" onClick={()=>removeCasual(i)}>x</button>
        </div>
      ))}
    </div>
  );
}

// ─── MATERIAL PICKER (shared) ────────────────────────────────────────────────
function MaterialPicker({ items, rows, setRows }) {
  const categories = useMemo(()=>[...new Set(items.map(it=>it.category).filter(Boolean))].sort(),[items]);
  const uncategorisedCount = items.filter(it=>!it.category).length;

  const add    = ()=>setRows(r=>[...r,{category:"", item_id:"", qty:""}]);
  const upd    = (i,k,v)=>setRows(r=>r.map((x,j)=>j===i?{...x,[k]:v}:x));
  const remove = i=>setRows(r=>r.filter((_,j)=>j!==i));

  const setCategory = (i,cat)=>setRows(r=>r.map((x,j)=>j===i?{...x,category:cat,item_id:""}:x)); // reset item when category changes

  const selectStyle = {flex:1,background:"rgba(0,0,0,.25)",border:`1px solid ${T.border}`,borderRadius:6,
    padding:"9px 10px",color:T.cream,fontFamily:"'Inter',sans-serif",fontSize:14,outline:"none"};

  return (
    <div style={{marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <div className="section-title" style={{margin:0}}>Materials Needed</div>
        <button className="btn btn-ghost btn-sm" onClick={add}>+ Add Material</button>
      </div>
      {rows.length===0 && <div style={{fontSize:11,color:T.muted}}>No materials added.</div>}
      {rows.map((r,i)=>{
        const itemsInCat = r.category
          ? items.filter(it => r.category==="__none__" ? !it.category : it.category===r.category)
          : [];
        return (
          <div key={i} style={{display:"flex",gap:7,marginBottom:7,alignItems:"center",flexWrap:"wrap"}}>
            <select value={r.category||""} onChange={e=>setCategory(i,e.target.value)} style={{...selectStyle,flex:"0 0 160px"}}>
              <option value="">-- Category --</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
              {uncategorisedCount>0 && <option value="__none__">Uncategorised</option>}
            </select>
            <SearchableSelect
              value={r.item_id}
              onChange={v=>upd(i,"item_id",v)}
              options={itemsInCat.map(it=>({value:it.id,label:`${it.description} (${it.unit})`}))}
              placeholder={r.category ? "-- Select item --" : "Pick a category first"}
              disabled={!r.category}
              style={{flex:1,opacity:r.category?1:.5}}
              inputStyle={{...selectStyle}}
            />
            <input className="count-input" type="number" inputMode="decimal" placeholder="Qty" value={r.qty}
              onChange={e=>upd(i,"qty",e.target.value)}/>
            <button className="btn btn-danger btn-sm" onClick={()=>remove(i)}>x</button>
          </div>
        );
      })}
    </div>
  );
}

// ─── JOB TEMPLATES (Admin) ───────────────────────────────────────────────────
function JobTemplates({ locId, templates, setTemplates, templateMaterials, setTemplateMaterials,
                        items, destinations, jobs, setJobs, jobMaterials, setJobMaterials, companyId, hrEmployees }) {
  const locDests = destinations.filter(d=>d.location_id===locId).sort((a,b)=>a.sort_order-b.sort_order);
  const [showForm,setShowForm] = useState(false);
  const [editId,setEditId]     = useState(null);
  const blank = {name:"",description:"",job_type:"preventive",destination_id:"",assigned_to:"",
                 recurrence_type:"months",recurrence_n:"1",next_due:today()};
  const [form,setForm] = useState(blank);
  const [rows,setRows] = useState([]);
  const [busy,setBusy] = useState(false);
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));

  const openAdd = ()=>{ setForm({...blank,next_due:today()}); setRows([]); setEditId(null); setShowForm(true); };
  const openEdit = t => {
    setForm({name:t.name,description:t.description||"",job_type:t.job_type||"preventive",
             destination_id:t.destination_id||"",assigned_to:t.assigned_to||"",
             recurrence_type:t.recurrence_type||"none",recurrence_n:String(t.recurrence_n||0),
             next_due:t.next_due||today()});
    setRows(templateMaterials.filter(m=>m.template_id===t.id).map(m=>{
      const it = items.find(x=>x.id===m.item_id);
      return {id:m.id,item_id:m.item_id,qty:String(m.qty),category:it?.category||"__none__"};
    }));
    setEditId(t.id); setShowForm(true);
  };

  const save = async () => {
    if(!form.name.trim()) return;
    setBusy(true);
    try{
      const dest = locDests.find(d=>d.id===form.destination_id);
      const row = {
        location_id:locId, name:form.name.trim(), description:form.description||null,
        job_type:form.job_type, destination_id:form.destination_id||null,
        dest_name:dest?.name||null, assigned_to:form.assigned_to||null,
        recurrence_type:form.recurrence_type,
        recurrence_n:form.recurrence_type==="none"?0:(parseInt(form.recurrence_n)||1),
        next_due:form.next_due, active:true, company_id:companyId,
      };

      let tplId = editId;
      if(editId){
        await sb.update("maint_job_templates", editId, row);
        setTemplates(p=>p.map(t=>t.id===editId?{...t,...row}:t));
        // Replace material lines
        const old = templateMaterials.filter(m=>m.template_id===editId);
        for(const o of old) await sb.delete("maint_template_materials", o.id);
        setTemplateMaterials(p=>p.filter(m=>m.template_id!==editId));
      }else{
        tplId = uid();
        await sb.insert("maint_job_templates", {...row, id:tplId});
        setTemplates(p=>[...p,{...row,id:tplId}]);
      }

      const newMats=[];
      for(const r of rows){
        if(!r.item_id||!(parseFloat(r.qty)>0)) continue;
        const m={id:uid(), template_id:tplId, item_id:r.item_id, qty:parseFloat(r.qty), company_id:companyId};
        await sb.insert("maint_template_materials", m);
        newMats.push(m);
      }
      if(newMats.length) setTemplateMaterials(p=>[...p,...newMats]);

      // For a brand new template, create its first scheduled job right away
      if(!editId){
        const job = {
          id:uid(), location_id:locId, template_id:tplId, name:row.name,
          description:row.description, job_type:row.job_type,
          destination_id:row.destination_id, dest_name:row.dest_name,
          assigned_to:row.assigned_to, due_date:row.next_due, status:"scheduled",
          company_id:companyId,
        };
        await sb.insert("maint_jobs", job);
        setJobs(p=>[...p,job]);
        const jm=[];
        for(const m of newMats){
          const x={id:uid(), job_id:job.id, item_id:m.item_id, qty_planned:m.qty, company_id:companyId};
          await sb.insert("maint_job_materials", x);
          jm.push(x);
        }
        if(jm.length) setJobMaterials(p=>[...p,...jm]);
      }

      setShowForm(false);
    }catch(e){ alert("Save failed: "+e.message); }
    finally{ setBusy(false); }
  };

  const remove = async t => {
    if(!window.confirm(`Remove template "${t.name}"?\n\nScheduled jobs already created from it are kept.`)) return;
    try{
      await sb.delete("maint_job_templates", t.id);
      setTemplates(p=>p.filter(x=>x.id!==t.id));
      setTemplateMaterials(p=>p.filter(m=>m.template_id!==t.id));
    }catch(e){ alert("Error: "+e.message); }
  };

  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Templates</div><div className="strip-val">{templates.length}</div></div>
      <div className="strip-item"><div className="strip-label">Recurring</div>
        <div className="strip-val">{templates.filter(t=>t.recurrence_type!=="none").length}</div></div>
      <div style={{marginLeft:"auto"}}><button className="btn btn-primary" onClick={openAdd}>+ Add Template</button></div>
    </div>
    <div style={{fontSize:12,color:T.muted,marginBottom:14,lineHeight:1.6}}>
      Templates define recurring maintenance. Saving a new template schedules its first job automatically.
      Each time a job is completed, the next one is scheduled from the actual completion date.
    </div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Job Name</th><th>Type</th><th>Where</th><th>Assigned</th><th>Repeats</th><th>Next Due</th><th className="num">Materials</th><th></th></tr></thead>
      <tbody>
        {templates.map(t=>(
          <tr key={t.id}>
            <td style={{fontWeight:600}}>{t.name}</td>
            <td style={{fontSize:11,color:T.muted}}>{JOB_TYPES.find(x=>x.id===t.job_type)?.label||t.job_type}</td>
            <td style={{fontSize:12,color:T.muted}}>{t.dest_name||"—"}</td>
            <td style={{fontSize:12,color:T.muted}}>{t.assigned_to||"—"}</td>
            <td><span className="badge badge-neu">{recurLabel(t.recurrence_type,t.recurrence_n)}</span></td>
            <td className="mono" style={{fontSize:11}}>{t.next_due||"—"}</td>
            <td className="num" style={{color:T.muted}}>{templateMaterials.filter(m=>m.template_id===t.id).length}</td>
            <td style={{display:"flex",gap:5}}>
              <button className="btn btn-ghost btn-sm" onClick={()=>openEdit(t)}>Edit</button>
              <button className="btn btn-danger btn-sm" onClick={()=>remove(t)}>x</button>
            </td>
          </tr>
        ))}
        {templates.length===0&&<tr><td colSpan={8} className="empty">No job templates yet for this location</td></tr>}
      </tbody>
    </table></div>

    {showForm&&(
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowForm(false)}>
        <div className="modal">
          <div className="modal-title">{editId?"Edit":"Add"} <span>Job Template</span></div>
          <div className="field"><label>Job Name</label>
            <input type="text" value={form.name} onChange={f("name")} placeholder="e.g. Service generator"/>
          </div>
          <div className="grid2">
            <div className="field"><label>Job Type</label>
              <select value={form.job_type} onChange={f("job_type")}>
                {JOB_TYPES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div className="field"><label>Where</label>
              <select value={form.destination_id} onChange={f("destination_id")}>
                <option value="">-- Select --</option>
                {locDests.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Repeats</label>
              <select value={form.recurrence_type} onChange={f("recurrence_type")}>
                {RECURRENCE.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
            {form.recurrence_type!=="none" && (
              <div className="field"><label>Interval (N)</label>
                <input type="number" inputMode="decimal" min="1" value={form.recurrence_n} onChange={f("recurrence_n")}/>
              </div>
            )}
            <div className="field"><label>First / Next Due</label>
              <DateField value={form.next_due} onChange={v=>setForm(p=>({...p,next_due:v}))}/>
            </div>
            <div className="field"><label>Assigned To</label>
              <AssignedToField hrEmployees={hrEmployees} value={form.assigned_to} onChange={v=>setForm(p=>({...p,assigned_to:v}))}/>
            </div>
          </div>
          <div className="field"><label>Description</label>
            <textarea rows={2} value={form.description} onChange={f("description")}/>
          </div>

          <MaterialPicker items={items} rows={rows} setRows={setRows}/>

          {form.recurrence_type!=="none" && (
            <div className="info-box">
              <span style={{fontSize:11,color:T.muted}}>Schedule</span>
              <strong style={{color:T.gold,fontSize:12}}>{recurLabel(form.recurrence_type, parseInt(form.recurrence_n)||1)}</strong>
            </div>
          )}

          <div style={{display:"flex",gap:9}}>
            <button className="btn btn-primary" onClick={save} disabled={busy}>{busy?"Saving...":(editId?"Save Changes":"Create Template")}</button>
            <button className="btn btn-ghost" onClick={()=>setShowForm(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      </div>
    )}
  </>);
}


// ─── DESTINATION COSTING HELPERS ─────────────────────────────────────────────
// Weighted average unit cost: opening stock value plus all purchases,
// divided by total units. Falls back to opening cost when nothing is known.
function weightedCost(item, purchases) {
  const p      = purchases.filter(x=>x.item_id===item.id);
  const pQty   = p.reduce((s,x)=>s+(x.qty||0),0);
  const pValue = p.reduce((s,x)=>s+(x.total_cost||0),0);
  const oQty   = item.open_qty||0;
  const oValue = oQty*(item.open_cost||0);
  const totQty = oQty+pQty;
  if(totQty<=0) return item.open_cost||0;
  return (oValue+pValue)/totQty;
}

// ─── INTERNAL INVOICING (2026-08-26) ─────────────────────────────────────────
// Auto-generates one internal invoice per completed job, so Thijs can see
// what the (single, multi-site) Maintenance team actually costs/saves each
// lodge. Billed at cost (0% markup): material cost uses the exact same
// weightedCost() this app already uses for Destination Costs; labor cost
// uses each employee's own real loaded monthly cost (salary + medical aid +
// pension + housing, from hr_contracts) divided by a configurable "standard
// hours/month", via the get_employee_hourly_rate RPC — a direct client read
// of hr_contracts would return nothing for a Maintenance admin who isn't
// also an HR Admin (hr_contracts RLS requires is_hr_admin()).
//
// Deliberately never throws back to the caller — an internal invoice
// failing to generate should never block a technician from completing a
// job. Errors are logged and swallowed, same reasoning as the vehicle
// service-date sync a few lines away in CompleteJob.save().
async function generateJobInvoice({ job, laborInserts, materialLines, items, purchases, companyId, completedDate }) {
  try {
    const materialCost = (materialLines||[]).reduce((sum,m)=>{
      const item = items.find(i=>i.id===m.item_id);
      if(!item || !(m.qty>0)) return sum;
      return sum + m.qty*weightedCost(item, purchases);
    }, 0);

    const asOfIso = dmyToIso(completedDate) || new Date().toISOString().slice(0,10);

    // One rate lookup per unique employee on this job, not per labor row.
    const rateByEmployee = {};
    for(const l of laborInserts){
      if(!l.employee_id){ rateByEmployee[l.employee_id] = 0; continue; }
      if(rateByEmployee[l.employee_id]!==undefined) continue;
      const { data, error } = await supabase.rpc("get_employee_hourly_rate", {
        p_employee_id: l.employee_id, p_company_id: companyId, p_as_of_date: asOfIso,
      });
      rateByEmployee[l.employee_id] = error ? 0 : Number(data||0);
    }

    const laborLines = laborInserts.map(l=>{
      const rate = rateByEmployee[l.employee_id] || 0;
      return {
        id: uid(), employee_id: l.employee_id||null, employee_name: l.employee_name,
        hours: l.hours, hourly_rate: rate, line_cost: Math.round(l.hours*rate*100)/100,
        company_id: companyId,
      };
    });
    const laborCost = laborLines.reduce((s,l)=>s+l.line_cost, 0);
    const totalCost = Math.round((laborCost+materialCost)*100)/100;

    const invoice = {
      id: uid(), company_id: companyId, job_id: job.id, location_id: job.location_id,
      destination_id: job.destination_id||null, dest_name: job.dest_name||null,
      job_name: job.name, completed_date: completedDate,
      labor_cost: Math.round(laborCost*100)/100,
      material_cost: Math.round(materialCost*100)/100,
      total_cost: totalCost,
    };
    await sb.insert("maint_job_invoices", invoice);
    for(const line of laborLines){
      await sb.insert("maint_job_invoice_labor_lines", { ...line, invoice_id: invoice.id });
    }
  }catch(e){
    console.error("Could not generate internal invoice for job", job.id, e);
  }
}

// Same idea as generateJobInvoice, but for a Projects workstream progress
// log (2026-08-26, Thijs: "Are cost for projects also being pushed through
// to internal billing? ... Can use full day wage for project labor cost").
// Progress logs never captured hours worked (only who was on the crew via
// project_progress_crew), so — unlike job labor — this bills each crew
// member a full day's rate (real monthly cost ÷ standard working
// days/month, via get_employee_daily_rate) for every logged entry they
// appear in, rather than an hourly rate against hours that don't exist.
// Casual/temp crew (no employee_id) have no HR contract anywhere in the
// system, so their line is recorded at a daily_rate of 0 — a known,
// documented gap (see add_project_labor_invoicing.sql), not a bug.
// Progress logs aren't destination-scoped, only project/location-scoped, so
// this bills to the project's lodge, not a specific destination.
async function generateProgressInvoice({ progressLog, project, workstream, crewList, materialLines, items, purchases, companyId }) {
  try {
    const materialCost = (materialLines||[]).reduce((sum,m)=>{
      const item = items.find(i=>i.id===m.item_id);
      if(!item || !(m.qty>0)) return sum;
      return sum + m.qty*weightedCost(item, purchases);
    }, 0);

    const asOfIso = progressLog.week_ending; // already ISO — <input type="date">

    const rateByEmployee = {};
    for(const c of crewList){
      if(!c.employee_id){ rateByEmployee[c.employee_id] = 0; continue; } // casual — no HR cost data
      if(rateByEmployee[c.employee_id]!==undefined) continue;
      const { data, error } = await supabase.rpc("get_employee_daily_rate", {
        p_employee_id: c.employee_id, p_company_id: companyId, p_as_of_date: asOfIso,
      });
      rateByEmployee[c.employee_id] = error ? 0 : Number(data||0);
    }

    const laborLines = crewList.map(c=>{
      const rate = c.employee_id ? (rateByEmployee[c.employee_id]||0) : 0;
      return {
        id: uid(), employee_id: c.employee_id||null, employee_name: c.worker_name,
        is_casual: !!c.is_casual, daily_rate: rate, line_cost: rate,
        company_id: companyId,
      };
    });
    const laborCost = laborLines.reduce((s,l)=>s+l.line_cost, 0);
    const totalCost = Math.round((laborCost+materialCost)*100)/100;

    const invoice = {
      id: uid(), company_id: companyId, progress_log_id: progressLog.id,
      project_id: project.id, workstream_id: workstream.id, location_id: project.location_id,
      log_date: progressLog.week_ending,
      labor_cost: Math.round(laborCost*100)/100,
      material_cost: Math.round(materialCost*100)/100,
      total_cost: totalCost,
    };
    await sb.insert("project_progress_invoices", invoice);
    for(const line of laborLines){
      await sb.insert("project_progress_invoice_labor_lines", { ...line, invoice_id: invoice.id });
    }
  }catch(e){
    console.error("Could not generate progress invoice for log", progressLog?.id, e);
  }
}

// Roll issues up per destination. Issues keep a dest_name snapshot, so
// anything issued to a destination that was later renamed or removed is
// still counted under the name it was recorded with.
function buildDestinationCosts({ destinations, issues, items, purchases, jobs }) {
  const costOf = {};
  items.forEach(i=>costOf[i.id]=weightedCost(i,purchases));

  const rows = {};
  const keyFor = (id,name) => id || `name:${name||"Unassigned"}`;

  destinations.forEach(d=>{
    rows[d.id] = { id:d.id, name:d.name, live:true, units:0, value:0,
                   itemCount:0, lines:[], jobs:[] };
  });

  issues.forEach(iss=>{
    const k = keyFor(iss.destination_id, iss.dest_name);
    if(!rows[k]) rows[k] = { id:iss.destination_id||null, name:iss.dest_name||"Unassigned",
                             live:false, units:0, value:0, itemCount:0, lines:[], jobs:[] };
    const item = items.find(x=>x.id===iss.item_id);
    const unit = item ? costOf[item.id] : 0;
    rows[k].units += iss.qty||0;
    rows[k].value += (iss.qty||0)*unit;
    rows[k].lines.push({ ...iss, item, unitCost:unit, value:(iss.qty||0)*unit });
  });

  (jobs||[]).forEach(j=>{
    const k = keyFor(j.destination_id, j.dest_name);
    if(!rows[k]) rows[k] = { id:j.destination_id||null, name:j.dest_name||"Unassigned",
                             live:false, units:0, value:0, itemCount:0, lines:[], jobs:[] };
    rows[k].jobs.push(j);
  });

  return Object.values(rows).map(r=>{
    r.itemCount = new Set(r.lines.map(l=>l.item_id)).size;
    return r;
  }).sort((a,b)=>b.value-a.value);
}

// ─── DESTINATION DETAIL ──────────────────────────────────────────────────────
function DestinationDetail({ row, onClose }) {
  const [tab,setTab] = useState("items");

  // Group issue lines by item so you see totals per item, not every transaction
  const byItem = useMemo(()=>{
    const m={};
    row.lines.forEach(l=>{
      const k=l.item_id;
      if(!m[k]) m[k]={ item:l.item, itemId:k, qty:0, value:0, unitCost:l.unitCost, count:0, last:null };
      m[k].qty   += l.qty||0;
      m[k].value += l.value||0;
      m[k].count += 1;
      const d=parseDMY(l.date);
      const cur=m[k].last?parseDMY(m[k].last):null;
      if(d && (!cur || d>cur)) m[k].last=l.date;
    });
    return Object.values(m).sort((a,b)=>b.value-a.value);
  },[row]);

  const history = useMemo(()=>{
    return [...row.lines].sort((a,b)=>{
      const da=parseDMY(a.date), db=parseDMY(b.date);
      return (db?db.getTime():0)-(da?da.getTime():0);
    });
  },[row]);

  const jobsSorted = useMemo(()=>{
    return [...row.jobs].sort((a,b)=>{
      const da=parseDMY(a.due_date), db=parseDMY(b.due_date);
      return (db?db.getTime():0)-(da?da.getTime():0);
    });
  },[row]);

  const openJobs = row.jobs.filter(j=>j.status==="scheduled"||j.status==="in_progress").length;
  const doneJobs = row.jobs.filter(j=>j.status==="completed").length;

  const TABS = [
    {id:"items",   label:`Items (${byItem.length})`},
    {id:"history", label:`History (${history.length})`},
    {id:"jobs",    label:`Jobs (${row.jobs.length})`},
  ];

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal" style={{maxWidth:720}}>
        <div className="modal-title">{row.name}</div>
        {!row.live && (
          <div style={{fontSize:11,color:T.warn,marginBottom:12}}>
            This destination is no longer on the active list. History is kept.
          </div>
        )}

        <div className="strip" style={{marginBottom:16}}>
          <div className="strip-item"><div className="strip-label">Total Value</div>
            <div className="strip-val">{fmtR(row.value)}</div></div>
          <div className="strip-item"><div className="strip-label">Units Issued</div>
            <div className="strip-val">{fmtN(row.units)}</div></div>
          <div className="strip-item"><div className="strip-label">Different Items</div>
            <div className="strip-val">{row.itemCount}</div></div>
          <div className="strip-item"><div className="strip-label">Open Jobs</div>
            <div className="strip-val" style={{color:openJobs>0?T.warn:T.ok}}>{openJobs}</div></div>
        </div>

        <div className="tabs">
          {TABS.map(t=>(
            <button key={t.id} className={`tab${tab===t.id?" active":""}`} onClick={()=>setTab(t.id)}>{t.label}</button>
          ))}
        </div>

        {/* ITEMS — one line per item, totalled */}
        {tab==="items" && (
          <div className="tbl-wrap"><table className="tbl" style={{minWidth:0}}>
            <thead><tr><th>Item</th><th className="num">Total Qty</th><th className="num">Unit Cost</th>
              <th className="num">Value</th><th className="num">Times Issued</th><th>Last Issued</th></tr></thead>
            <tbody>
              {byItem.map(r=>(
                <tr key={r.itemId}>
                  <td style={{fontWeight:600}}>
                    {r.item?.description || <span style={{color:T.muted}}>Deleted item</span>}
                    {r.item?.item_code && <div style={{fontSize:10,color:T.muted,fontFamily:"'Space Mono'"}}>{r.item.item_code}</div>}
                  </td>
                  <td className="num">{fmtN(r.qty)} <span style={{fontSize:10,color:T.muted}}>{r.item?.unit||""}</span></td>
                  <td className="num" style={{color:T.muted}}>{fmtR(r.unitCost)}</td>
                  <td className="num" style={{fontWeight:700,color:T.gold}}>{fmtR(r.value)}</td>
                  <td className="num" style={{color:T.muted}}>{r.count}</td>
                  <td className="mono" style={{fontSize:11,color:T.muted}}>{r.last||"—"}</td>
                </tr>
              ))}
              {byItem.length===0&&<tr><td colSpan={6} className="empty">Nothing issued here yet</td></tr>}
            </tbody>
          </table></div>
        )}

        {/* HISTORY — every individual issue */}
        {tab==="history" && (
          <div className="tbl-wrap"><table className="tbl" style={{minWidth:0}}>
            <thead><tr><th>Date</th><th>Item</th><th className="num">Qty</th>
              <th className="num">Value</th><th>Notes</th></tr></thead>
            <tbody>
              {history.map(l=>(
                <tr key={l.id}>
                  <td className="mono" style={{fontSize:11}}>{l.date}</td>
                  <td style={{fontWeight:600}}>{l.item?.description || <span style={{color:T.muted}}>Deleted item</span>}</td>
                  <td className="num">{fmtN(l.qty)} <span style={{fontSize:10,color:T.muted}}>{l.item?.unit||""}</span></td>
                  <td className="num" style={{color:T.gold}}>{fmtR(l.value)}</td>
                  <td style={{fontSize:11,color:T.muted,maxWidth:200}}>{l.notes||"—"}</td>
                </tr>
              ))}
              {history.length===0&&<tr><td colSpan={5} className="empty">No issue history</td></tr>}
            </tbody>
          </table></div>
        )}

        {/* JOBS — maintenance work scheduled or done here */}
        {tab==="jobs" && (
          <div className="tbl-wrap"><table className="tbl" style={{minWidth:0}}>
            <thead><tr><th>Due</th><th>Job</th><th>Type</th><th>Assigned</th><th>Status</th><th>Completed</th></tr></thead>
            <tbody>
              {jobsSorted.map(j=>{
                const done = j.status==="completed";
                const overdue = !done && j.status!=="cancelled" && parseDMY(j.due_date) && parseDMY(j.due_date) < startOfToday();
                const col = done?T.ok:overdue?T.danger:j.status==="cancelled"?T.muted:T.gold;
                return (
                  <tr key={j.id}>
                    <td className="mono" style={{fontSize:11}}>{j.due_date}</td>
                    <td style={{fontWeight:600}}>{j.name}</td>
                    <td style={{fontSize:11,color:T.muted}}>{JOB_TYPES.find(t=>t.id===j.job_type)?.label||j.job_type}</td>
                    <td style={{fontSize:12,color:T.muted}}>{j.assigned_to||"—"}</td>
                    <td><span className="badge" style={{background:`${col}22`,color:col,border:`1px solid ${col}55`}}>
                      {done?"Done":overdue?"Overdue":j.status==="cancelled"?"Cancelled":"Scheduled"}
                    </span></td>
                    <td className="mono" style={{fontSize:11,color:T.muted}}>{j.completed_date||"—"}</td>
                  </tr>
                );
              })}
              {jobsSorted.length===0&&<tr><td colSpan={6} className="empty">No jobs recorded here</td></tr>}
            </tbody>
          </table></div>
        )}

        {doneJobs>0 && tab==="jobs" && (
          <div style={{fontSize:11,color:T.muted,marginTop:10}}>
            {doneJobs} job{doneJobs===1?"":"s"} completed at this destination.
          </div>
        )}

        <div style={{display:"flex",gap:9,marginTop:16}}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── DESTINATION COSTS PAGE ──────────────────────────────────────────────────
function DestinationCosts({ destinations, issues, items, purchases, jobs }) {
  const [open,setOpen] = useState(null);

  const rows = useMemo(()=>buildDestinationCosts({destinations,issues,items,purchases,jobs}),
    [destinations,issues,items,purchases,jobs]);

  const grand   = rows.reduce((s,r)=>s+r.value,0);
  const withAny = rows.filter(r=>r.value>0||r.jobs.length>0);

  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Total Issued Value</div>
        <div className="strip-val">{fmtR(grand)}</div></div>
      <div className="strip-item"><div className="strip-label">Destinations</div>
        <div className="strip-val">{rows.length}</div></div>
      <div className="strip-item"><div className="strip-label">With Activity</div>
        <div className="strip-val">{withAny.length}</div></div>
    </div>

    <div style={{fontSize:12,color:T.muted,marginBottom:14,lineHeight:1.6}}>
      What each building or room has cost in materials, valued at weighted average cost
      (opening stock plus purchases). Tap a destination to see the full breakdown.
    </div>

    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Destination</th><th className="num">Items</th><th className="num">Units</th>
        <th className="num">Value</th><th className="num">Jobs</th><th>Share</th></tr></thead>
      <tbody>
        {rows.map(r=>(
          <tr key={r.id||r.name}>
            <td>
              <button onClick={()=>setOpen(r)}
                style={{background:"none",border:"none",padding:0,textAlign:"left",cursor:"pointer",
                  fontFamily:"'Inter',sans-serif",fontSize:13,fontWeight:600,color:T.cream,
                  borderBottom:`1px dotted ${T.border}`}}>
                {r.name}
              </button>
              {!r.live && <span className="badge badge-neu" style={{marginLeft:7}}>archived</span>}
            </td>
            <td className="num" style={{color:T.muted}}>{r.itemCount||"—"}</td>
            <td className="num" style={{color:T.muted}}>{r.units?fmtN(r.units):"—"}</td>
            <td className="num" style={{fontWeight:700,color:r.value>0?T.gold:T.border}}>
              {r.value>0?fmtR(r.value):"—"}
            </td>
            <td className="num" style={{color:T.muted}}>{r.jobs.length||"—"}</td>
            <td style={{width:110}}>
              <div style={{height:6,background:"rgba(0,0,0,.3)",borderRadius:3,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${grand>0?(r.value/grand*100):0}%`,background:T.gold,borderRadius:3}}/>
              </div>
            </td>
          </tr>
        ))}
        {rows.length===0&&<tr><td colSpan={6} className="empty">No destinations set up for this location yet</td></tr>}
      </tbody>
    </table></div>

    {open && <DestinationDetail row={open} onClose={()=>setOpen(null)}/>}
  </>);
}

// ─── INTERNAL BILLING PAGE ────────────────────────────────────────────────────
// Admin-only. Rolls up the auto-generated per-job invoices (generateJobInvoice,
// above) into a monthly P&L: what got billed to the lodges (Invoiced) against
// what the department actually costs in full (every active Maintenance
// employee's real loaded cost, whether their hours were billed or sat idle,
// via the get_maintenance_department_cost RPC) — the Gap between the two is
// unbilled/idle labor capacity, which is the whole reason Thijs asked for
// this: "I want an invoicing system so I know what our maintenance team is
// costing/saving us for the lodges." Material cost algebraically cancels out
// of the Gap (billed at 0% markup, so material invoiced == material
// consumed) — the Gap is purely a labor-utilization number.
//
// Known, deliberate scope limit: material issued OUTSIDE of a job (no job_id
// — maint_issues has no `reason` column the way Food/Beverage's write-offs
// do) isn't separately tracked here; it simply isn't billed to anyone. Worth
// knowing, not fixed here.
function InternalBillingPage({ invoices, projectInvoices, projects, workstreams, billingSettings, setBillingSettings, companyId }) {
  const [month, setMonth]           = useState(()=>new Date().toISOString().slice(0,7)); // YYYY-MM
  const [hoursInput, setHoursInput] = useState(String(billingSettings?.standard_hours_per_month || 190));
  const [savingHours, setSavingHours] = useState(false);
  const [deptCost, setDeptCost]     = useState(null);
  const [deptCostErr, setDeptCostErr] = useState(null);
  const [openInvoice, setOpenInvoice] = useState(null);
  const [laborLines, setLaborLines] = useState([]);
  const [loadingLines, setLoadingLines] = useState(false);
  // Project labor invoicing (2026-08-26) — same idea as job invoices, but
  // one per progress log, billed at a full-day rate since progress logs
  // never captured hours (see generateProgressInvoice()). Kept as separate
  // state/modal from job invoices below since they live in a different
  // table with a different labor-line shape (daily_rate, not hourly_rate).
  const [openProjectInvoice, setOpenProjectInvoice] = useState(null);
  const [projectLaborLines, setProjectLaborLines] = useState([]);
  const [loadingProjectLines, setLoadingProjectLines] = useState(false);

  useEffect(()=>{ setHoursInput(String(billingSettings?.standard_hours_per_month || 190)); },[billingSettings]);

  const monthInvoices = useMemo(()=>
    invoices.filter(inv=>{
      const d = parseDMY(inv.completed_date);
      if(!d) return false;
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`===month;
    })
  ,[invoices, month]);

  const monthProjectInvoices = useMemo(()=>
    (projectInvoices||[]).filter(inv=>(inv.log_date||"").slice(0,7)===month)
  ,[projectInvoices, month]);

  const totalInvoiced = monthInvoices.reduce((s,i)=>s+i.total_cost,0) + monthProjectInvoices.reduce((s,i)=>s+i.total_cost,0);
  const totalLabor    = monthInvoices.reduce((s,i)=>s+i.labor_cost,0);
  const totalMaterial = monthInvoices.reduce((s,i)=>s+i.material_cost,0) + monthProjectInvoices.reduce((s,i)=>s+i.material_cost,0);

  useEffect(()=>{
    let cancelled = false;
    (async()=>{
      setDeptCostErr(null); setDeptCost(null);
      if(!companyId) return;
      try{
        const [y,m] = month.split("-").map(Number);
        const lastDay = new Date(y, m, 0).toISOString().slice(0,10);
        const { data, error } = await supabase.rpc("get_maintenance_department_cost", {
          p_company_id: companyId, p_as_of_date: lastDay,
        });
        if(cancelled) return;
        if(error){ setDeptCostErr(error.message); }
        else setDeptCost(Number(data||0));
      }catch(e){ if(!cancelled) setDeptCostErr(e.message); }
    })();
    return ()=>{cancelled=true;};
  },[companyId, month]);

  // Department Cost (Full) = full labor cost (everyone, billed or not) +
  // material actually consumed this month. Gap = that minus what was
  // invoiced — see comment above for why this reduces to a pure labor
  // utilization number.
  const deptCostFull = deptCost==null ? null : deptCost + totalMaterial;
  const gap = deptCostFull==null ? null : deptCostFull - totalInvoiced;

  const saveHours = async () => {
    const hours = parseFloat(hoursInput);
    if(!(hours>0)){ alert("Enter a positive number of hours."); return; }
    setSavingHours(true);
    try{
      if(billingSettings){
        await sb.update("maintenance_billing_settings", billingSettings.id, {standard_hours_per_month:hours, updated_at:new Date().toISOString()});
        setBillingSettings(s=>({...s, standard_hours_per_month:hours}));
      }else{
        const row = {id:uid(), company_id:companyId, standard_hours_per_month:hours};
        await sb.insert("maintenance_billing_settings", row);
        setBillingSettings(row);
      }
    }catch(e){ alert("Could not save: "+e.message); }
    finally{ setSavingHours(false); }
  };

  const byLocation = useMemo(()=>{
    const m = {};
    LOCATIONS.forEach(l=>{ m[l.id] = {id:l.id, name:l.name, total:0, labor:0, material:0, jobs:0}; });
    monthInvoices.forEach(inv=>{
      const k = inv.location_id;
      if(!m[k]) m[k] = {id:k, name:k, total:0, labor:0, material:0, jobs:0};
      m[k].total += inv.total_cost; m[k].labor += inv.labor_cost; m[k].material += inv.material_cost; m[k].jobs += 1;
    });
    // Project labor is billed to a lodge too — merge into the same
    // per-location totals so "By Location" reflects the department's full
    // invoiced work, not just job cards.
    monthProjectInvoices.forEach(inv=>{
      const k = inv.location_id;
      if(!m[k]) m[k] = {id:k, name:k, total:0, labor:0, material:0, jobs:0};
      m[k].total += inv.total_cost; m[k].labor += inv.labor_cost; m[k].material += inv.material_cost; m[k].jobs += 1;
    });
    return Object.values(m).sort((a,b)=>b.total-a.total);
  },[monthInvoices, monthProjectInvoices]);

  // Project progress logs aren't destination-scoped (only project/lodge),
  // so they can't be merged into the per-destination job breakdown below —
  // shown instead as one "Project Work" row per lodge with activity, kept
  // visually distinct (italic name) so it's clear it's not a real destination.
  const byDestination = useMemo(()=>{
    const m = {};
    monthInvoices.forEach(inv=>{
      const k = inv.destination_id || `name:${inv.dest_name||"Unassigned"}`;
      if(!m[k]) m[k] = {id:inv.destination_id, name:inv.dest_name||"Unassigned", total:0, labor:0, material:0, jobs:0};
      m[k].total += inv.total_cost; m[k].labor += inv.labor_cost; m[k].material += inv.material_cost; m[k].jobs += 1;
    });
    const projByLoc = {};
    monthProjectInvoices.forEach(inv=>{
      const k = `project:${inv.location_id}`;
      if(!projByLoc[k]) projByLoc[k] = {id:null, name:`Project Work — ${LOCATIONS.find(l=>l.id===inv.location_id)?.name||inv.location_id}`, total:0, labor:0, material:0, jobs:0, isProject:true};
      projByLoc[k].total += inv.total_cost; projByLoc[k].labor += inv.labor_cost; projByLoc[k].material += inv.material_cost; projByLoc[k].jobs += 1;
    });
    return [...Object.values(m), ...Object.values(projByLoc)].sort((a,b)=>b.total-a.total);
  },[monthInvoices, monthProjectInvoices]);

  const sortedInvoices = useMemo(()=>
    [...monthInvoices].sort((a,b)=>{
      const da=parseDMY(a.completed_date), db=parseDMY(b.completed_date);
      return (db?db.getTime():0)-(da?da.getTime():0);
    })
  ,[monthInvoices]);

  const sortedProjectInvoices = useMemo(()=>
    [...monthProjectInvoices].sort((a,b)=> (b.log_date||"").localeCompare(a.log_date||""))
  ,[monthProjectInvoices]);

  const viewLines = async (inv) => {
    setOpenInvoice(inv); setLoadingLines(true);
    try{
      const rows = await sb.select("maint_job_invoice_labor_lines", `invoice_id=eq.${inv.id}&company_id=eq.${companyId}`);
      setLaborLines(rows.map(r=>({...r,hours:+r.hours,hourly_rate:+r.hourly_rate,line_cost:+r.line_cost})));
    }catch(e){ alert("Could not load labor detail: "+e.message); setLaborLines([]); }
    finally{ setLoadingLines(false); }
  };

  const viewProjectLines = async (inv) => {
    setOpenProjectInvoice(inv); setLoadingProjectLines(true);
    try{
      const rows = await sb.select("project_progress_invoice_labor_lines", `invoice_id=eq.${inv.id}&company_id=eq.${companyId}`);
      setProjectLaborLines(rows.map(r=>({...r,daily_rate:+r.daily_rate,line_cost:+r.line_cost})));
    }catch(e){ alert("Could not load labor detail: "+e.message); setProjectLaborLines([]); }
    finally{ setLoadingProjectLines(false); }
  };

  return (<>
    <div style={{fontSize:12,color:T.muted,marginBottom:16,lineHeight:1.6}}>
      Every completed job is automatically billed back to its lodge/destination at cost —
      material at weighted average, labor at each employee's own real loaded hourly rate.
      Project workstream progress logs are billed the same way, at a full day's rate per
      crew member per log (progress logs don't track hours). This is an internal accounting
      view only; no real payments move.
    </div>

    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
      <label style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".08em"}}>Month</label>
      <input type="month" value={month} onChange={e=>setMonth(e.target.value)}
        style={{background:T.panel,border:`1px solid ${T.border}`,borderRadius:6,color:T.cream,fontFamily:"'Space Mono'",fontSize:13,padding:"6px 10px"}}/>
      <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
        <label style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".08em"}}>Standard Hours/Month</label>
        <input type="number" inputMode="decimal" value={hoursInput} onChange={e=>setHoursInput(e.target.value)}
          style={{width:70,background:T.panel,border:`1px solid ${T.border}`,borderRadius:6,color:T.cream,fontFamily:"'Space Mono'",fontSize:13,padding:"6px 8px"}}/>
        <button className="btn btn-ghost" disabled={savingHours} onClick={saveHours}>{savingHours?"Saving…":"Save"}</button>
      </div>
    </div>

    <div className="strip" style={{marginBottom:14}}>
      <div className="strip-item"><div className="strip-label">Invoiced (Revenue)</div>
        <div className="strip-val" style={{color:T.ok}}>{fmtR(totalInvoiced)}</div></div>
      <div className="strip-item"><div className="strip-label">Department Cost (Full)</div>
        <div className="strip-val" style={{color:T.warn}}>{deptCostFull==null?(deptCostErr?"—":"…"):fmtR(deptCostFull)}</div>
        <div style={{fontSize:10,color:T.muted,marginTop:2}}>All active staff + material used</div></div>
      <div className="strip-item"><div className="strip-label">Gap (Unbilled Capacity)</div>
        <div className="strip-val" style={{color:gap==null?T.muted:gap>0?T.danger:T.ok}}>{gap==null?"—":fmtR(gap)}</div>
        <div style={{fontSize:10,color:T.muted,marginTop:2}}>{gap==null?"":gap>0?"Idle/unbilled labor cost":"Fully recovered"}</div></div>
      <div className="strip-item"><div className="strip-label">Jobs / Logs Invoiced</div>
        <div className="strip-val">{monthInvoices.length} / {monthProjectInvoices.length}</div></div>
    </div>
    {deptCostErr && (
      <div style={{fontSize:11,color:T.warn,marginBottom:14}}>
        Could not load department cost ({deptCostErr}). This usually means the internal invoicing SQL hasn't been run in Supabase yet.
      </div>
    )}

    <div style={{fontSize:11,letterSpacing:".08em",textTransform:"uppercase",color:T.gold,fontWeight:700,margin:"18px 0 8px"}}>By Location</div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Location</th><th className="num">Jobs</th><th className="num">Labor</th><th className="num">Material</th><th className="num">Total Invoiced</th></tr></thead>
      <tbody>
        {byLocation.map(r=>(
          <tr key={r.id}>
            <td style={{fontWeight:600}}>{LOCATIONS.find(l=>l.id===r.id)?.name || r.name}</td>
            <td className="num" style={{color:T.muted}}>{r.jobs||"—"}</td>
            <td className="num" style={{color:T.muted}}>{r.labor>0?fmtR(r.labor):"—"}</td>
            <td className="num" style={{color:T.muted}}>{r.material>0?fmtR(r.material):"—"}</td>
            <td className="num" style={{fontWeight:700,color:r.total>0?T.gold:T.border}}>{r.total>0?fmtR(r.total):"—"}</td>
          </tr>
        ))}
        {byLocation.length===0 && <tr><td colSpan={5} className="empty">No invoices yet this month</td></tr>}
      </tbody>
    </table></div>

    <div style={{fontSize:11,letterSpacing:".08em",textTransform:"uppercase",color:T.gold,fontWeight:700,margin:"18px 0 8px"}}>By Destination</div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Destination</th><th className="num">Jobs</th><th className="num">Labor</th><th className="num">Material</th><th className="num">Total Invoiced</th></tr></thead>
      <tbody>
        {byDestination.map(r=>(
          <tr key={r.id||r.name}>
            <td style={{fontWeight:r.isProject?500:600,fontStyle:r.isProject?"italic":"normal",color:r.isProject?T.muted:T.cream}}>{r.name}</td>
            <td className="num" style={{color:T.muted}}>{r.jobs||"—"}</td>
            <td className="num" style={{color:T.muted}}>{r.labor>0?fmtR(r.labor):"—"}</td>
            <td className="num" style={{color:T.muted}}>{r.material>0?fmtR(r.material):"—"}</td>
            <td className="num" style={{fontWeight:700,color:r.total>0?T.gold:T.border}}>{r.total>0?fmtR(r.total):"—"}</td>
          </tr>
        ))}
        {byDestination.length===0 && <tr><td colSpan={5} className="empty">No invoices yet this month</td></tr>}
      </tbody>
    </table></div>

    <div style={{fontSize:11,letterSpacing:".08em",textTransform:"uppercase",color:T.gold,fontWeight:700,margin:"18px 0 8px"}}>Job Invoices</div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Completed</th><th>Job</th><th>Destination</th><th className="num">Labor</th><th className="num">Material</th><th className="num">Total</th><th></th></tr></thead>
      <tbody>
        {sortedInvoices.map(inv=>(
          <tr key={inv.id}>
            <td className="mono" style={{fontSize:11}}>{inv.completed_date}</td>
            <td style={{fontWeight:600}}>{inv.job_name}</td>
            <td style={{fontSize:12,color:T.muted}}>{inv.dest_name||"—"}</td>
            <td className="num" style={{color:T.muted}}>{fmtR(inv.labor_cost)}</td>
            <td className="num" style={{color:T.muted}}>{fmtR(inv.material_cost)}</td>
            <td className="num" style={{fontWeight:700,color:T.gold}}>{fmtR(inv.total_cost)}</td>
            <td>
              <button onClick={()=>viewLines(inv)}
                style={{background:"none",border:`1px solid ${T.border}`,borderRadius:5,color:T.muted,fontSize:11,cursor:"pointer",padding:"3px 9px"}}>
                Labor
              </button>
            </td>
          </tr>
        ))}
        {sortedInvoices.length===0 && <tr><td colSpan={7} className="empty">No jobs invoiced this month</td></tr>}
      </tbody>
    </table></div>

    {openInvoice && (
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setOpenInvoice(null)}>
        <div className="modal">
          <div className="modal-title">Labor <span>{openInvoice.job_name}</span></div>
          {loadingLines ? (
            <div style={{fontSize:12,color:T.muted}}>Loading…</div>
          ) : (
            <div className="tbl-wrap"><table className="tbl" style={{minWidth:0}}>
              <thead><tr><th>Employee</th><th className="num">Hours</th><th className="num">Rate/hr</th><th className="num">Cost</th></tr></thead>
              <tbody>
                {laborLines.map(l=>(
                  <tr key={l.id}>
                    <td style={{fontWeight:600}}>{l.employee_name}</td>
                    <td className="num">{fmtN(l.hours)}</td>
                    <td className="num" style={{color:T.muted}}>{fmtR(l.hourly_rate)}</td>
                    <td className="num" style={{fontWeight:700,color:T.gold}}>{fmtR(l.line_cost)}</td>
                  </tr>
                ))}
                {laborLines.length===0 && <tr><td colSpan={4} className="empty">No labor lines found</td></tr>}
              </tbody>
            </table></div>
          )}
          <div style={{display:"flex",gap:9,marginTop:16}}>
            <button className="btn btn-ghost" onClick={()=>setOpenInvoice(null)}>Close</button>
          </div>
        </div>
      </div>
    )}

    <div style={{fontSize:11,letterSpacing:".08em",textTransform:"uppercase",color:T.gold,fontWeight:700,margin:"18px 0 8px"}}>Project Labor Invoices</div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Date</th><th>Project</th><th>Workstream</th><th className="num">Labor</th><th className="num">Material</th><th className="num">Total</th><th></th></tr></thead>
      <tbody>
        {sortedProjectInvoices.map(inv=>(
          <tr key={inv.id}>
            <td className="mono" style={{fontSize:11}}>{inv.log_date}</td>
            <td style={{fontWeight:600}}>{projects.find(p=>p.id===inv.project_id)?.name||"—"}</td>
            <td style={{fontSize:12,color:T.muted}}>{workstreams.find(w=>w.id===inv.workstream_id)?.name||"—"}</td>
            <td className="num" style={{color:T.muted}}>{fmtR(inv.labor_cost)}</td>
            <td className="num" style={{color:T.muted}}>{fmtR(inv.material_cost)}</td>
            <td className="num" style={{fontWeight:700,color:T.gold}}>{fmtR(inv.total_cost)}</td>
            <td>
              <button onClick={()=>viewProjectLines(inv)}
                style={{background:"none",border:`1px solid ${T.border}`,borderRadius:5,color:T.muted,fontSize:11,cursor:"pointer",padding:"3px 9px"}}>
                Labor
              </button>
            </td>
          </tr>
        ))}
        {sortedProjectInvoices.length===0 && <tr><td colSpan={7} className="empty">No project logs invoiced this month</td></tr>}
      </tbody>
    </table></div>

    {openProjectInvoice && (
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setOpenProjectInvoice(null)}>
        <div className="modal">
          <div className="modal-title">Labor <span>{projects.find(p=>p.id===openProjectInvoice.project_id)?.name||"Project"}</span></div>
          {loadingProjectLines ? (
            <div style={{fontSize:12,color:T.muted}}>Loading…</div>
          ) : (
            <div className="tbl-wrap"><table className="tbl" style={{minWidth:0}}>
              <thead><tr><th>Employee</th><th>Casual</th><th className="num">Daily Rate</th><th className="num">Cost</th></tr></thead>
              <tbody>
                {projectLaborLines.map(l=>(
                  <tr key={l.id}>
                    <td style={{fontWeight:600}}>{l.employee_name}</td>
                    <td style={{fontSize:12,color:T.muted}}>{l.is_casual?"Yes":"—"}</td>
                    <td className="num" style={{color:T.muted}}>{fmtR(l.daily_rate)}</td>
                    <td className="num" style={{fontWeight:700,color:T.gold}}>{fmtR(l.line_cost)}</td>
                  </tr>
                ))}
                {projectLaborLines.length===0 && <tr><td colSpan={4} className="empty">No labor lines found</td></tr>}
              </tbody>
            </table></div>
          )}
          <div style={{display:"flex",gap:9,marginTop:16}}>
            <button className="btn btn-ghost" onClick={()=>setOpenProjectInvoice(null)}>Close</button>
          </div>
        </div>
      </div>
    )}
  </>);
}

// ─── PROJECTS ────────────────────────────────────────────────────────────────
// Multi-week development projects (trail building, water pipe, building
// finishes, etc.) — tracked via projects / project_workstreams /
// project_progress_logs, with progress/rate/finish-date math computed live
// by the project_workstream_status view (never stored, see
// add_maintenance_projects.sql — always re-derived from the logs at read
// time). Loaded company-wide like jobMaterials/templateMaterials, not
// scoped to the global location switcher — a project is naturally
// something you'd check across lodges, so it gets its own location filter
// (defaults to All) instead.

const PROJECT_STATUS_LABEL = { planning:"Planning", active:"Active", complete:"Complete" };
const WORKSTREAM_UNIT_LABEL = { km:"km", m:"m", percent:"%" };

// Days vs weeks for a workstream's "Your Estimate" (2026-08-25) — the
// underlying column (estimate_weeks) and everything project_workstream_status
// computes from it (actual/needed rate, projected finish date) NEVER
// changes shape or unit; these two helpers just convert what a person
// types/sees in the New/Edit Workstream forms, so a 2-3 day project doesn't
// have to be entered as "0.4 weeks". estimate_unit only remembers which
// unit the number was originally typed in.
function estimateWeeksFromInput(value, unit) {
  const n = parseFloat(value);
  if (!(n > 0)) return null;
  return unit === "days" ? n / 7 : n;
}
function estimateInputFromWeeks(weeks, unit) {
  if (weeks == null) return "";
  const n = unit === "days" ? weeks * 7 : weeks;
  return String(Math.round(n * 100) / 100);
}
// Display-only conversion of a per-week rate (what project_workstream_status
// always returns) into "/day" for a workstream whose estimate was entered
// in days — the view's own numbers never change, only how they're shown.
function fmtRatePerWeek(perWeek, unit) {
  if (perWeek == null) return "—";
  return unit === "days" ? `${fmtN(perWeek/7)} /day` : `${fmtN(perWeek)} /wk`;
}

function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  const t = new Date(); t.setHours(0,0,0,0);
  return Math.round((d - t) / 86400000);
}
function fmtQty(n, unit) {
  const v = Number(n || 0);
  // Percent-unit quantities are stored as plain 0-100 numbers (type 100
  // to mean "100%"), same scale a person naturally types into the Target
  // Qty / Qty Done fields — NOT a 0-1 fraction. (Was previously *100'd
  // here on the wrong assumption, which is why 100 rendered as 10000%.)
  return unit === "percent" ? `${Math.round(v)}%` : `${fmtN(v)} ${WORKSTREAM_UNIT_LABEL[unit]||""}`;
}
function statusBadgeColor(s) {
  return s === "on_track" ? T.ok : s === "behind" ? T.danger : s === "complete" ? T.gold : T.muted;
}
function statusBadgeLabel(s) {
  return s === "on_track" ? "On Track" : s === "behind" ? "Behind" : s === "complete" ? "Complete" : "No Data Yet";
}

function ProjectsPage({ locId, projects, workstreams, workstreamStatus, progressLogs,
                         progressMaterials, setProgressMaterials, progressCrew, setProgressCrew,
                         setProjects, setWorkstreams, setProgressLogs, setProjectInvoices,
                         onIssuesRemoved, refreshWorkstreamStatus,
                         hrEmployees, hrScheduleLocations, hrLeave, itemsByLoc, purchasesByLoc, isAdmin, companyId }) {
  const [locFilter, setLocFilter] = useState("all");
  const [openProjectId, setOpenProjectId] = useState(null);
  const [showNewProject, setShowNewProject] = useState(false);
  // Completed projects (2026-08-26, Thijs: "it must go somewhere... but I
  // also don't want to keep it as a long list with all old projects among
  // the scheduled and active ones") — never deleted (historical cost/labor
  // data stays intact), just hidden from the default list by default. Uses
  // the existing projects.status==="complete" (already settable via the
  // Status dropdown in ProjectDetail) rather than inventing a new field.
  const [showCompleted, setShowCompleted] = useState(false);

  const locScoped = useMemo(()=>
    locFilter==="all" ? projects : projects.filter(p=>p.location_id===locFilter)
  ,[projects, locFilter]);
  const visibleProjects = useMemo(()=>
    showCompleted ? locScoped : locScoped.filter(p=>p.status!=="complete")
  ,[locScoped, showCompleted]);
  const completedCount = useMemo(()=>
    locScoped.filter(p=>p.status==="complete").length
  ,[locScoped]);

  const statusByWsId = useMemo(()=>{
    const m={}; workstreamStatus.forEach(s=>{m[s.id]=s;}); return m;
  },[workstreamStatus]);

  const wsByProject = useMemo(()=>{
    const m={}; workstreams.forEach(w=>{(m[w.project_id]||(m[w.project_id]=[])).push(w);}); return m;
  },[workstreams]);

  const openProject = openProjectId ? projects.find(p=>p.id===openProjectId) : null;

  if (openProject) {
    return (
      <ProjectDetail project={openProject} workstreams={wsByProject[openProject.id]||[]}
        statusByWsId={statusByWsId} progressLogs={progressLogs}
        progressMaterials={progressMaterials} setProgressMaterials={setProgressMaterials}
        progressCrew={progressCrew} setProgressCrew={setProgressCrew}
        setWorkstreams={setWorkstreams} setProgressLogs={setProgressLogs}
        setProjectInvoices={setProjectInvoices} onIssuesRemoved={onIssuesRemoved}
        setProjects={setProjects} refreshWorkstreamStatus={refreshWorkstreamStatus}
        hrEmployees={hrEmployees} hrScheduleLocations={hrScheduleLocations} hrLeave={hrLeave}
        items={itemsByLoc[openProject.location_id]||[]}
        purchases={purchasesByLoc[openProject.location_id]||[]}
        isAdmin={isAdmin} companyId={companyId}
        onBack={()=>setOpenProjectId(null)}/>
    );
  }

  return (<>
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Projects</div><div className="strip-val">{visibleProjects.length}</div></div>
      <div className="strip-item"><div className="strip-label">Active</div>
        <div className="strip-val">{visibleProjects.filter(p=>p.status==="active").length}</div></div>
      <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <select value={locFilter} onChange={e=>setLocFilter(e.target.value)}
          style={{background:"rgba(0,0,0,.25)",border:`1px solid ${T.border}`,borderRadius:6,
            padding:"9px 11px",color:T.cream,fontFamily:"'Inter',sans-serif",fontSize:13,outline:"none"}}>
          <option value="all">All Locations</option>
          {LOCATIONS.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {completedCount>0 && (
          <button className="btn btn-ghost" onClick={()=>setShowCompleted(v=>!v)}>
            {showCompleted ? "Hide Completed" : `Show Completed (${completedCount})`}
          </button>
        )}
        {isAdmin && <button className="btn btn-primary" onClick={()=>setShowNewProject(true)}>+ New Project</button>}
      </div>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14}}>
      {visibleProjects.map(p=>{
        const ws = wsByProject[p.id]||[];
        // Aggregate progress = average of each workstream's own % of
        // target, not a sum across differing units (km/m/%).
        const fractions = ws.map(w=>{
          const s = statusByWsId[w.id];
          const target = Number(w.target_qty||0);
          if (target<=0) return 1;
          const done = s ? Number(s.cumulative_done||0) : Number(w.baseline_qty||0);
          return Math.max(0, Math.min(1, done/target));
        });
        const pct = fractions.length ? Math.round((fractions.reduce((a,b)=>a+b,0)/fractions.length)*100) : 0;
        // project_workstream_status's own computed status never returns
        // "complete" (see the comment in WeeklyLogForm.save() /
        // ProjectDetail) — a workstream counts as complete here once it's
        // either closed (w.status==="complete") or has reached its target
        // (remaining<=0) but hasn't been closed yet.
        const wsEffective = ws.map(w=>{
          if (w.status==="complete") return "complete";
          const s = statusByWsId[w.id];
          if (s && Number(s.remaining)<=0) return "complete";
          return s?.status || "no_data";
        });
        const rollup = wsEffective.includes("behind") ? "behind"
          : wsEffective.includes("on_track") ? "on_track"
          : wsEffective.length && wsEffective.every(s=>s==="complete") ? "complete" : "no_data";
        const days = daysUntil(p.target_end_date);
        const loc = LOCATIONS.find(l=>l.id===p.location_id);
        return (
          <div key={p.id} onClick={()=>setOpenProjectId(p.id)}
            style={{background:"rgba(0,0,0,.2)",border:`1px solid ${T.border}`,borderRadius:10,padding:16,cursor:"pointer"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
              <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:18,fontWeight:600,color:T.cream}}>{p.name}</div>
              {loc && <span className="badge badge-neu" style={{flexShrink:0,marginLeft:8}}>{loc.id}</span>}
            </div>
            <div style={{fontSize:11,color:T.muted,marginBottom:10}}>
              {PROJECT_STATUS_LABEL[p.status]||p.status} · {ws.length} workstream{ws.length===1?"":"s"}
            </div>
            <div style={{height:7,background:"rgba(0,0,0,.3)",borderRadius:4,overflow:"hidden",marginBottom:8}}>
              <div style={{height:"100%",width:`${pct}%`,background:T.gold,borderRadius:4}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span className="badge" style={{background:`${statusBadgeColor(rollup)}22`,color:statusBadgeColor(rollup),border:`1px solid ${statusBadgeColor(rollup)}55`}}>
                {statusBadgeLabel(rollup)}
              </span>
              <span style={{fontSize:11,color:T.muted}}>
                {days==null ? "No target date" : days<0 ? `${-days}d overdue` : `${days}d to target`}
              </span>
            </div>
          </div>
        );
      })}
      {visibleProjects.length===0 && <div className="empty">No projects yet.</div>}
    </div>

    {showNewProject && (
      <NewProjectForm locId={locId} companyId={companyId} setProjects={setProjects}
        onClose={()=>setShowNewProject(false)}/>
    )}
  </>);
}

function NewProjectForm({ locId, companyId, setProjects, onClose }) {
  const isoToday = new Date().toISOString().slice(0,10);
  const [form, setForm] = useState({name:"",description:"",location_id:locId,start_date:isoToday,target_end_date:"",status:"planning"});
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const row = {
        id: uid(), company_id: companyId, location_id: form.location_id, name: form.name.trim(),
        description: form.description.trim()||null,
        start_date: form.start_date||null, target_end_date: form.target_end_date||null,
        status: form.status,
      };
      const ins = await sb.insert("projects", row);
      setProjects(p=>[...p, ins]);
      onClose();
    } catch(e) { alert("Save failed: "+e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-title">New <span>Project</span></div>
        <div className="field"><label>Name</label><input type="text" value={form.name} onChange={f("name")}/></div>
        <div className="field"><label>Description</label><input type="text" value={form.description} onChange={f("description")}/></div>
        <div className="grid2">
          <div className="field"><label>Location</label>
            <select value={form.location_id} onChange={f("location_id")}>
              {LOCATIONS.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Status</label>
            <select value={form.status} onChange={f("status")}>
              {Object.entries(PROJECT_STATUS_LABEL).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div className="grid2">
          <div className="field"><label>Start Date</label><input type="date" value={form.start_date} onChange={f("start_date")}/></div>
          <div className="field"><label>Target End Date</label><input type="date" value={form.target_end_date} onChange={f("target_end_date")}/></div>
        </div>
        <div style={{display:"flex",gap:9}}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving?"Saving...":"Create Project"}</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ProjectDetail({ project, workstreams, statusByWsId, progressLogs, progressMaterials, setProgressMaterials,
                          progressCrew, setProgressCrew, setProjectInvoices, onIssuesRemoved,
                          setWorkstreams, setProgressLogs, setProjects, refreshWorkstreamStatus,
                          hrEmployees, hrScheduleLocations, hrLeave, items, purchases, isAdmin, companyId, onBack }) {
  const [logFor, setLogFor] = useState(null);
  const [editWs, setEditWs] = useState(null);
  const [showNewWs, setShowNewWs] = useState(false);
  const [historyFor, setHistoryFor] = useState(null);
  // Reuses project_workstreams' own pre-existing (previously unused) status
  // column as the "closed" flag — status:"complete" means logging is done
  // and the workstream is closed out; anything else is still open. See
  // closeWorkstream/reopenWorkstream + the popup below.
  const [reachedTarget, setReachedTarget] = useState(null); // {workstream, statusRow}

  const closeWorkstream = async (ws) => {
    try {
      await sb.update("project_workstreams", ws.id, {status:"complete"});
      setWorkstreams(p=>p.map(w=>w.id===ws.id?{...w,status:"complete"}:w));
    } catch(e) { alert("Error: "+e.message); }
    setReachedTarget(null);
  };
  const reopenWorkstream = async (ws) => {
    try {
      await sb.update("project_workstreams", ws.id, {status:"on_track"});
      setWorkstreams(p=>p.map(w=>w.id===ws.id?{...w,status:"on_track"}:w));
    } catch(e) { alert("Error: "+e.message); }
  };

  const latestCrewFor = wsId => {
    const logs = progressLogs.filter(l=>l.workstream_id===wsId);
    if (!logs.length) return null;
    const latest = logs.reduce((a,b)=> (a.week_ending>b.week_ending?a:b));
    return latest.crew_size;
  };

  const days = daysUntil(project.target_end_date);

  const changeProjectStatus = async (status) => {
    try {
      await sb.update("projects", project.id, {status});
      setProjects(p=>p.map(x=>x.id===project.id?{...x,status}:x));
    } catch(e){ alert("Error: "+e.message); }
  };

  const deleteProject = async () => {
    if (!window.confirm(`Delete "${project.name}" and all its workstreams/logs?`)) return;
    try {
      await sb.delete("projects", project.id);
      setProjects(p=>p.filter(x=>x.id!==project.id));
      onBack();
    } catch(e){ alert("Error: "+e.message); }
  };

  return (<>
    <button className="btn btn-ghost btn-sm" onClick={onBack} style={{marginBottom:12}}>&#8592; All Projects</button>

    <div className="strip">
      <div className="strip-item"><div className="strip-label">Status</div>
        <div className="strip-val" style={{fontSize:16}}>
          {isAdmin ? (
            <select value={project.status} onChange={e=>changeProjectStatus(e.target.value)}
              style={{background:"rgba(0,0,0,.25)",border:`1px solid ${T.border}`,borderRadius:6,
                padding:"6px 8px",color:T.cream,fontSize:13}}>
              {Object.entries(PROJECT_STATUS_LABEL).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select>
          ) : (PROJECT_STATUS_LABEL[project.status]||project.status)}
        </div>
      </div>
      <div className="strip-item"><div className="strip-label">Target End</div>
        <div className="strip-val" style={{fontSize:16}}>{project.target_end_date||"—"}</div></div>
      <div className="strip-item"><div className="strip-label">Days Left</div>
        <div className="strip-val" style={{fontSize:16,color:days<0?T.danger:T.cream}}>{days==null?"—":days}</div></div>
      {isAdmin && <div style={{marginLeft:"auto",display:"flex",gap:8}}>
        <button className="btn btn-ghost" onClick={()=>setShowNewWs(true)}>+ Add Workstream</button>
        <button className="btn btn-danger" onClick={deleteProject}>Delete Project</button>
      </div>}
    </div>

    {project.description && <div style={{fontSize:13,color:T.muted,marginBottom:16,lineHeight:1.6}}>{project.description}</div>}

    <div className="tbl-wrap"><table className="tbl">
      <thead><tr>
        <th>Workstream</th><th className="num">Target</th><th className="num">Done</th><th className="num">Remaining</th>
        <th className="num">Crew</th><th className="num">Actual Rate</th><th className="num">Rate Needed</th>
        <th>Status</th><th>Projected Finish</th><th className="num">Budget vs Actual</th><th></th>
      </tr></thead>
      <tbody>
        {workstreams.map(w=>{
          const s = statusByWsId[w.id];
          const crew = latestCrewFor(w.id);
          const closed = w.status==="complete";
          // project_workstream_status's own computed status never returns
          // "complete" (remaining<=0 maps to 'on_track' — see the comment
          // in WeeklyLogForm.save()), so "reached target but not yet closed"
          // has to be read off remaining directly, not s?.status.
          const atTarget = !closed && s?.remaining!=null && Number(s.remaining)<=0;
          return (
            <tr key={w.id} style={closed?{opacity:.6}:undefined}>
              <td style={{fontWeight:600}}>{w.name}</td>
              <td className="num">{fmtQty(w.target_qty, w.unit)}</td>
              <td className="num">{fmtQty(s?.cumulative_done ?? w.baseline_qty, w.unit)}</td>
              <td className="num">{fmtQty(s?.remaining ?? (w.target_qty-w.baseline_qty), w.unit)}</td>
              <td className="num" style={{color:T.muted}}>{crew==null?"—":crew}</td>
              <td className="num" style={{color:T.muted}}>{fmtRatePerWeek(s?.actual_rate_per_week, w.estimate_unit)}</td>
              <td className="num" style={{color:T.muted}}>{fmtRatePerWeek(s?.rate_needed_per_week, w.estimate_unit)}</td>
              <td>
                {closed ? (
                  <span className="badge" style={{background:`${T.gold}22`,color:T.gold,border:`1px solid ${T.gold}55`}}>Closed</span>
                ) : atTarget ? (
                  <span className="badge" style={{background:`${T.gold}22`,color:T.gold,border:`1px solid ${T.gold}55`}}>Complete</span>
                ) : (
                  <span className="badge" style={{background:`${statusBadgeColor(s?.status)}22`,color:statusBadgeColor(s?.status),border:`1px solid ${statusBadgeColor(s?.status)}55`}}>
                    {statusBadgeLabel(s?.status)}
                  </span>
                )}
              </td>
              <td style={{fontSize:12,color:T.muted}}>{s?.projected_finish_date||"—"}</td>
              <td className="num" style={{color: s?.budget_variance==null?T.muted: s.budget_variance<0?T.danger:T.ok}}>
                {w.budget_cost==null?"No budget set": s?.budget_variance==null?"—":fmtR(s.budget_variance)}
              </td>
              <td style={{display:"flex",gap:5}}>
                {!closed && <button className="btn btn-primary btn-sm" onClick={()=>setLogFor(w)}>+ Log</button>}
                {isAdmin && <button className="btn btn-ghost btn-sm" onClick={()=>setHistoryFor(w)}>History</button>}
                {isAdmin && <button className="btn btn-ghost btn-sm" onClick={()=>setEditWs(w)}>Edit</button>}
                {isAdmin && closed && <button className="btn btn-ghost btn-sm" onClick={()=>reopenWorkstream(w)}>Reopen</button>}
              </td>
            </tr>
          );
        })}
        {workstreams.length===0 && <tr><td colSpan={11} className="empty">No workstreams yet.</td></tr>}
      </tbody>
    </table></div>

    <WorkstreamSuggestions project={project} workstreams={workstreams} statusByWsId={statusByWsId}
      hrEmployees={hrEmployees} hrScheduleLocations={hrScheduleLocations} hrLeave={hrLeave}/>

    {logFor && (
      <WeeklyLogForm workstream={logFor} project={project} items={items} purchases={purchases} companyId={companyId} hrEmployees={hrEmployees}
        setProgressLogs={setProgressLogs} setProgressMaterials={setProgressMaterials} setProgressCrew={setProgressCrew}
        refreshWorkstreamStatus={refreshWorkstreamStatus}
        onTargetReached={(ws,statusRow)=>setReachedTarget({workstream:ws, statusRow})}
        onClose={()=>setLogFor(null)}/>
    )}
    {reachedTarget && (
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setReachedTarget(null)}>
        <div className="modal" style={{maxWidth:420}}>
          <div className="modal-title">Target Reached <span>{reachedTarget.workstream.name}</span></div>
          <div style={{fontSize:13,color:T.muted,lineHeight:1.6,marginBottom:16}}>
            This workstream has reached its target — {fmtQty(reachedTarget.statusRow.cumulative_done, reachedTarget.workstream.unit)} of{" "}
            {fmtQty(reachedTarget.workstream.target_qty, reachedTarget.workstream.unit)}. Mark it as complete and close it out?
            You can still reopen it later if needed.
          </div>
          <div style={{display:"flex",gap:9}}>
            <button className="btn btn-primary" onClick={()=>closeWorkstream(reachedTarget.workstream)}>Mark Complete</button>
            <button className="btn btn-ghost" onClick={()=>setReachedTarget(null)}>Not Yet</button>
          </div>
        </div>
      </div>
    )}
    {editWs && (
      <EditWorkstreamForm workstream={editWs} setWorkstreams={setWorkstreams}
        refreshWorkstreamStatus={refreshWorkstreamStatus}
        onClose={()=>setEditWs(null)}/>
    )}
    {showNewWs && (
      <NewWorkstreamForm project={project} companyId={companyId} setWorkstreams={setWorkstreams}
        refreshWorkstreamStatus={refreshWorkstreamStatus}
        onClose={()=>setShowNewWs(false)}/>
    )}
    {historyFor && (
      <WorkstreamLogHistory workstream={historyFor} progressLogs={progressLogs} setProgressLogs={setProgressLogs}
        progressMaterials={progressMaterials} setProgressMaterials={setProgressMaterials}
        progressCrew={progressCrew} setProgressCrew={setProgressCrew}
        setProjectInvoices={setProjectInvoices} onIssuesRemoved={onIssuesRemoved} items={items}
        refreshWorkstreamStatus={refreshWorkstreamStatus} isAdmin={isAdmin} companyId={companyId}
        onClose={()=>setHistoryFor(null)}/>
    )}
  </>);
}

// "AI Suggestions" panel (2026-08-19) — compares Thijs's own gut-feel
// estimate (estimate_weeks, entered per workstream) against the tracked
// pace, and — when a workstream is running behind the project deadline —
// suggests roughly how much crew to add to catch up. Everything here is
// read straight off project_workstream_status's estimated_finish_date /
// avg_crew_size / suggested_crew_size columns (live-computed, see
// add_project_workstream_estimates.sql) — no separate calculation here,
// just plain-language framing of numbers the view already worked out.
// Crew suggestions assume output scales roughly linearly with crew size,
// inferred from the workstream's own logged history — a rough guide, not
// a guarantee, and said as much in the copy below.
function WorkstreamSuggestions({ project, workstreams, statusByWsId, hrEmployees, hrScheduleLocations, hrLeave }) {
  // Closed workstreams (status==="complete", see ProjectDetail) don't need
  // a crew/pace suggestion — the work is done.
  const rows = workstreams.map(w=>({ w, s: statusByWsId[w.id] })).filter(({w,s})=>s && w.status!=="complete");
  if (rows.length===0) return null;

  // How many Maintenance-department staff are actually on duty at this
  // project's lodge today — cross-app read from HR/Linen, see
  // maintenanceStaffEngine.js. Used to turn "you should add ~N crew" into
  // "...but you've only got M on duty here today, so you're actually short."
  const staffToday = useMemo(()=>
    availableMaintenanceStaff({ employees:hrEmployees, scheduleLocations:hrScheduleLocations, leave:hrLeave, locationId:project.location_id, date:new Date() })
  ,[hrEmployees, hrScheduleLocations, hrLeave, project.location_id]);

  return (
    <div style={{marginTop:22}}>
      <div className="section-title">AI Suggestions</div>
      <div style={{fontSize:12,color:T.muted,marginBottom:8,lineHeight:1.6}}>
        Compares your own estimate against the tracked pace, and — when a workstream is running behind —
        suggests roughly how much crew to add to still hit {project.target_end_date||"the target date"}.
        Crew suggestions assume output scales roughly linearly with crew size, based on what you've logged
        so far — a rough guide, not a guarantee.
      </div>
      <div style={{fontSize:12,color:T.muted,marginBottom:12}}>
        Maintenance staff on duty at {LOCATIONS.find(l=>l.id===project.location_id)?.name||project.location_id} today:{" "}
        <span style={{color:T.cream,fontWeight:600}}>{staffToday.count}</span>
        {staffToday.names.length>0 && <span> ({staffToday.names.join(", ")})</span>}
        <span> — from HR/Linen's schedule, so make sure this week's lodge assignments are up to date there.</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {rows.map(({w,s})=>{
          const hasLogs = s.status !== "no_data";
          let estimateNote = null;
          if (w.estimate_weeks!=null) {
            const isDays = w.estimate_unit==="days";
            let comparison = "";
            if (s.projected_finish_date && s.estimated_finish_date) {
              const diffDays = Math.round((new Date(s.projected_finish_date)-new Date(s.estimated_finish_date))/86400000);
              const diffUnits = isDays ? Math.abs(diffDays) : Math.round(Math.abs(diffDays)/7);
              const unitLabel = isDays ? `day${diffUnits===1?"":"s"}` : `week${diffUnits===1?"":"s"}`;
              comparison = diffUnits===0 ? " Tracking right on your estimate."
                : ` At the current pace it's tracking ${diffUnits} ${unitLabel} ${diffDays>0?"slower":"faster"} than you guessed.`;
            }
            const estimateDisplay = isDays ? Math.round(w.estimate_weeks*7*10)/10 : w.estimate_weeks;
            const estimateUnitLabel = isDays ? `day${estimateDisplay===1?"":"s"}` : `week${estimateDisplay===1?"":"s"}`;
            estimateNote = `You estimated ~${fmtN(estimateDisplay)} ${estimateUnitLabel}` +
              (s.estimated_finish_date?` (around ${s.estimated_finish_date}).`:".") + comparison;
          }
          // Same fix as ProjectDetail's table: the live view's own status
          // never returns "complete" (remaining<=0 maps to 'on_track'), so
          // a workstream sitting at target but not yet closed needs its own
          // override here too.
          const atTarget = s.remaining!=null && Number(s.remaining)<=0;
          return (
            <div key={w.id} style={{background:"rgba(0,0,0,.2)",border:`1px solid ${T.border}`,borderRadius:8,padding:"12px 14px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontWeight:600,color:T.cream}}>{w.name}</div>
                {atTarget ? (
                  <span className="badge" style={{background:`${T.gold}22`,color:T.gold,border:`1px solid ${T.gold}55`}}>Complete</span>
                ) : (
                  <span className="badge" style={{background:`${statusBadgeColor(s.status)}22`,color:statusBadgeColor(s.status),border:`1px solid ${statusBadgeColor(s.status)}55`}}>
                    {statusBadgeLabel(s.status)}
                  </span>
                )}
              </div>
              {!hasLogs ? (
                <div style={{fontSize:12,color:T.muted}}>No progress logged yet — nothing to compare against.</div>
              ) : atTarget ? (<>
                {/* Target reached — pace advice is meaningless now, and the
                    live view would otherwise still say "on track" here
                    (remaining<=0 maps to 'on_track'), which read as a
                    contradiction next to the gold Complete badge. */}
                {estimateNote && <div style={{fontSize:12,color:T.muted,marginBottom:4}}>{estimateNote}</div>}
                <div style={{fontSize:12,color:T.gold}}>
                  &#10003; Target reached — {fmtQty(s.cumulative_done, w.unit)} of {fmtQty(w.target_qty, w.unit)}.
                  {w.status!=="complete" && " Close it out from the workstream list when you're happy it's done."}
                </div>
              </>) : (<>
                {estimateNote && <div style={{fontSize:12,color:T.muted,marginBottom:4}}>{estimateNote}</div>}
                {s.status==="behind" && s.suggested_crew_size!=null && (() => {
                  const short = s.suggested_crew_size > staffToday.count;
                  return (
                    <div style={{fontSize:12,color:T.danger}}>
                      &#9888; At the current crew ({s.avg_crew_size!=null?`~${fmtN(s.avg_crew_size)}`:"—"}), this won't
                      make {project.target_end_date||"the target date"}. Consider bumping crew to ~{s.suggested_crew_size} to catch up.
                      {short && (
                        <> You've only got {staffToday.count} maintenance staff on duty here today — {s.suggested_crew_size-staffToday.count} short.
                        Consider pulling crew from another workstream/lodge, or bringing in temp help.</>
                      )}
                    </div>
                  );
                })()}
                {s.status==="behind" && s.suggested_crew_size==null && (
                  <div style={{fontSize:12,color:T.danger}}>&#9888; Running behind pace for the target date.</div>
                )}
                {s.status==="on_track" && (
                  <div style={{fontSize:12,color:T.ok}}>&#10003; On track to hit {project.target_end_date||"the target date"} at the current crew size.</div>
                )}
              </>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Admin-only: full log history for a single workstream, with edit/delete
// per entry — lets Thijs correct or remove data his employees logged
// (e.g. a mistaken week or a test entry), which the "+ Log" flow itself
// deliberately doesn't expose since it's meant to stay a quick weekly form.
function WorkstreamLogHistory({ workstream, progressLogs, setProgressLogs, progressMaterials, setProgressMaterials, progressCrew, setProgressCrew, setProjectInvoices, onIssuesRemoved, items, refreshWorkstreamStatus, isAdmin, companyId, onClose }) {
  const [editLog, setEditLog] = useState(null);
  const logs = progressLogs.filter(l=>l.workstream_id===workstream.id).sort((a,b)=>b.week_ending.localeCompare(a.week_ending));
  const materialsFor = logId => (progressMaterials||[])
    .filter(m=>m.progress_log_id===logId)
    .map(m=>{ const it=(items||[]).find(i=>i.id===m.item_id); return `${it?it.description:"?"} ×${fmtN(m.qty)}`; })
    .join(", ");
  // Crew names (2026-08-25) — shown as a hover tooltip on the count so the
  // table stays compact; falls back to the plain number for logs recorded
  // before this existed (or with no crew rows, e.g. a log with no pick made).
  const crewFor = logId => (progressCrew||[])
    .filter(c=>c.progress_log_id===logId)
    .map(c=>c.is_casual?`${c.worker_name} (casual)`:c.worker_name)
    .join(", ");

  // Deleting a log also has to put back the stock it issued (2026-08-26
  // inspection finding 1.3). The DB cascades the log's crew/materials/
  // invoice rows away, but the maint_issues rows created when that stock
  // was pulled are a separate ledger — before maint_issues.progress_log_id
  // existed they had no link back at all, so deleting a log silently left
  // stock deducted with nothing to explain it. Issues written since that
  // column exists are found and removed here; older ones can't be matched
  // reliably, so the user is told rather than guessed at.
  const remove = async (log) => {
    const mats = (progressMaterials||[]).filter(m=>m.progress_log_id===log.id);
    const matNote = mats.length
      ? `\n\nThis will also reverse the ${mats.length} stock issue${mats.length===1?"":"s"} logged against it.`
      : "";
    if (!window.confirm(`Delete the log for week ending ${log.week_ending}?${matNote}`)) return;
    try {
      let staleIssues = 0;
      if (mats.length) {
        const linked = await sb.select("maint_issues", `progress_log_id=eq.${log.id}&company_id=eq.${companyId}`);
        for (const iss of linked||[]) await sb.delete("maint_issues", iss.id);
        // Location-aware: the global setIssues() writes to whatever lodge
        // the top-of-page switcher is on, but Projects has its own filter,
        // so this has to target the PROJECT's lodge explicitly.
        if (linked?.length) onIssuesRemoved?.(linked.map(i=>i.id), linked[0].location_id);
        staleIssues = mats.length - (linked?.length||0);
      }
      await sb.delete("project_progress_logs", log.id);
      // Mirror the DB's own cascades in local state so the UI doesn't keep
      // showing crew/material/invoice rows for a log that no longer exists.
      setProgressLogs(p=>p.filter(l=>l.id!==log.id));
      setProgressMaterials?.(p=>p.filter(m=>m.progress_log_id!==log.id));
      setProgressCrew?.(p=>p.filter(c=>c.progress_log_id!==log.id));
      setProjectInvoices?.(p=>p.filter(i=>i.progress_log_id!==log.id));
      await refreshWorkstreamStatus?.();
      if (staleIssues > 0) {
        alert(`Log deleted. Note: ${staleIssues} of its stock issue${staleIssues===1?" was":"s were"} logged before issues were linked to progress logs, so ${staleIssues===1?"it":"they"} could not be reversed automatically — reverse ${staleIssues===1?"it":"them"} by hand on the Issues page if needed.`);
      }
    } catch(e) { alert("Error: "+e.message); }
  };

  return (<>
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal" style={{maxWidth:640}}>
        <div className="modal-title">Progress History <span>{workstream.name}</span></div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Week Ending</th><th className="num">Crew</th><th className="num">Qty Done</th>
            <th className="num">Cost</th><th>Materials</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {logs.map(l=>(
              <tr key={l.id}>
                <td className="mono" style={{fontSize:11}}>{l.week_ending}</td>
                <td className="num" style={{color:T.muted}} title={crewFor(l.id)||undefined}>{l.crew_size==null?"—":l.crew_size}</td>
                <td className="num">{fmtQty(l.qty_done, workstream.unit)}</td>
                <td className="num" style={{color:T.muted}}>{l.cost_incurred==null?"—":fmtR(l.cost_incurred)}</td>
                <td style={{fontSize:12,color:T.muted}}>{materialsFor(l.id)||"—"}</td>
                <td style={{fontSize:12,color:T.muted}}>{l.notes||"—"}</td>
                <td style={{display:"flex",gap:5}}>
                  {isAdmin && <button className="btn btn-ghost btn-sm" onClick={()=>setEditLog(l)}>Edit</button>}
                  {isAdmin && <button className="btn btn-danger btn-sm" onClick={()=>remove(l)}>x</button>}
                </td>
              </tr>
            ))}
            {logs.length===0 && <tr><td colSpan={7} className="empty">No logs yet for this workstream.</td></tr>}
          </tbody>
        </table></div>
        <div style={{display:"flex",gap:9,marginTop:14}}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
    {editLog && (
      <EditLogForm log={editLog} workstream={workstream} setProgressLogs={setProgressLogs}
        setProjectInvoices={setProjectInvoices} companyId={companyId}
        refreshWorkstreamStatus={refreshWorkstreamStatus} onClose={()=>setEditLog(null)}/>
    )}
  </>);
}

function EditLogForm({ log, workstream, setProgressLogs, setProjectInvoices, refreshWorkstreamStatus, companyId, onClose }) {
  const [form, setForm] = useState({
    week_ending: log.week_ending,
    crew_size: log.crew_size==null?"":String(log.crew_size),
    qty_done: String(log.qty_done),
    cost_incurred: log.cost_incurred==null?"":String(log.cost_incurred),
    notes: log.notes||"",
  });
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.week_ending || form.qty_done==="") { alert("Week ending and qty done are required."); return; }
    setSaving(true);
    try {
      const patch = {
        week_ending: form.week_ending,
        crew_size: form.crew_size===""?null:parseInt(form.crew_size,10),
        qty_done: parseFloat(form.qty_done)||0,
        cost_incurred: form.cost_incurred===""?null:parseFloat(form.cost_incurred),
        notes: form.notes.trim()||null,
      };
      await sb.update("project_progress_logs", log.id, patch);
      setProgressLogs(p=>p.map(l=>l.id===log.id?{...l,...patch}:l));

      // Keep this log's internal invoice in step with the log (2026-08-26
      // inspection finding 1.2 — editing a log used to leave Internal
      // Billing showing the OLD date, so an invoice could sit in the wrong
      // month entirely). Only log_date can drift: this form doesn't touch
      // crew (labor) or materials, which are what the cost figures are
      // built from. Best-effort — a log recorded before invoicing existed
      // simply has no invoice row to update, and a failure here must never
      // block the edit itself.
      if (patch.week_ending !== log.week_ending) {
        try {
          const invs = await sb.select("project_progress_invoices", `progress_log_id=eq.${log.id}&company_id=eq.${companyId}`);
          if (invs?.[0]) {
            await sb.update("project_progress_invoices", invs[0].id, { log_date: patch.week_ending });
            setProjectInvoices?.(p=>p.map(i=>i.id===invs[0].id?{...i, log_date:patch.week_ending}:i));
          }
        } catch(e) { console.error("Could not re-date progress invoice for log", log.id, e); }
      }

      await refreshWorkstreamStatus?.();
      onClose();
    } catch(e) { alert("Save failed: "+e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-title">Edit Log <span>{workstream.name}</span></div>
        <div className="grid2">
          <div className="field"><label>Week Ending</label><input type="date" value={form.week_ending} onChange={f("week_ending")}/></div>
          <div className="field"><label>Crew Size</label><input type="number" inputMode="decimal" value={form.crew_size} onChange={f("crew_size")}/></div>
        </div>
        <div className="grid2">
          <div className="field"><label>Qty Done This Week ({WORKSTREAM_UNIT_LABEL[workstream.unit]})</label>
            <input type="number" inputMode="decimal" step="0.01" value={form.qty_done} onChange={f("qty_done")}/></div>
          <div className="field"><label>Cost Incurred (R)</label><input type="number" inputMode="decimal" step="0.01" value={form.cost_incurred} onChange={f("cost_incurred")}/></div>
        </div>
        <div className="field"><label>Notes</label><input type="text" value={form.notes} onChange={f("notes")}/></div>
        <div style={{display:"flex",gap:9}}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving?"Saving...":"Save Changes"}</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function WeeklyLogForm({ workstream, project, items, purchases, companyId, hrEmployees, setProgressLogs, setProgressCrew, setProgressMaterials, refreshWorkstreamStatus, onTargetReached, onClose }) {
  const isoToday = new Date().toISOString().slice(0,10);
  const [form, setForm] = useState({week_ending:isoToday, qty_done:"", cost_incurred:"", notes:""});
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));
  const [saving, setSaving] = useState(false);

  const staff = useMaintenanceStaffList(hrEmployees);
  const [ticked, setTicked]   = useState({}); // employee_id -> true
  const [casuals, setCasuals] = useState([]); // ["name", ...]
  const crewList = [
    ...staff.filter(s=>ticked[s.id]).map(s=>({employee_id:s.id, worker_name:s.name, is_casual:false})),
    ...casuals.filter(c=>c.trim()).map(c=>({employee_id:null, worker_name:c.trim(), is_casual:true})),
  ];

  // Materials from stock (2026-08-25) — same idea as a job card's Materials
  // Used section: pick items + qty here, and this issues the stock exactly
  // like a maintenance job does, instead of only tracking a manual Rand
  // figure in "Cost Incurred".
  const [materials, setMaterials] = useState([]); // [{item_id, qty}]
  const addMaterial    = ()=>setMaterials(r=>[...r,{item_id:"",qty:""}]);
  const updMaterial    = (i,k,v)=>setMaterials(r=>r.map((x,j)=>j===i?{...x,[k]:v}:x));
  const removeMaterial = i=>setMaterials(r=>r.filter((_,j)=>j!==i));

  const save = async () => {
    if (!form.week_ending || form.qty_done==="") { alert("Week ending and qty done are required."); return; }
    setSaving(true);
    try {
      const row = {
        id: uid(), company_id: companyId, workstream_id: workstream.id, week_ending: form.week_ending,
        crew_size: crewList.length || null,
        qty_done: parseFloat(form.qty_done)||0,
        cost_incurred: form.cost_incurred===""?null:parseFloat(form.cost_incurred),
        notes: form.notes.trim()||null,
      };
      const ins = await sb.insert("project_progress_logs", row);
      setProgressLogs(p=>[...p, ins]);

      // Who was on the crew this week (2026-08-25) — HR staff ticked above
      // plus any casual/temp workers, each its own row so a later per-
      // person labor-cost report has real names, not just a count.
      const newCrew = [];
      for(const c of crewList){
        const crewRow = { id: uid(), progress_log_id: ins.id, employee_id: c.employee_id,
          worker_name: c.worker_name, is_casual: c.is_casual, company_id: companyId };
        await sb.insert("project_progress_crew", crewRow);
        newCrew.push(crewRow);
      }
      if(newCrew.length) setProgressCrew(p=>[...p, ...newCrew]);

      // Issue stock for each material used, same as a job's Materials Used —
      // and keep a project_progress_materials row so the workstream's own
      // history shows what was pulled from stock, not just a cost figure.
      const newProgressMats = [];
      for(const m of materials){
        const qty = parseFloat(m.qty)||0;
        if(!m.item_id || qty<=0) continue;
        await sb.insert("maint_issues", {
          id: uid(), location_id: project.location_id, item_id: m.item_id, date: form.week_ending,
          qty, destination_id: null, dest_name: null,
          notes: `Project: ${project.name} — ${workstream.name}`,
          // Hard link back to the log that caused this issue (2026-08-26) —
          // before this, deleting a log left its stock deducted with only a
          // free-text note to explain it, and nothing to reverse it by.
          progress_log_id: ins.id,
          company_id: companyId,
        });
        const pmRow = { id: uid(), progress_log_id: ins.id, item_id: m.item_id, qty, company_id: companyId };
        await sb.insert("project_progress_materials", pmRow);
        newProgressMats.push(pmRow);
      }
      if(newProgressMats.length) setProgressMaterials(p=>[...p, ...newProgressMats]);

      // Internal Invoicing (2026-08-26) — bill this progress log's crew +
      // materials back to the project's lodge, same as a job card does at
      // completion. Never blocks the log from saving on failure.
      await generateProgressInvoice({
        progressLog: ins, project, workstream, crewList, materialLines: newProgressMats,
        items, purchases, companyId,
      });

      await refreshWorkstreamStatus?.();

      // If this log pushed the workstream to (or past) its target, offer to
      // close it out (2026-08-26, Thijs: "when a workstream reaches its
      // target after filling in the logs, I want it showing as completed...
      // and with that also close it"). Re-fetches this one workstream's
      // live status row directly rather than trusting props here, since
      // refreshWorkstreamStatus's setState may not have flushed to this
      // component's props yet by the time we check.
      //
      // IMPORTANT: project_workstream_status's own computed `status` column
      // never actually returns "complete" — its CASE only ever produces
      // 'no_data' / 'on_track' / 'behind' (remaining<=0 maps to 'on_track',
      // see add_project_workstream_estimates.sql). "Complete" only exists
      // as a value of the STORED status column (aliased manual_status on
      // this view), which is what closeWorkstream() sets. So "reached
      // target" has to be read off `remaining <= 0` directly, not `status`.
      if (workstream.status !== "complete") {
        try {
          const rows = await sb.select("project_workstream_status", `id=eq.${workstream.id}&company_id=eq.${companyId}`);
          const row = rows?.[0];
          if (row && row.manual_status !== "complete" && Number(row.remaining) <= 0) {
            onTargetReached?.(workstream, row);
          }
        } catch(e) { /* non-critical — worst case they just don't get the popup */ }
      }

      onClose();
    } catch(e) { alert("Save failed: "+e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-title">Progress Log <span>{workstream.name}</span></div>
        <div className="field"><label>Date</label><input type="date" value={form.week_ending} onChange={f("week_ending")}/></div>

        <CrewPicker hrEmployees={hrEmployees} ticked={ticked} setTicked={setTicked} casuals={casuals} setCasuals={setCasuals}/>

        <div className="grid2">
          <div className="field"><label>Qty Done ({WORKSTREAM_UNIT_LABEL[workstream.unit]})</label>
            <input type="number" inputMode="decimal" step="0.01" value={form.qty_done} onChange={f("qty_done")}/></div>
          <div className="field"><label>Cost Incurred (R, optional)</label><input type="number" inputMode="decimal" step="0.01" value={form.cost_incurred} onChange={f("cost_incurred")}/></div>
        </div>

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
          <div className="section-title" style={{margin:0}}>Materials From Stock</div>
          <button className="btn btn-ghost btn-sm" onClick={addMaterial}>+ Add Item</button>
        </div>
        <div style={{fontSize:11,color:T.muted,marginBottom:10,lineHeight:1.5}}>
          Optional — anything pulled from stock for this workstream. This issues the stock, same as a job card.
        </div>
        {materials.length===0 && (
          <div style={{fontSize:11,color:T.muted,marginBottom:14}}>Nothing added.</div>
        )}
        {materials.length>0 && (
          <div style={{marginBottom:14}}>
            {materials.map((m,i)=>(
              <div key={i} style={{display:"flex",gap:7,marginBottom:7,alignItems:"center"}}>
                <SearchableSelect
                  value={m.item_id}
                  onChange={v=>updMaterial(i,"item_id",v)}
                  options={items.map(it=>({value:it.id,label:`${it.description} (${it.unit})`}))}
                  placeholder="-- Select item --"
                  style={{flex:1}}
                  inputStyle={{...searchSelectInput,padding:"9px 10px",fontSize:14}}
                />
                <input className="count-input" type="number" inputMode="decimal" placeholder="Qty" value={m.qty}
                  onChange={e=>updMaterial(i,"qty",e.target.value)}/>
                <button className="btn btn-danger btn-sm" onClick={()=>removeMaterial(i)}>x</button>
              </div>
            ))}
          </div>
        )}

        <div className="field"><label>Notes</label><input type="text" value={form.notes} onChange={f("notes")}/></div>
        <div style={{display:"flex",gap:9}}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving?"Saving...":"Save Log"}</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function EditWorkstreamForm({ workstream, setWorkstreams, refreshWorkstreamStatus, onClose }) {
  const [form, setForm] = useState({...workstream, target_qty:String(workstream.target_qty), baseline_qty:String(workstream.baseline_qty),
    budget_cost: workstream.budget_cost==null?"":String(workstream.budget_cost),
    estimate_unit: workstream.estimate_unit||"weeks",
    estimate_value: estimateInputFromWeeks(workstream.estimate_weeks, workstream.estimate_unit||"weeks")});
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const patch = {
        name: form.name.trim(), unit: form.unit,
        target_qty: parseFloat(form.target_qty)||0, baseline_qty: parseFloat(form.baseline_qty)||0,
        baseline_date: form.baseline_date||null,
        budget_cost: form.budget_cost===""?null:parseFloat(form.budget_cost),
        estimate_unit: form.estimate_unit,
        estimate_weeks: estimateWeeksFromInput(form.estimate_value, form.estimate_unit),
        status: form.status,
      };
      await sb.update("project_workstreams", workstream.id, patch);
      setWorkstreams(p=>p.map(w=>w.id===workstream.id?{...w,...patch}:w));
      await refreshWorkstreamStatus?.();
      onClose();
    } catch(e) { alert("Save failed: "+e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!window.confirm(`Delete workstream "${workstream.name}" and all its logs?`)) return;
    try {
      await sb.delete("project_workstreams", workstream.id);
      setWorkstreams(p=>p.filter(w=>w.id!==workstream.id));
      await refreshWorkstreamStatus?.();
      onClose();
    } catch(e) { alert("Error: "+e.message); }
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-title">Edit <span>Workstream</span></div>
        <div className="field"><label>Name</label><input type="text" value={form.name} onChange={f("name")}/></div>
        <div className="grid2">
          <div className="field"><label>Unit</label>
            <select value={form.unit} onChange={f("unit")}>
              {["km","m","percent"].map(u=><option key={u} value={u}>{WORKSTREAM_UNIT_LABEL[u]}</option>)}
            </select>
          </div>
          <div className="field"><label>Status</label>
            <select value={form.status} onChange={f("status")}>
              {["not_started","on_track","behind","complete"].map(s=><option key={s} value={s}>{s.replace("_"," ")}</option>)}
            </select>
          </div>
        </div>
        <div className="grid2">
          <div className="field"><label>Target Qty</label><input type="number" inputMode="decimal" step="0.01" value={form.target_qty} onChange={f("target_qty")}/></div>
          <div className="field"><label>Baseline Qty</label><input type="number" inputMode="decimal" step="0.01" value={form.baseline_qty} onChange={f("baseline_qty")}/></div>
        </div>
        <div className="grid2">
          <div className="field"><label>Baseline Date</label><input type="date" value={form.baseline_date||""} onChange={f("baseline_date")}/></div>
          <div className="field"><label>Budget Cost (R, optional)</label><input type="number" inputMode="decimal" step="0.01" value={form.budget_cost} onChange={f("budget_cost")}/></div>
        </div>
        <div className="field"><label>Your Estimate (optional)</label>
          <div style={{display:"flex",gap:8}}>
            <input type="number" inputMode="decimal" step="0.5" placeholder="e.g. 10" style={{flex:1}} value={form.estimate_value} onChange={f("estimate_value")}/>
            <select value={form.estimate_unit} onChange={f("estimate_unit")} style={{flex:"0 0 110px"}}>
              <option value="weeks">weeks</option>
              <option value="days">days</option>
            </select>
          </div>
        </div>
        <div style={{display:"flex",gap:9}}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving?"Saving...":"Save Changes"}</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={remove} style={{marginLeft:"auto"}}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function NewWorkstreamForm({ project, companyId, setWorkstreams, refreshWorkstreamStatus, onClose }) {
  const isoToday = new Date().toISOString().slice(0,10);
  const [form, setForm] = useState({name:"",unit:"km",target_qty:"",baseline_qty:"0",baseline_date:isoToday,budget_cost:"",estimate_unit:"weeks",estimate_value:""});
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const row = {
        id: uid(), company_id: companyId, project_id: project.id, name: form.name.trim(), unit: form.unit,
        target_qty: parseFloat(form.target_qty)||0, baseline_qty: parseFloat(form.baseline_qty)||0,
        baseline_date: form.baseline_date||null,
        budget_cost: form.budget_cost===""?null:parseFloat(form.budget_cost),
        estimate_unit: form.estimate_unit,
        estimate_weeks: estimateWeeksFromInput(form.estimate_value, form.estimate_unit),
        status: "not_started",
      };
      const ins = await sb.insert("project_workstreams", row);
      setWorkstreams(p=>[...p, ins]);
      await refreshWorkstreamStatus?.();
      onClose();
    } catch(e) { alert("Save failed: "+e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-title">Add <span>Workstream</span></div>
        <div className="field"><label>Name</label><input type="text" value={form.name} onChange={f("name")}/></div>
        <div className="grid2">
          <div className="field"><label>Unit</label>
            <select value={form.unit} onChange={f("unit")}>
              {["km","m","percent"].map(u=><option key={u} value={u}>{WORKSTREAM_UNIT_LABEL[u]}</option>)}
            </select>
          </div>
          <div className="field"><label>Target Qty</label><input type="number" inputMode="decimal" step="0.01" value={form.target_qty} onChange={f("target_qty")}/></div>
        </div>
        <div className="grid2">
          <div className="field"><label>Baseline Qty</label><input type="number" inputMode="decimal" step="0.01" value={form.baseline_qty} onChange={f("baseline_qty")}/></div>
          <div className="field"><label>Baseline Date</label><input type="date" value={form.baseline_date} onChange={f("baseline_date")}/></div>
        </div>
        <div className="field"><label>Budget Cost (R, optional)</label><input type="number" inputMode="decimal" step="0.01" value={form.budget_cost} onChange={f("budget_cost")}/></div>
        <div className="field"><label>Your Estimate (optional)</label>
          <div style={{display:"flex",gap:8}}>
            <input type="number" inputMode="decimal" step="0.5" placeholder="e.g. 10" style={{flex:1}} value={form.estimate_value} onChange={f("estimate_value")}/>
            <select value={form.estimate_unit} onChange={f("estimate_unit")} style={{flex:"0 0 110px"}}>
              <option value="weeks">weeks</option>
              <option value="days">days</option>
            </select>
          </div>
        </div>
        <div style={{display:"flex",gap:9}}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving?"Saving...":"Add Workstream"}</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── PAGES ───────────────────────────────────────────────────────────────────
const PAGES=[
  {id:"dashboard",   label:"Dashboard",    section:"Overview",   adminOnly:false},
  {id:"calendar",    label:"Calendar",     section:"Schedule",   adminOnly:false},
  {id:"projects",    label:"Projects",     section:"Schedule",   adminOnly:false},
  {id:"templates",   label:"Job Templates",section:"Schedule",   adminOnly:true},
  {id:"purchases",   label:"Purchases",    section:"Stock",      adminOnly:false},
  {id:"issues",      label:"Issues",       section:"Stock",      adminOnly:false},
  {id:"count",       label:"Stock Count",  section:"Stock",      adminOnly:false},
  {id:"orders",      label:"Orders",       section:"Stock",      adminOnly:false},
  {id:"destcosts",   label:"Destination Costs", section:"Stock", adminOnly:false},
  {id:"billing",     label:"Internal Billing", section:"Management", adminOnly:true},
  {id:"items",       label:"Stock Items",  section:"Management", adminOnly:true},
  {id:"destinations",label:"Destinations", section:"Management", adminOnly:true},
];

// ─── ROOT APP ────────────────────────────────────────────────────────────────
export default function App() {
  // undefined = still checking for an existing session, null = signed out
  const [session, setSession] = useState(undefined);
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(() => {
    const type = getAuthHashType();
    return type === "invite" || type === "recovery";
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <AuthMessageScreen>
        <p>Loading…</p>
      </AuthMessageScreen>
    );
  }

  if (!session) {
    return <Login />;
  }

  if (needsPasswordSetup) {
    return <SetPassword onDone={() => setNeedsPasswordSetup(false)} />;
  }

  // key forces CompanyProvider to reload from scratch if a different user
  // signs in without a full page refresh.
  return (
    <CompanyProvider key={session.user.id}>
      <AuthenticatedApp />
    </CompanyProvider>
  );
}

function AuthenticatedApp() {
  const {
    loading: companyLoading,
    error: companyError,
    availableCompanies,
    companyId,
    companyName,
    role,
    switchCompany,
  } = useCompany();

  const [page,          setPage]         = useState("dashboard");
  const [locId,         setLocId]        = useState("ZC");
  // 'ZC' is only a first guess: this state initialises before the lodge list
  // has loaded (CompanyContext fetches it), and another company won't have a
  // lodge called ZC at all. Once LOCATIONS is populated — and again whenever
  // it changes on a company switch — snap to the first real lodge if the
  // current pick isn't in the list (2026-08-26).
  useEffect(() => {
    if (LOCATIONS.length === 0) return
    if (!LOCATIONS.some((l) => l.id === locId)) setLocId(LOCATIONS[0].id)
  }, [companyId, locId])
  const [locPickerOpen, setLocPickerOpen]= useState(false);
  const [menuOpen,      setMenuOpen]     = useState(false);
  const [allData,       setAllData]      = useState({items:{},purchases:{},issues:{},counts:{},destinations:{},jobs:{},templates:{}});
  const [jobMaterials,     setJobMaterials]     = useState([]);
  const [templateMaterials,setTemplateMaterials]= useState([]);
  // Internal Invoicing (2026-08-26) — company-wide job invoices (one per
  // completed job, billed to its lodge/destination at cost) and the single
  // per-company settings row controlling the hourly-rate divisor. Same
  // "company-wide, not per-location" reasoning as jobMaterials/projects
  // above — see InternalBilling page + generateJobInvoice().
  const [jobInvoices,      setJobInvoices]      = useState([]);
  // Project labor invoicing (2026-08-26) — same idea, but one per progress
  // log rather than one per completed job, since Projects work has its own
  // separate completion flow. See generateProgressInvoice().
  const [projectInvoices, setProjectInvoices]   = useState([]);
  const [billingSettings,  setBillingSettings]  = useState(null);
  // Projects (2026-08-19) — company-wide, not per-location like allData,
  // same reasoning as jobMaterials/templateMaterials above: these are
  // joined by project_id/workstream_id, not location_id.
  const [projects,         setProjects]         = useState([]);
  const [workstreams,      setWorkstreams]      = useState([]);
  const [workstreamStatus, setWorkstreamStatus] = useState([]);
  const [progressLogs,     setProgressLogs]     = useState([]);
  // Materials pulled from stock against a progress log (2026-08-25) — same
  // company-wide, joined-by-id reasoning as progressLogs itself.
  const [progressMaterials,setProgressMaterials] = useState([]);
  // Who was on a workstream's crew for a given weekly log (2026-08-25) —
  // same joined-by-id reasoning, replaces the old plain crew_size number
  // with real HR staff + casual/temp worker names.
  const [progressCrew,     setProgressCrew]      = useState([]);
  // Cross-app read (2026-08-19) — HR/Linen's staff/schedule/leave tables,
  // same shared Supabase project, used only by the Projects AI Suggestions
  // panel to gauge maintenance-staff availability per lodge. See
  // maintenanceStaffEngine.js for the on/off-cycle math.
  const [hrEmployees,        setHrEmployees]        = useState([]);
  const [hrScheduleLocations,setHrScheduleLocations]= useState([]);
  const [hrLeave,            setHrLeave]            = useState([]);
  // Purchase slip photos (2026-08-12) — keyed by purchase_slips.id, loaded
  // company-wide (not per-location) since it's just a lookup for the "View
  // slip" link and the manual Attach flow, not something rendered as a list
  // of its own yet.
  const [slips,          setSlips]        = useState({});
  const onSlipAttached = (slip)=>{ if(slip) setSlips(s=>({...s,[slip.id]:slip})); };
  const [loading,       setLoading]      = useState(true);
  const [loadErr,       setLoadErr]      = useState(null);
  const isAdmin = role==="admin";

  useEffect(()=>{if(role&&!isAdmin&&page==="dashboard")setPage("purchases");},[role,isAdmin,page]);

  const loadAll=useCallback(async()=>{
    if (!companyId) return;
    setLoading(true);setLoadErr(null);
    try{
      const cf = `company_id=eq.${companyId}`;
      const[itemRows,purchRows,issueRows,countRows,destRows,jobRows,tplRows,jobMatRows,tplMatRows,slipRows,
            projectRows,workstreamRows,workstreamStatusRows,progressLogRows,progressMatRows,progressCrewRows,
            hrEmployeeRows,hrScheduleLocationRows,hrLeaveRows,creditNoteRows,
            jobInvoiceRows,billingSettingsRows,projectInvoiceRows]=await Promise.all([
        sb.select("maint_items", `active=eq.true&${cf}&order=sort_order.asc`),
        sb.select("maint_purchases", cf),
        sb.select("maint_issues", cf),
        sb.select("maint_stock_counts", cf),
        sb.select("maint_destinations", `${cf}&order=sort_order.asc`),
        sb.select("maint_jobs", cf),
        sb.select("maint_job_templates", `active=eq.true&${cf}`),
        sb.select("maint_job_materials", cf),
        sb.select("maint_template_materials", cf),
        sb.select("purchase_slips", `app=eq.maintenance&${cf}`),
        sb.select("projects", cf),
        sb.select("project_workstreams", cf),
        sb.select("project_workstream_status", cf),
        sb.select("project_progress_logs", cf),
        sb.select("project_progress_materials", cf),
        sb.select("project_progress_crew", cf),
        sb.select("hr_employees", `active=eq.true&${cf}`),
        sb.select("hr_schedule_locations", cf),
        sb.select("hr_leave", cf),
        sb.select("supplier_credit_notes", `app=eq.maintenance&${cf}`),
        sb.select("maint_job_invoices", cf).catch(()=>[]),
        sb.select("maintenance_billing_settings", cf).catch(()=>[]),
        sb.select("project_progress_invoices", cf).catch(()=>[]),
      ]);
      const slipMap={}; (slipRows||[]).forEach(s=>{slipMap[s.id]=s;});
      setSlips(slipMap);
      const byLoc=arr=>{
        const m={};LOCATIONS.forEach(l=>m[l.id]=[]);
        arr.forEach(r=>{if(m[r.location_id])m[r.location_id].push(r);});return m;
      };
      setAllData({
        items:byLoc(itemRows),
        purchases:byLoc(purchRows.map(r=>({...r,qty:+r.qty,total_cost:+r.total_cost}))),
        issues:byLoc(issueRows.map(r=>({...r,qty:+r.qty}))),
        counts:byLoc(countRows.map(r=>({...r,count_qty:+r.count_qty}))),
        destinations:byLoc(destRows),
        jobs:byLoc(jobRows),
        templates:byLoc(tplRows.map(r=>({...r,recurrence_n:+r.recurrence_n}))),
        creditNotes:byLoc(creditNoteRows.map(r=>({...r,qty:+r.qty,unit_cost:+r.unit_cost,total_credit:+r.total_credit}))),
      });
      setJobMaterials(jobMatRows.map(r=>({...r,qty_planned:+r.qty_planned,qty_used:r.qty_used==null?null:+r.qty_used})));
      setTemplateMaterials(tplMatRows.map(r=>({...r,qty:+r.qty})));
      setProjects(projectRows);
      setWorkstreams(workstreamRows.map(r=>({...r,target_qty:+r.target_qty,baseline_qty:+r.baseline_qty,budget_cost:r.budget_cost==null?null:+r.budget_cost,estimate_weeks:r.estimate_weeks==null?null:+r.estimate_weeks})));
      setWorkstreamStatus(workstreamStatusRows);
      setProgressLogs(progressLogRows.map(r=>({...r,crew_size:r.crew_size==null?null:+r.crew_size,qty_done:+r.qty_done,cost_incurred:r.cost_incurred==null?null:+r.cost_incurred})));
      setProgressMaterials(progressMatRows.map(r=>({...r,qty:+r.qty})));
      setProgressCrew(progressCrewRows);
      setHrEmployees(hrEmployeeRows);
      setHrScheduleLocations(hrScheduleLocationRows);
      setHrLeave(hrLeaveRows);
      setJobInvoices((jobInvoiceRows||[]).map(r=>({...r,labor_cost:+r.labor_cost,material_cost:+r.material_cost,total_cost:+r.total_cost})));
      setBillingSettings((billingSettingsRows||[])[0]||null);
      setProjectInvoices((projectInvoiceRows||[]).map(r=>({...r,labor_cost:+r.labor_cost,material_cost:+r.material_cost,total_cost:+r.total_cost})));
    }catch(e){setLoadErr(e.message);}
    finally{setLoading(false);}
  },[companyId]);

  // project_workstream_status is a live-computed view — after logging
  // progress or editing a workstream's target/baseline, its numbers are
  // stale until re-fetched. Re-fetching the whole app (loadAll) would work
  // but is slow/jarring for what's really a one-table refresh, so Projects
  // gets its own narrow refresh instead. Called after every write that
  // could change the computed columns (see ProjectsPage/ProjectDetail).
  const refreshWorkstreamStatus = useCallback(async()=>{
    if(!companyId) return;
    try{
      const rows = await sb.select("project_workstream_status", `company_id=eq.${companyId}`);
      setWorkstreamStatus(rows);
    }catch(e){ console.error("Failed to refresh workstream status:", e.message); }
  },[companyId]);

  useEffect(()=>{loadAll();},[loadAll]);
  const logout=async()=>{await supabase.auth.signOut();};

  // Per-location state setters
  const mkSetter = key => fn => setAllData(d=>({...d,[key]:{...d[key],[locId]:typeof fn==="function"?fn(d[key][locId]||[]):fn}}));
  const setItems        = mkSetter("items");
  const setPurchases    = mkSetter("purchases");
  const setIssues       = mkSetter("issues");
  // Location-targeted issue removal (2026-08-26) — mkSetter above always
  // writes to whatever lodge the global switcher is on, but Projects has
  // its own independent location filter, so deleting a progress log's
  // stock issues has to name the lodge explicitly instead.
  const removeIssuesAtLocation = (issueIds, locationId) => {
    if (!issueIds?.length || !locationId) return;
    const drop = new Set(issueIds);
    setAllData(d=>({...d, issues:{...d.issues, [locationId]:(d.issues[locationId]||[]).filter(i=>!drop.has(i.id))}}));
  };
  const setCounts       = mkSetter("counts");
  const setCreditNotes  = mkSetter("creditNotes");
  const setJobs         = mkSetter("jobs");
  const setTemplates    = mkSetter("templates");
  // Destinations setter needs to update across all locs since Destinations component gets all of them
  const setDestinations = fn => setAllData(d=>{
    const updated = typeof fn==="function" ? fn(d.destinations[locId]||[]) : fn;
    return {...d,destinations:{...d.destinations,[locId]:updated}};
  });

  if (companyLoading) {
    return (
      <AuthMessageScreen>
        <p>Loading your company access…</p>
      </AuthMessageScreen>
    );
  }

  if (companyError) {
    return (
      <AuthMessageScreen>
        <p style={{ color: T.danger }}>{companyError}</p>
      </AuthMessageScreen>
    );
  }

  if (!companyId) {
    return (
      <AuthMessageScreen>
        <p>Your account doesn't have access to any company yet. Contact an administrator.</p>
      </AuthMessageScreen>
    );
  }

  if(loading)return(<><style>{css}</style>
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",gap:14,background:T.bg}}>
      <img src={LOGO_DATA} alt="" style={{width:150,filter:"brightness(0) invert(1) opacity(.8)"}}/>
      <div style={{fontSize:12,color:T.muted,letterSpacing:".1em",textTransform:"uppercase"}}>Loading stock data...</div>
      <div style={{width:200,height:3,background:T.border,borderRadius:2,overflow:"hidden"}}>
        <div style={{height:"100%",background:T.gold,width:"40%",animation:"ldg 1.2s ease-in-out infinite"}}/>
      </div>
      <style>{"@keyframes ldg{0%{margin-left:0;width:30%}50%{width:60%}100%{margin-left:100%;width:0}}"}</style>
    </div>
  </>);

  if(loadErr)return(<><style>{css}</style>
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",gap:12,background:T.bg,padding:32}}>
      <div style={{fontSize:16,fontWeight:700,color:T.cream}}>Could not connect to database</div>
      <div style={{fontSize:13,color:T.muted,textAlign:"center",maxWidth:400}}>{loadErr}</div>
      <button className="btn btn-primary" onClick={loadAll}>Retry</button>
    </div>
  </>);

  const items        = allData.items[locId]       ||[];
  const purchases    = allData.purchases[locId]   ||[];
  const issues       = allData.issues[locId]      ||[];
  const counts       = allData.counts[locId]      ||[];
  const destinations = allData.destinations[locId]||[];
  const allDests     = Object.values(allData.destinations).flat();
  const jobs         = allData.jobs[locId]      ||[];
  const templates    = allData.templates[locId] ||[];
  const creditNotes  = allData.creditNotes[locId]||[];

  const visiblePages = PAGES.filter(p=>isAdmin||!p.adminOnly);
  const sections     = [...new Set(visiblePages.map(p=>p.section))];
  const current      = PAGES.find(p=>p.id===page);
  const locColor     = LOC_COLORS[locId];
  const locName      = LOCATIONS.find(l=>l.id===locId)?.name;
  const now          = new Date();
  const monthLabel   = now.toLocaleString("en-ZA",{month:"long",year:"numeric"}).toUpperCase();
  const footerDate   = now.toLocaleString("en-ZA",{month:"short",year:"numeric"});

  return (<><style>{css}</style>
    <div className="shell">

      {/* ── SIDEBAR ── */}
      <div className="sidebar">
        <div className="logo">
          <img src={LOGO_DATA} alt="Crossing Lodges" style={{width:136,filter:"brightness(0) invert(1) opacity(.88)"}}/>
          <div className="logo-sub">Maintenance</div>
        </div>
        {availableCompanies.length > 1 && (
          <div style={{ padding: "0 16px 12px" }}>
            <select
              value={companyId}
              onChange={(e) => switchCompany(e.target.value)}
              style={{
                width: "100%",
                fontSize: 12,
                padding: "6px 8px",
                background: T.panel,
                color: T.cream,
                border: `1px solid ${T.border}`,
                borderRadius: 6,
              }}
            >
              {availableCompanies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="loc-switcher">
          <div className="loc-label">Location</div>
          {LOCATIONS.map(l=>(
            <button key={l.id} className={`loc-btn${locId===l.id?` active-${l.id}`:""}`} onClick={()=>setLocId(l.id)}>
              <span className="loc-dot" style={{background:LOC_COLORS[l.id]}}/>{l.name}
            </button>
          ))}
        </div>
        <nav className="nav">
          {sections.map(sec=>(
            <div key={sec}>
              <div className="nav-section">{sec}</div>
              {visiblePages.filter(p=>p.section===sec).map(p=>(
                <button key={p.id} className={`nav-item${page===p.id?" active":""}`} onClick={()=>setPage(p.id)}>{p.label}</button>
              ))}
            </div>
          ))}
        </nav>
        <div style={{padding:"12px 16px",borderTop:`1px solid ${T.border}`,fontSize:10,color:T.muted,lineHeight:1.6}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
            <span style={{color:T.gold,fontWeight:700}}>{footerDate}</span>
            <span style={{fontSize:9,fontWeight:700,letterSpacing:".06em",textTransform:"uppercase",padding:"2px 8px",borderRadius:3,
              background:isAdmin?"rgba(184,147,90,.18)":"rgba(91,140,196,.18)",
              color:isAdmin?T.gold:"#5B8CC4",border:`1px solid ${isAdmin?"rgba(184,147,90,.4)":"rgba(91,140,196,.4)"}`}}>
              {isAdmin?"Admin":"Staff"}
            </span>
          </div>
          Modimolle, Limpopo - ZA
          <div style={{marginTop:5,display:"flex",gap:10}}>
            <button onClick={loadAll} style={{background:"none",border:"none",color:T.muted,fontSize:10,cursor:"pointer",padding:0}}>Refresh</button>
            <button onClick={logout}  style={{background:"none",border:"none",color:T.muted,fontSize:10,cursor:"pointer",padding:0}}>Sign out</button>
          </div>
        </div>
      </div>

      {/* ── MAIN ── */}
      <div className="main">
        <div className="topbar">
          <div className="page-title">{current?.label}</div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <div style={{position:"relative"}}>
              <button onClick={()=>setLocPickerOpen(v=>!v)} className="loc-badge"
                style={{background:`${locColor}22`,border:`1px solid ${locColor}55`,color:locColor}}>
                <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:locColor,flexShrink:0}}/>
                {locName}<span style={{fontSize:9,opacity:.7,marginLeft:2}}>&#9660;</span>
              </button>
              {locPickerOpen&&(<>
                <div onClick={()=>setLocPickerOpen(false)} style={{position:"fixed",inset:0,zIndex:49}}/>
                <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,zIndex:50,
                  background:T.panel,border:`1px solid ${T.border}`,borderRadius:8,overflow:"hidden",
                  minWidth:190,boxShadow:"0 8px 24px rgba(0,0,0,.5)"}}>
                  {LOCATIONS.map(l=>(
                    <button key={l.id} onClick={()=>{setLocId(l.id);setLocPickerOpen(false);}}
                      style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"10px 14px",
                        border:"none",textAlign:"left",cursor:"pointer",fontFamily:"'Inter',sans-serif",fontSize:13,fontWeight:500,
                        background:locId===l.id?"rgba(255,255,255,.06)":"transparent",
                        color:locId===l.id?LOC_COLORS[l.id]:T.muted,
                        borderBottom:l.id!=="SC"?`1px solid ${T.border}`:"none"}}>
                      <span style={{width:8,height:8,borderRadius:"50%",background:LOC_COLORS[l.id],display:"inline-block",flexShrink:0}}/>
                      {l.name}{locId===l.id&&<span style={{marginLeft:"auto"}}>&#10003;</span>}
                    </button>
                  ))}
                </div>
              </>)}
            </div>
            <span className="month-badge">{monthLabel}</span>
            <button onClick={logout} title="Sign out"
              style={{background:"none",border:`1px solid ${T.border}`,borderRadius:6,color:T.muted,fontSize:11,fontWeight:600,cursor:"pointer",padding:"5px 10px",flexShrink:0}}>
              Log out
            </button>
          </div>
        </div>

        {/* Mobile location bar */}
        <div className="mobile-loc-bar">
          {LOCATIONS.map(l=>(
            <button key={l.id} className={`mobile-loc-btn${locId===l.id?` active-${l.id}`:""}`} onClick={()=>setLocId(l.id)}>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:LOC_COLORS[l.id]}}/>{l.name}
            </button>
          ))}
          <button onClick={loadAll} style={{marginLeft:"auto",background:"none",border:"none",color:T.muted,fontSize:11,cursor:"pointer",padding:"4px 8px",flexShrink:0}}>Refresh</button>
        </div>

        <div className="section">
          {page==="dashboard"    && <Dashboard items={items} purchases={purchases} issues={issues} counts={counts}/>}
          {page==="purchases"    && <Purchases locId={locId} items={items} purchases={purchases} setPurchases={setPurchases} isAdmin={isAdmin} companyId={companyId} slips={slips} onSlipAttached={onSlipAttached} creditNotes={creditNotes} setCreditNotes={setCreditNotes} setIssues={setIssues}/>}
          {page==="issues"       && <Issues locId={locId} items={items} issues={issues} setIssues={setIssues}
                                       destinations={destinations} purchases={purchases} jobs={jobs} isAdmin={isAdmin} companyId={companyId}/>}
          {page==="count"        && <StockCount locId={locId} items={items} purchases={purchases} issues={issues} counts={counts} setCounts={setCounts} companyId={companyId}/>}
          {page==="orders"       && <Orders items={items} purchases={purchases} issues={issues} counts={counts}
                                       jobs={jobs} jobMaterials={jobMaterials} templates={templates} templateMaterials={templateMaterials}/>}
          {page==="destcosts"    && <DestinationCosts destinations={destinations} issues={issues}
                                       items={items} purchases={purchases} jobs={jobs}/>}
          {page==="calendar"     && <Calendar locId={locId} jobs={jobs} jobMaterials={jobMaterials} items={items}
                                       purchases={purchases} issues={issues} destinations={destinations}
                                       templates={templates} setJobs={setJobs} setJobMaterials={setJobMaterials}
                                       setIssues={setIssues} setTemplates={setTemplates} isAdmin={isAdmin} companyId={companyId}
                                       projects={projects} workstreamStatus={workstreamStatus} progressLogs={progressLogs}
                                       workstreams={workstreams} hrEmployees={hrEmployees}/>}
          {page==="projects"     && <ProjectsPage locId={locId} projects={projects} workstreams={workstreams}
                                       workstreamStatus={workstreamStatus} progressLogs={progressLogs}
                                       progressMaterials={progressMaterials} setProgressMaterials={setProgressMaterials}
                                       progressCrew={progressCrew} setProgressCrew={setProgressCrew}
                                       setProjects={setProjects} setWorkstreams={setWorkstreams} setProgressLogs={setProgressLogs}
                                       setProjectInvoices={setProjectInvoices} onIssuesRemoved={removeIssuesAtLocation}
                                       refreshWorkstreamStatus={refreshWorkstreamStatus}
                                       hrEmployees={hrEmployees} hrScheduleLocations={hrScheduleLocations} hrLeave={hrLeave}
                                       itemsByLoc={allData.items} purchasesByLoc={allData.purchases}
                                       isAdmin={isAdmin} companyId={companyId}/>}
          {page==="billing"      && isAdmin && <InternalBillingPage invoices={jobInvoices} projectInvoices={projectInvoices}
                                       projects={projects} workstreams={workstreams} billingSettings={billingSettings}
                                       setBillingSettings={setBillingSettings} companyId={companyId}/>}
          {page==="templates"    && isAdmin && <JobTemplates locId={locId} templates={templates} setTemplates={setTemplates}
                                       templateMaterials={templateMaterials} setTemplateMaterials={setTemplateMaterials}
                                       items={items} destinations={allDests} jobs={jobs} setJobs={setJobs}
                                       jobMaterials={jobMaterials} setJobMaterials={setJobMaterials} companyId={companyId} hrEmployees={hrEmployees}/>}
          {page==="items"        && isAdmin && <StockItems locId={locId} items={items} setItems={setItems} companyId={companyId}/>}
          {page==="destinations" && isAdmin && <Destinations locId={locId} destinations={allDests} setDestinations={setDestinations} companyId={companyId}/>}
        </div>
      </div>

      {/* Mobile bottom nav — a single Menu button rather than a row of tabs,
          since with up to 10 tabs a horizontal strip either clips items off
          the edge of the screen or needs a swipe gesture nobody discovers on
          their own. Tapping it opens a bottom sheet listing every tab for
          the current role (same grouping as the desktop sidebar), so every
          tab is always reachable regardless of how many exist. Desktop
          keeps the sidebar as-is (this bar is hidden above 768px via CSS). */}
      <nav className="bottom-nav">
        <button className="nav-menu-btn" onClick={()=>setMenuOpen(true)}>
          <span>{current?.label || "Menu"}</span>
          <span style={{fontSize:10,opacity:.7}}>&#9650;</span>
        </button>
      </nav>

      {menuOpen && (
        <div className="nav-overlay" onClick={()=>setMenuOpen(false)}>
          <div className="nav-sheet" onClick={e=>e.stopPropagation()}>
            <div className="nav-sheet-header">
              <span className="nav-sheet-title">Menu</span>
              <button className="nav-sheet-close" onClick={()=>setMenuOpen(false)}>Close</button>
            </div>
            {sections.map(sec=>(
              <div key={sec}>
                <div className="nav-section">{sec}</div>
                {visiblePages.filter(p=>p.section===sec).map(p=>(
                  <button key={p.id} className={`nav-sheet-item${page===p.id?" active":""}`}
                    onClick={()=>{setPage(p.id);setMenuOpen(false);}}>
                    {p.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  </>);
}
