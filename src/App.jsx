import { useState, useEffect, useCallback, useMemo } from "react";
import { sb, LOCATIONS, LOC_COLORS } from "./sb.js";
import { supabase } from "./supabaseClient.js";
import { T, css } from "./theme.js";
import { LOGO_DATA } from "./logo.js";
import Login from "./Login.jsx";
import SetPassword from "./SetPassword.jsx";
import { CompanyProvider, useCompany } from "./CompanyContext.jsx";

const fmtR  = n=>`R ${Number(n||0).toLocaleString("en-ZA",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtN  = n=>Number(n||0).toLocaleString("en-ZA",{maximumFractionDigits:3});
const uid   = ()=>crypto.randomUUID();
const toISO   = d=>{ if(!d)return""; const[dd,mm,yyyy]=d.split("/"); return `${yyyy}-${mm}-${dd}`; };
const fromISO = d=>{ if(!d)return""; const[yyyy,mm,dd]=d.split("-"); return `${dd}/${mm}/${yyyy}`; };
const today = ()=>{ const d=new Date(); return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`; };

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
            <div className="field"><label>Opening Qty</label><input type="number" value={form.open_qty||""} onChange={f("open_qty")}/></div>
            <div className="field"><label>Opening Cost / Unit (R)</label><input type="number" step="0.01" value={form.open_cost||""} onChange={f("open_cost")}/></div>
            <div className="field"><label>Min Units (reorder trigger)</label><input type="number" value={form.min_units||""} onChange={f("min_units")}/></div>
            <div className="field"><label>Max Units (target stock)</label><input type="number" value={form.max_units||""} onChange={f("max_units")}/></div>
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

