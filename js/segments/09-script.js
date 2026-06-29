(()=>{
  "use strict";
  const screen=document.getElementById("receiptsScreen");
  if(!screen)return;
  const $=id=>document.getElementById(id);
  const AR_TZ="America/Argentina/Cordoba";
  const state={category:"deudas",rows:[],filter:"todos",search:"",driver:"",month:"",week:"",vehicle:"",loading:false,previousScrollY:0,cache:new Map()};
  const titles={
    deudas:["DEUDAS","Comprobantes de multas, choques y otros cargos"],
    prestamos:["PRÉSTAMOS","Comprobantes de préstamos operativos"],
    alias:["PAGO CLIENTE","Transferencias y Alias de clientes"],
    gastos:["GASTASTE","Comprobantes asociados a gastos"],
    cierres:["COMPROBANTES SEMANALES","Ordenados por semana, estado y vehículo"]
  };
  const emptyMessages={deudas:"No hay comprobantes de deudas.",prestamos:"No hay comprobantes de préstamos.",alias:"No hay comprobantes de pagos de clientes.",gastos:"No hay comprobantes de gastos.",cierres:"No hay cierres semanales para los filtros seleccionados."};
  const money=v=>new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(Number(v)||0).replace(/\s/g,"");
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const role=()=>String(window.ExploraSession?.role||"").toLowerCase();
  const isAdmin=()=>["admin","administrador","owner"].includes(role());
  const isClosureAdmin=()=>isAdmin()&&state.category==="cierres";
  function setStatus(text="",error=false){const el=$("receiptsStatus");if(!el)return;el.textContent=text;el.className=`receipts-status${error?" err":""}`;}
  function open(){state.previousScrollY=window.scrollY||0;screen.classList.add("is-open");screen.setAttribute("aria-hidden","false");screen.dataset.view="main";window.lockPageScroll?.("receipts");window.ExploraMainNav?.setActive?.("comprobantes");syncAdminFilters();}
  function close(){screen.classList.remove("is-open");screen.setAttribute("aria-hidden","true");screen.dataset.view="main";window.unlockPageScroll?.("receipts");window.ExploraMainNav?.setActive?.("inicio");requestAnimationFrame(()=>window.scrollTo(0,state.previousScrollY||0));}
  function normalizedState(row){return String(row.state||row.status||row.estado||"registrado").toLowerCase();}
  function rowRaw(row={}){return row.raw&&typeof row.raw==="object"?row.raw:row;}
  function closureStatusKey(row={}){
    const raw=rowRaw(row);
    const joined=[row.state,row.status,raw.receiptStatus,raw.estadoComprobante,raw.paymentStatus,raw.status,raw.estado,raw.closureStatus,raw.resultLabel].map(value=>String(value||"").toLowerCase()).join(" ");
    const balanced=raw.balanced===true||raw.sentido==="sin_diferencia"||joined.includes("equilibr")||joined.includes("no requerido")||joined.includes("not_required");
    if(balanced)return"balanced";
    if(joined.includes("rechaz")||joined.includes("reject"))return"rejected";
    if(["aprob","accept","confirm","pagado","paid","completado","completed","cerrado","closed"].some(token=>joined.includes(token)))return"confirmed";
    if(["revision","revisión","review","uploaded","subido","recibido","pendiente_aprobacion"].some(token=>joined.includes(token))||Boolean(row.url))return"received";
    return"missing";
  }
  function closureStatusLabel(key){return({missing:"FALTA COMPROBANTE",received:"COMPROBANTE RECIBIDO",confirmed:"PAGO CONFIRMADO",rejected:"COMPROBANTE RECHAZADO",balanced:"CUENTA EQUILIBRADA"})[key]||"FALTA COMPROBANTE";}
  function vehicleInfo(row={}){
    const raw=rowRaw(row);
    const plate=String(raw.vehiclePlate||raw.patente||raw.plate||raw.dominio||raw.autoPatente||"").trim().toUpperCase();
    const name=String(raw.vehicleDisplayName||raw.vehicleName||raw.vehiculoNombre||raw.autoNombre||raw.modelo||raw.vehicleModel||raw.autoModelo||"").trim();
    const id=String(raw.vehicleId||raw.vehiculoId||raw.autoId||raw.carId||"").trim();
    const label=[name,plate].filter(Boolean).join(" — ")||"VEHÍCULO SIN IDENTIFICAR";
    return{key:id||plate||name||"sin-vehiculo",label,plate,name};
  }
  function rowTimeMs(row={}){
    const raw=rowRaw(row);
    for(const value of [raw.receiptUploadedAt,raw.createdAt,raw.completedAt,raw.closedAt,raw.cerradoEn,raw.creadoEn,raw.updatedAt]){
      if(value?.toDate){const ms=value.toDate().getTime();if(Number.isFinite(ms))return ms;}
      if(value?.seconds){const ms=Number(value.seconds)*1000;if(Number.isFinite(ms))return ms;}
      const ms=Date.parse(value);if(Number.isFinite(ms))return ms;
    }
    const parsed=Date.parse(row.date);return Number.isFinite(parsed)?parsed:0;
  }
  function formatWeekLabel(value){
    const raw=String(value||"").trim();if(!raw)return"SIN SEMANA";
    const dates=raw.match(/\d{4}-\d{2}-\d{2}/g)||[];
    if(dates.length){
      const fmt=iso=>{const [y,m,d]=iso.split("-").map(Number);return new Intl.DateTimeFormat("es-AR",{timeZone:AR_TZ,day:"2-digit",month:"short"}).format(new Date(Date.UTC(y,m-1,d,12)));};
      return dates.length>1?`${fmt(dates[0])} AL ${fmt(dates[1])}`:`DESDE ${fmt(dates[0])}`;
    }
    return raw.toUpperCase();
  }
  function settlementText(row={}){
    const raw=rowRaw(row);const key=closureStatusKey(row);
    if(key==="balanced")return"Cuenta equilibrada";
    const explicit=String(raw.resultLabel||raw.resultadoFinal||raw.actionText||"").trim();if(explicit)return explicit;
    const payer=String(raw.payerRole||raw.payer||"").toLowerCase();
    if(["driver","chofer"].includes(payer))return"Chofer paga a David";
    if(["admin","david"].includes(payer))return"David paga al chofer";
    const driverDebt=Number(raw.choferDebe||raw.driverOwes||0),adminDebt=Number(raw.davidDebe||raw.adminOwes||0);
    if(driverDebt>0)return"Chofer paga a David";if(adminDebt>0)return"David paga al chofer";
    return"Resultado semanal";
  }
  function selectedWeekRows(rows=state.rows){return rows.filter(row=>!state.week||String(row.weeklyPeriodId||"")===String(state.week));}
  function filterRows(rows=state.rows,{ignoreStatus=false}={}){
    const q=state.search.toLowerCase().trim();
    return rows.filter(row=>{
      const status=normalizedState(row);
      if(!ignoreStatus){
        if(isClosureAdmin()&&["pendiente","recibido","aprobado","rechazado"].includes(state.filter)){
          const expected={pendiente:"missing",recibido:"received",aprobado:"confirmed",rechazado:"rejected"}[state.filter];
          if(closureStatusKey(row)!==expected)return false;
        }else if(state.filter==="semana"){
          const active=window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"";if(String(row.weeklyPeriodId||"")!==String(active))return false;
        }else if(state.filter==="mes"){
          const current=new Intl.DateTimeFormat("en-CA",{timeZone:AR_TZ,year:"numeric",month:"2-digit"}).format(new Date()).slice(0,7);if(String(row.monthKey||"")!==current)return false;
        }else if(state.filter!=="todos"&&!status.includes(state.filter))return false;
      }
      if(state.driver&&String(row.driverUid||row.driverName)!==state.driver)return false;
      if(state.month&&String(row.monthKey||"")!==state.month)return false;
      if(state.week&&String(row.weeklyPeriodId||"")!==state.week)return false;
      if(state.vehicle&&vehicleInfo(row).key!==state.vehicle)return false;
      const vehicle=vehicleInfo(row).label;
      if(q&&!`${row.title||""} ${row.subtitle||""} ${row.driverName||""} ${row.operationId||""} ${vehicle} ${settlementText(row)}`.toLowerCase().includes(q))return false;
      return true;
    });
  }
  function rowCard(row,index){
    const stateClass=normalizedState(row).replace(/[^a-z]/g,"");const hasFile=Boolean(row.url);
    return `<article class="receipt-row-card"><span class="receipt-row-icon">▣</span><span class="receipt-row-info"><b>${esc(row.title||"Comprobante")}</b><small>Fecha: ${esc(row.date||"—")}</small><small>Usuario: ${esc(row.driverName||"—")}</small><small>Detalle: ${esc(row.detail||row.subtitle||"—")}</small></span><span class="receipt-row-side"><span class="receipt-row-amount">${money(row.amount)}</span><span class="receipt-state ${stateClass}">${esc(row.state||"Registrado")}</span>${hasFile?`<button type="button" class="receipt-view-photo" data-receipt-index="${index}">VER FOTO</button>`:`<small>SIN FOTO</small>`}</span><span class="receipt-row-chevron">›</span></article>`;
  }
  function closureRowCard(row,index){
    const status=closureStatusKey(row),vehicle=vehicleInfo(row),hasFile=Boolean(row.url),amount=Number(row.amount)||0;
    return `<article class="receipt-closure-card is-${status}">
      <div class="receipt-closure-card-head"><div><span>${esc(row.driverName||"Chofer")}</span><small>${esc(vehicle.label)}</small></div><strong>${money(amount)}</strong></div>
      <div class="receipt-closure-result"><span>${esc(settlementText(row))}</span><small>${esc(row.date||"Fecha no disponible")}</small></div>
      <div class="receipt-closure-card-foot"><span class="receipt-closure-badge is-${status}">${closureStatusLabel(status)}</span><div class="receipt-closure-actions">${row.driverUid?`<button type="button" class="receipt-open-closure" data-admin-open-closure="${esc(row.driverUid)}" data-admin-closure-week="${esc(row.weeklyPeriodId||"")}">VER CIERRE</button>`:""}${hasFile?`<button type="button" class="receipt-view-photo" data-receipt-index="${index}">VER COMPROBANTE</button>`:`<small class="receipt-closure-no-file">Sin archivo cargado</small>`}</div></div>
    </article>`;
  }
  function groupedAdminHtml(rows){
    const drivers=new Map();
    rows.forEach(row=>{const key=String(row.driverUid||row.driverName||"sin-chofer");if(!drivers.has(key))drivers.set(key,{name:row.driverName||"Chofer",rows:[]});drivers.get(key).rows.push(row);});
    return [...drivers.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name,"es")).map(([,driver])=>{
      const months=new Map();driver.rows.forEach(row=>{const key=row.monthKey||"Sin mes";if(!months.has(key))months.set(key,[]);months.get(key).push(row);});
      const monthHtml=[...months.entries()].sort((a,b)=>String(b[0]).localeCompare(String(a[0]))).map(([month,monthRows])=>{
        const weeks=new Map();monthRows.forEach(row=>{const key=row.weeklyPeriodId||"Sin semana";if(!weeks.has(key))weeks.set(key,[]);weeks.get(key).push(row);});
        const weekHtml=[...weeks.entries()].map(([week,weekRows])=>`<details class="receipt-group-level receipt-group-week"><summary>SEMANA ${esc(week)} <span>${weekRows.length}</span></summary><div class="receipt-group-items">${weekRows.map(row=>rowCard(row,rows.indexOf(row))).join("")}</div></details>`).join("");
        return `<details class="receipt-group-level receipt-group-month"><summary>${esc(month)} <span>${monthRows.length}</span></summary>${weekHtml}</details>`;
      }).join("");
      return `<details class="receipt-group-level receipt-group-driver"><summary>${esc(driver.name)} <span>${driver.rows.length}</span></summary>${monthHtml}</details>`;
    }).join("");
  }
  function groupedClosureAdminHtml(rows){
    const statusOrder=["missing","received","rejected","confirmed","balanced"];
    const sorted=[...rows].sort((a,b)=>statusOrder.indexOf(closureStatusKey(a))-statusOrder.indexOf(closureStatusKey(b))||rowTimeMs(a)-rowTimeMs(b)||vehicleInfo(a).label.localeCompare(vehicleInfo(b).label,"es")||String(a.driverName||"").localeCompare(String(b.driverName||""),"es"));
    const weeks=new Map();sorted.forEach(row=>{const key=row.weeklyPeriodId||"sin-semana";if(!weeks.has(key))weeks.set(key,[]);weeks.get(key).push(row);});
    return [...weeks.entries()].sort((a,b)=>String(b[0]).localeCompare(String(a[0]))).map(([week,weekRows])=>{
      const statusSections=statusOrder.map(status=>{
        const statusRows=weekRows.filter(row=>closureStatusKey(row)===status);if(!statusRows.length)return"";
        const vehicles=new Map();statusRows.forEach(row=>{const info=vehicleInfo(row);if(!vehicles.has(info.key))vehicles.set(info.key,{info,rows:[]});vehicles.get(info.key).rows.push(row);});
        const vehicleHtml=[...vehicles.values()].sort((a,b)=>a.info.label.localeCompare(b.info.label,"es")).map((group,vehicleIndex)=>{
          const total=group.rows.reduce((sum,row)=>sum+(Number(row.amount)||0),0);const shouldOpen=["missing","received","rejected"].includes(status)&&vehicleIndex===0;
          return `<details class="receipt-vehicle-group is-${status}" ${shouldOpen?"open":""}><summary><span><b>${esc(group.info.label)}</b><small>${group.rows.length} ${group.rows.length===1?"cierre":"cierres"}</small></span><strong>${money(total)}</strong></summary><div class="receipt-vehicle-items">${group.rows.map(row=>closureRowCard(row,rows.indexOf(row))).join("")}</div></details>`;
        }).join("");
        return `<section class="receipt-closure-status-group is-${status}"><header><span>${closureStatusLabel(status)}</span><b>${statusRows.length}</b></header>${vehicleHtml}</section>`;
      }).join("");
      return `<section class="receipt-week-group"><header><span>SEMANA</span><strong>${esc(formatWeekLabel(week))}</strong></header>${statusSections}</section>`;
    }).join("");
  }
  function uniqueWeekIds(){return [...new Set(state.rows.map(row=>String(row.weeklyPeriodId||"").trim()).filter(Boolean))].sort((a,b)=>b.localeCompare(a));}
  function renderClosureOverview(){
    const box=$("receiptsClosureOverview");if(!box)return;const visible=isClosureAdmin();box.hidden=!visible;if(!visible)return;
    const base=filterRows(state.rows,{ignoreStatus:true});const counts={missing:0,received:0,confirmed:0,rejected:0};
    base.forEach(row=>{const key=closureStatusKey(row);if(key in counts)counts[key]++;});
    $("receiptsClosureWeekLabel")&&($("receiptsClosureWeekLabel").textContent=formatWeekLabel(state.week||window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||""));
    [["receiptsClosureMissing",counts.missing],["receiptsClosureReceived",counts.received],["receiptsClosureConfirmed",counts.confirmed],["receiptsClosureRejected",counts.rejected]].forEach(([id,value])=>{const el=$(id);if(el)el.textContent=String(value);});
    const weeks=uniqueWeekIds(),active=String(window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"");let currentIndex=weeks.indexOf(state.week||active);if(currentIndex<0)currentIndex=-1;const previous=currentIndex<0?weeks[0]:weeks[currentIndex+1];
    const previousButton=$("receiptsPreviousWeekBtn");if(previousButton){previousButton.disabled=!previous;previousButton.dataset.week=previous||"";previousButton.textContent=previous?"VER SEMANA ANTERIOR":"SIN SEMANA ANTERIOR";}
    const currentButton=$("receiptsCurrentWeekBtn");if(currentButton)currentButton.classList.toggle("is-active",!state.week||state.week===active);
  }
  function syncFilterLabels(){
    const map=Object.fromEntries([...document.querySelectorAll("[data-receipt-filter]")].map(button=>[button.dataset.receiptFilter,button]));
    const closure=isClosureAdmin();
    if(map.todos)map.todos.textContent="Todos";
    if(map.pendiente)map.pendiente.textContent=closure?"Por liquidar":"Pendientes";
    if(map.recibido){map.recibido.hidden=!closure;map.recibido.textContent="Comprobante recibido";}
    if(map.aprobado)map.aprobado.textContent=closure?"Pago confirmado":"Aprobados";
    if(map.rechazado)map.rechazado.textContent=closure?"Rechazado":"Rechazados";
    if(map.semana){map.semana.hidden=closure;map.semana.textContent="Esta semana";}
    if(map.mes){map.mes.hidden=closure;map.mes.textContent="Este mes";}
    if(!closure&&state.filter==="recibido")state.filter="todos";
    Object.values(map).forEach(button=>button?.classList.toggle("is-active",button.dataset.receiptFilter===state.filter));
  }
  function render(){
    const list=$("receiptsList"),rows=filterRows();if(!list)return;
    list.innerHTML=isClosureAdmin()?groupedClosureAdminHtml(rows):isAdmin()?groupedAdminHtml(rows):rows.map((row,index)=>rowCard(row,index)).join("");
    $("receiptsEmpty").classList.toggle("is-visible",!rows.length);$("receiptsEmpty").textContent=emptyMessages[state.category]||"No se encontraron comprobantes.";
    list.querySelectorAll("[data-receipt-index]").forEach(button=>button.addEventListener("click",()=>window.ExploraReceiptEngine?.openReceiptViewer?.(rows[Number(button.dataset.receiptIndex)])));
    list.querySelectorAll("[data-admin-open-closure]").forEach(button=>button.addEventListener("click",()=>window.ExploraAdminShared?.openClosure?.(button.dataset.adminOpenClosure||"",button.dataset.adminClosureWeek||"")));
    renderClosureOverview();
  }
  function syncAdminFilters(){
    const wrap=$("receiptsAdminFilters");if(!wrap)return;wrap.hidden=!isAdmin();if(!isAdmin())return;
    const driver=$("receiptsDriverFilter"),month=$("receiptsMonthFilter"),week=$("receiptsWeekFilter"),vehicle=$("receiptsVehicleFilter");
    const unique=(key,label)=>[...new Map(state.rows.filter(row=>row[key]).map(row=>[String(row[key]),String(label(row))])).entries()];
    driver.innerHTML='<option value="">Todos los choferes</option>'+unique("driverUid",row=>row.driverName||row.driverUid).sort((a,b)=>a[1].localeCompare(b[1],"es")).map(([value,text])=>`<option value="${esc(value)}">${esc(text)}</option>`).join("");
    month.innerHTML='<option value="">Todos los meses</option>'+unique("monthKey",row=>row.monthKey).sort((a,b)=>b[0].localeCompare(a[0])).map(([value,text])=>`<option value="${esc(value)}">${esc(text)}</option>`).join("");
    week.innerHTML='<option value="">Todas las semanas</option>'+uniqueWeekIds().map(value=>`<option value="${esc(value)}">${esc(formatWeekLabel(value))}</option>`).join("");
    if(vehicle){const vehicles=[...new Map(state.rows.map(row=>{const info=vehicleInfo(row);return[info.key,info.label];})).entries()].sort((a,b)=>a[1].localeCompare(b[1],"es"));vehicle.innerHTML='<option value="">Todos los vehículos</option>'+vehicles.map(([value,text])=>`<option value="${esc(value)}">${esc(text)}</option>`).join("");vehicle.value=state.vehicle;}
    driver.value=state.driver;month.value=state.month;week.value=state.week;
    wrap.classList.toggle("is-closure-mode",isClosureAdmin());
    const monthLabel=month.closest("label"),vehicleLabel=vehicle?.closest("label");if(monthLabel)monthLabel.hidden=isClosureAdmin();if(vehicleLabel)vehicleLabel.hidden=!isClosureAdmin();
    const search=$("receiptsSearchInput");if(search)search.placeholder=isClosureAdmin()?"Buscar chofer, vehículo o patente…":"Buscar pago o chofer…";
    syncFilterLabels();renderClosureOverview();
  }
  async function load(category=state.category,{force=false}={}){
    const categoryChanged=state.category!==category;state.category=category;
    if(categoryChanged){state.filter="todos";state.search="";state.driver="";state.month="";state.week="";state.vehicle="";const search=$("receiptsSearchInput");if(search)search.value="";}
    const [title,subtitle]=titles[category]||titles.deudas;$("receiptsListTitle").textContent=title;$("receiptsListSubtitle").textContent=subtitle;screen.dataset.view="list";syncFilterLabels();
    if(!force&&state.cache.has(category)){state.rows=state.cache.get(category);if(isClosureAdmin()&&!state.week){const active=String(window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"");const weeks=uniqueWeekIds();state.week=weeks.includes(active)?active:(weeks[0]||"");}syncAdminFilters();render();return;}
    state.loading=true;setStatus("Cargando comprobantes…");
    try{
      state.rows=await window.ExploraReceiptsData?.load?.(category)||[];state.cache.set(category,state.rows);
      if(isClosureAdmin()){
        const active=String(window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"");const weeks=uniqueWeekIds();state.week=weeks.includes(active)?active:(weeks[0]||"");
      }else if(isAdmin()&&!state.month){const now=new Date();state.month=new Intl.DateTimeFormat("en-CA",{timeZone:AR_TZ,year:"numeric",month:"2-digit"}).format(now).slice(0,7);}
      if(isAdmin()&&!isClosureAdmin()&&!state.week)state.week=window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"";
      setStatus("");syncAdminFilters();render();
    }catch(error){console.warn("RECEIPTS_LOAD",error);setStatus("No se pudieron cargar los comprobantes. Toca para reintentar.",true);state.rows=[];syncAdminFilters();render();}
    finally{state.loading=false;}
  }
  function invalidate(category){if(category)state.cache.delete(category);else state.cache.clear();}
  window.invalidateReceiptCache=invalidate;
  window.ExploraReceipts={open,close,openCategory:(category)=>{open();return load(category);},refresh:(category=state.category)=>{invalidate(category);return load(category,{force:true});},invalidate};
  window.ExploraActions=window.ExploraActions||{};window.ExploraActions.comprobantes=open;window.ExploraActions["resumen-comprobantes"]=open;window.ExploraActions["admin-comprobantes"]=()=>{open();load("cierres");};
  document.addEventListener("DOMContentLoaded",()=>{
    $("receiptsBackBtn")?.addEventListener("click",()=>{if(screen.dataset.view==="list"){screen.dataset.view="main";return;}close();});
    $("receiptsScreen")?.addEventListener("click",event=>{const button=event.target.closest("[data-receipt-category]");if(button)load(button.dataset.receiptCategory);});
    $("receiptsSearchInput")?.addEventListener("input",event=>{state.search=event.target.value;render();});
    $("receiptsFilterRow")?.addEventListener("click",event=>{const button=event.target.closest("[data-receipt-filter]");if(!button||button.hidden)return;state.filter=button.dataset.receiptFilter;document.querySelectorAll("[data-receipt-filter]").forEach(item=>item.classList.toggle("is-active",item===button));render();});
    [["receiptsDriverFilter","driver"],["receiptsMonthFilter","month"],["receiptsWeekFilter","week"],["receiptsVehicleFilter","vehicle"]].forEach(([id,key])=>$(id)?.addEventListener("change",event=>{state[key]=event.target.value;render();syncAdminFilters();}));
    $("receiptsCurrentWeekBtn")?.addEventListener("click",()=>{const active=String(window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"");state.week=active;const select=$("receiptsWeekFilter");if(select)select.value=state.week;render();syncAdminFilters();});
    $("receiptsPreviousWeekBtn")?.addEventListener("click",event=>{const week=event.currentTarget.dataset.week||"";if(!week)return;state.week=week;const select=$("receiptsWeekFilter");if(select)select.value=week;render();syncAdminFilters();});
    $("receiptsStatus")?.addEventListener("click",()=>{if($("receiptsStatus").classList.contains("err"))load(state.category,{force:true});});
  });
})();