// ─── PURCHASES ───────────────────────────────────────────────────────────────
function Purchases({ locId, items, purchases, setPurchases, isAdmin, companyId }) {
  const [showForm,setShowForm]=useState(false);
  const blank={item_id:"",date:today(),qty:"",total_cost:"",supplier:"",notes:""};
  const [form,setForm]=useState(blank);
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));
  const save=async()=>{
    if(!form.item_id||!form.qty)return;
    const row={id:uid(),location_id:locId,item_id:form.item_id,date:form.date,
      qty:parseFloat(form.qty)||0,total_cost:parseFloat(form.total_cost)||0,
      supplier:form.supplier||null,notes:form.notes||null,company_id:companyId};
    try{await sb.insert("maint_purchases",row);setPurchases(p=>[...p,row]);setForm(blank);setShowForm(false);}
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
    <div className="strip">
      <div className="strip-item"><div className="strip-label">Total Spend</div><div className="strip-val">{fmtR(totalSpend)}</div></div>
      <div className="strip-item"><div className="strip-label">Units Purchased</div><div className="strip-val">{fmtN(totalUnits)}</div></div>
      <div className="strip-item"><div className="strip-label">Entries</div><div className="strip-val">{purchases.length}</div></div>
      <div style={{marginLeft:"auto"}}>
        <button className="btn btn-primary" onClick={()=>{setForm({...blank,date:today()});setShowForm(true);}}>+ Log Purchase</button>
      </div>
    </div>
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Date</th><th>Item</th><th className="num">Qty</th><th className="num">Total Cost</th>
        <th className="num">Cost/Unit</th><th>Supplier</th><th>Notes</th><th></th></tr></thead>
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
            <td>{isAdmin&&<button className="btn btn-danger btn-sm" onClick={()=>remove(p.id)}>x</button>}</td>
          </tr>
        ))}
        {purchases.length===0&&<tr><td colSpan={8} className="empty">No purchases logged yet</td></tr>}
      </tbody>
    </table></div>
    {showForm&&(
      <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowForm(false)}>
        <div className="modal">
          <div className="modal-title">Log <span>Purchase</span></div>
          <div className="field"><label>Item</label>
            <select value={form.item_id} onChange={f("item_id")}>
              <option value="">-- Select item --</option>
              {items.map(i=><option key={i.id} value={i.id}>{i.description}</option>)}
            </select>
          </div>
          <div className="grid2">
            <div className="field"><label>Date</label><DateField value={form.date} onChange={v=>setForm(p=>({...p,date:v}))}/></div>
            <div className="field"><label>Qty Purchased</label><input type="number" value={form.qty} onChange={f("qty")}/></div>
            <div className="field"><label>Total Cost (R excl VAT)</label><input type="number" step="0.01" value={form.total_cost} onChange={f("total_cost")}/></div>
            <div className="field"><label>Supplier</label><input type="text" value={form.supplier} onChange={f("supplier")}/></div>
          </div>
          {form.qty&&form.total_cost&&(
            <div className="info-box">
              <span style={{fontSize:11,color:T.muted}}>Cost per unit</span>
              <strong style={{fontFamily:"'Space Mono'",color:T.ok}}>{fmtR((parseFloat(form.total_cost)||0)/(parseFloat(form.qty)||1))}</strong>
            </div>
          )}
          <div className="field"><label>Notes</label><input type="text" value={form.notes} onChange={f("notes")}/></div>
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
  const save=async()=>{
    if(!form.item_id||!form.qty)return;
    const dest=locDests.find(d=>d.id===form.destination_id);
    const row={id:uid(),location_id:locId,item_id:form.item_id,date:form.date,
      qty:parseFloat(form.qty)||0,destination_id:form.destination_id||null,
      dest_name:dest?.name||null,notes:form.notes||null,company_id:companyId};
    try{await sb.insert("maint_issues",row);setIssues(p=>[...p,row]);setForm({...blank,date:today()});setShowForm(false);}
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
        <button className="btn btn-primary" onClick={()=>{setForm({...blank,date:today(),destination_id:locDests[0]?.id||""});setShowForm(true);}}>+ Log Issue</button>
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
          <div className="field"><label>Item</label>
            <select value={form.item_id} onChange={f("item_id")}>
              <option value="">-- Select item --</option>
              {items.map(i=><option key={i.id} value={i.id}>{i.description} ({i.unit})</option>)}
            </select>
          </div>
          <div className="grid2">
            <div className="field"><label>Date</label><DateField value={form.date} onChange={v=>setForm(p=>({...p,date:v}))}/></div>
            <div className="field"><label>Qty Issued</label><input type="number" value={form.qty} onChange={f("qty")}/></div>
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
              <input className="count-input" type="number"
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
                    templates, setJobs, setJobMaterials, setIssues, setTemplates, isAdmin, companyId }) {
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

    {openJob && (
      <JobDetail job={openJob} onClose={()=>setOpenJob(null)}
        locId={locId} jobs={jobs} jobMaterials={jobMaterials} items={items}
        purchases={purchases} issues={issues} templates={templates} destinations={destinations}
        setJobs={setJobs} setJobMaterials={setJobMaterials} setIssues={setIssues}
        setTemplates={setTemplates} isAdmin={isAdmin} companyId={companyId}/>
    )}

    {showAdHoc && (
      <AdHocJob locId={locId} items={items} destinations={destinations}
        setJobs={setJobs} setJobMaterials={setJobMaterials} onClose={()=>setShowAdHoc(false)} companyId={companyId}/>
    )}
  </>);
}

// ─── JOB DETAIL ──────────────────────────────────────────────────────────────
function JobDetail({ job, onClose, locId, jobs, jobMaterials, items, purchases, issues,
                     templates, destinations, setJobs, setJobMaterials, setIssues, setTemplates, isAdmin, companyId }) {
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
      locId={locId} templates={templates}
      setJobs={setJobs} setJobMaterials={setJobMaterials} setIssues={setIssues} setTemplates={setTemplates}
      onDone={()=>{setCompleting(false);onClose();}} onBack={()=>setCompleting(false)} companyId={companyId}/>
  );

  if(editing) return (
    <EditJob job={job} mats={mats} items={items} destinations={destinations}
      setJobs={setJobs} setJobMaterials={setJobMaterials}
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
function CompleteJob({ job, mats, items, purchases, issues, locId, templates,
                       setJobs, setJobMaterials, setIssues, setTemplates, onDone, onBack, companyId }) {
  const [date, setDate]   = useState(today());
  const [notes, setNotes] = useState("");
  const [used, setUsed]   = useState(()=>{
    const m={}; mats.forEach(x=>m[x.id]=String(x.qty_planned||0)); return m;
  });
  const [extras, setExtras] = useState([]); // [{item_id, qty}] — unplanned materials
  const [odometer, setOdometer] = useState("");
  const [busy, setBusy]   = useState(false);

  const plannedIds = new Set(mats.map(m=>m.item_id));
  const addExtra    = ()=>setExtras(r=>[...r,{item_id:"",qty:""}]);
  const updExtra     = (i,k,v)=>setExtras(r=>r.map((x,j)=>j===i?{...x,[k]:v}:x));
  const removeExtra  = i=>setExtras(r=>r.filter((_,j)=>j!==i));

  const save = async () => {
    setBusy(true);
    try{
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
              <input type="number" min="0" placeholder="e.g. 84500" value={odometer} onChange={e=>setOdometer(e.target.value)}/>
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
                      <input className="count-input" type="number" value={used[m.id]??""}
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
                <select value={ex.item_id} onChange={e=>updExtra(i,"item_id",e.target.value)}
                  style={{flex:1,background:"rgba(0,0,0,.25)",border:`1px solid ${T.border}`,borderRadius:6,
                    padding:"9px 10px",color:T.cream,fontFamily:"'Inter',sans-serif",fontSize:14,outline:"none"}}>
                  <option value="">-- Select item --</option>
                  {items.map(it=>(
                    <option key={it.id} value={it.id}>
                      {it.description} ({it.unit}){plannedIds.has(it.id)?" — already on card":""}
                    </option>
                  ))}
                </select>
                <input className="count-input" type="number" placeholder="Qty" value={ex.qty}
                  onChange={e=>updExtra(i,"qty",e.target.value)}/>
                <button className="btn btn-danger btn-sm" onClick={()=>removeExtra(i)}>x</button>
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
function AdHocJob({ locId, items, destinations, setJobs, setJobMaterials, onClose, companyId }) {
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
            <input type="text" value={form.assigned_to} onChange={f("assigned_to")} placeholder="Name"/>
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
function EditJob({ job, mats, items, destinations, setJobs, setJobMaterials, onDone, onBack, companyId }) {
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
            <input type="text" value={form.assigned_to} onChange={f("assigned_to")} placeholder="Name"/>
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
            <select value={r.item_id} onChange={e=>upd(i,"item_id",e.target.value)} disabled={!r.category} style={{...selectStyle,opacity:r.category?1:.5}}>
              <option value="">{r.category ? "-- Select item --" : "Pick a category first"}</option>
              {itemsInCat.map(it=><option key={it.id} value={it.id}>{it.description} ({it.unit})</option>)}
            </select>
            <input className="count-input" type="number" placeholder="Qty" value={r.qty}
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
                        items, destinations, jobs, setJobs, jobMaterials, setJobMaterials, companyId }) {
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
                <input type="number" min="1" value={form.recurrence_n} onChange={f("recurrence_n")}/>
              </div>
            )}
            <div className="field"><label>First / Next Due</label>
              <DateField value={form.next_due} onChange={v=>setForm(p=>({...p,next_due:v}))}/>
            </div>
            <div className="field"><label>Assigned To</label>
              <input type="text" value={form.assigned_to} onChange={f("assigned_to")} placeholder="Name"/>
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

// ─── PAGES ───────────────────────────────────────────────────────────────────
const PAGES=[
  {id:"dashboard",   label:"Dashboard",    section:"Overview",   adminOnly:false},
  {id:"calendar",    label:"Calendar",     section:"Schedule",   adminOnly:false},
  {id:"templates",   label:"Job Templates",section:"Schedule",   adminOnly:true},
  {id:"purchases",   label:"Purchases",    section:"Stock",      adminOnly:false},
  {id:"issues",      label:"Issues",       section:"Stock",      adminOnly:false},
  {id:"count",       label:"Stock Count",  section:"Stock",      adminOnly:false},
  {id:"orders",      label:"Orders",       section:"Stock",      adminOnly:false},
  {id:"destcosts",   label:"Destination Costs", section:"Stock", adminOnly:false},
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
  const [locPickerOpen, setLocPickerOpen]= useState(false);
  const [allData,       setAllData]      = useState({items:{},purchases:{},issues:{},counts:{},destinations:{},jobs:{},templates:{}});
  const [jobMaterials,     setJobMaterials]     = useState([]);
  const [templateMaterials,setTemplateMaterials]= useState([]);
  const [loading,       setLoading]      = useState(true);
  const [loadErr,       setLoadErr]      = useState(null);
  const isAdmin = role==="admin";

  useEffect(()=>{if(role&&!isAdmin&&page==="dashboard")setPage("purchases");},[role,isAdmin,page]);

  const loadAll=useCallback(async()=>{
    if (!companyId) return;
    setLoading(true);setLoadErr(null);
    try{
      const cf = `company_id=eq.${companyId}`;
      const[itemRows,purchRows,issueRows,countRows,destRows,jobRows,tplRows,jobMatRows,tplMatRows]=await Promise.all([
        sb.select("maint_items", `active=eq.true&${cf}&order=sort_order.asc`),
        sb.select("maint_purchases", cf),
        sb.select("maint_issues", cf),
        sb.select("maint_stock_counts", cf),
        sb.select("maint_destinations", `${cf}&order=sort_order.asc`),
        sb.select("maint_jobs", cf),
        sb.select("maint_job_templates", `active=eq.true&${cf}`),
        sb.select("maint_job_materials", cf),
        sb.select("maint_template_materials", cf),
      ]);
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
      });
      setJobMaterials(jobMatRows.map(r=>({...r,qty_planned:+r.qty_planned,qty_used:r.qty_used==null?null:+r.qty_used})));
      setTemplateMaterials(tplMatRows.map(r=>({...r,qty:+r.qty})));
    }catch(e){setLoadErr(e.message);}
    finally{setLoading(false);}
  },[companyId]);

  useEffect(()=>{loadAll();},[loadAll]);
  const logout=async()=>{await supabase.auth.signOut();};

  // Per-location state setters
  const mkSetter = key => fn => setAllData(d=>({...d,[key]:{...d[key],[locId]:typeof fn==="function"?fn(d[key][locId]||[]):fn}}));
  const setItems        = mkSetter("items");
  const setPurchases    = mkSetter("purchases");
  const setIssues       = mkSetter("issues");
  const setCounts       = mkSetter("counts");
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

  const visiblePages = PAGES.filter(p=>isAdmin||!p.adminOnly);
  const sections     = [...new Set(visiblePages.map(p=>p.section))];
  const current      = PAGES.find(p=>p.id===page);
  const locColor     = LOC_COLORS[locId];
  const locName      = LOCATIONS.find(l=>l.id===locId)?.name;
  const now          = new Date();
  const monthLabel   = now.toLocaleString("en-ZA",{month:"long",year:"numeric"}).toUpperCase();
  const footerDate   = now.toLocaleString("en-ZA",{month:"short",year:"numeric"});
  const BOTTOM_NAV   = [
    {id:"calendar", label:"Calendar"},
    {id:"purchases",label:"Purchases"},
    {id:"issues",   label:"Issues"},
    {id:"count",    label:"Count"},
    {id:"orders",   label:"Orders"},
  ];

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
          {page==="purchases"    && <Purchases locId={locId} items={items} purchases={purchases} setPurchases={setPurchases} isAdmin={isAdmin} companyId={companyId}/>}
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
                                       setIssues={setIssues} setTemplates={setTemplates} isAdmin={isAdmin} companyId={companyId}/>}
          {page==="templates"    && isAdmin && <JobTemplates locId={locId} templates={templates} setTemplates={setTemplates}
                                       templateMaterials={templateMaterials} setTemplateMaterials={setTemplateMaterials}
                                       items={items} destinations={allDests} jobs={jobs} setJobs={setJobs}
                                       jobMaterials={jobMaterials} setJobMaterials={setJobMaterials} companyId={companyId}/>}
          {page==="items"        && isAdmin && <StockItems locId={locId} items={items} setItems={setItems} companyId={companyId}/>}
          {page==="destinations" && isAdmin && <Destinations locId={locId} destinations={allDests} setDestinations={setDestinations} companyId={companyId}/>}
        </div>
      </div>

      {/* Mobile bottom nav */}
      <nav className="bottom-nav">
        {BOTTOM_NAV.map(p=>(
          <button key={p.id} className={`bn-item${page===p.id?" active":""}`} onClick={()=>setPage(p.id)}>{p.label}</button>
        ))}
      </nav>
    </div>
  </>);
}
