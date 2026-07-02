import { collection, query, where, limit, onSnapshot, getDocs, getDoc, addDoc, doc, updateDoc, deleteDoc, runTransaction, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

(() => {
  "use strict";

  window.EXPLORA_LEGACY_MODULES_DISABLED = window.EXPLORA_LEGACY_MODULES_DISABLED || Object.freeze({
    ranking:true, dailyRanking:true, derivationRanking:true, weeklyClosure:true, weeklyMileage:true
  });

  const VERSION = "explora-pago-home-v51-activity-photo-viewer";
  const AR_TZ = "America/Argentina/Cordoba";
  const EXPLORA_WHATSAPP = "5493757461564";
  const EXPLORA_WHATSAPP_DISPLAY = "+5493757461564";
  const EXPLORA_CUIT = "20-40411688-7";
  const EXPLORA_ALIAS = "mp.explora";
  const EXPLORA_ADMIN_UIDS = new Set(["2LziyTTdFcZzSOhK3hLbAKs2U4s2"]);
  const $ = id => document.getElementById(id);
  const PAY_TAB_ORDER = Object.freeze(["chofer", "explora", "gastos", "caja_chica", "pendientes"]);
  const PAY_TAB_LABELS = Object.freeze({ chofer:"Chofer", explora:"Explora", gastos:"Gastos", caja_chica:"Caja chica", pendientes:"Pendientes" });
  const PAY_TAB_ALERT_ZERO = Object.freeze({ chofer:0, explora:0, gastos:0, caja_chica:0, pendientes:0 });
  const ADMIN_ACTIVITY_TYPES = Object.freeze([
    ["", "Todos los tipos"],
    ["digital", "Comprobante Explora · digital"],
    ["chofer", "Comprobante chofer"],
    ["gastos", "Gastos"],
    ["caja_chica", "Caja chica"],
    ["pendientes", "Pendientes"],
    ["cierres", "Cierres"]
  ]);
  const state = {
    tab:"chofer",
    view:"inicio",
    user:null,
    role:"driver",
    profile:{},
    selectedDriverUid:"",
    selectedDriverName:"",
    adminActivityType:"",
    db:null,
    auth:null,
    storage:null,
    drivers:[],
    records:[],
    expenses:[],
    closures:[],
    debts:[],
    debtPayments:[],
    extra:[],
    unsubscribers:[],
    latestSummary:null,
    pendingClosure:null,
    modalMode:"request",
    modalKind:"",
    modalClosure:null,
    modalFile:null,
    debtPaymentBusy:false,
    previousDetailsOpen:{ chofer:false, explora:false, gastos:false, caja_chica:false, pendientes:false },
    tabAlerts:{ chofer:0, explora:0, gastos:0, caja_chica:0, pendientes:0 },
    tabAlertMovements:{},
    tabAlertScope:"",
    tabAlertLoadedAt:0,
    efficiency:{ loadedAt:0, loading:false, error:"" },
    adminDeleteOpen:false,
    adminDeleteMessage:"",
    adminDeleteBusy:false,
    adminDeleteBusyKey:"",
    busy:false,
    refreshing:false
  };

  const currency = value => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Number(value) || 0).replace(/\s/g, "");
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const abs = value => Math.abs(number(value));
  const safe = value => String(value ?? "").trim();
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const isAdmin = () => EXPLORA_ADMIN_UIDS.has(String(state.user?.uid || window.ExploraSession?.authUser?.uid || ""));
  const driverRole = data => {
    const raw = safe(data.role || data.rol || data.tipo).toLowerCase();
    if (/admin|owner|superadmin|administrador/.test(raw)) return "admin";
    if (/chofer|driver|conductor/.test(raw)) return "chofer";
    return raw || "chofer";
  };
  const driverIsActive = data => {
    const estado = safe(data.estado || data.status || data.state).toLowerCase();
    const deletionStatus = safe(data.deletionStatus).toLowerCase();
    if (data.activo === false || data.active === false || data.habilitado === false) return false;
    if (data.isDeleted === true || data.deleted === true || data.eliminado === true) return false;
    if (["inactivo","bloqueado","suspendido","deleted","deleting","deletion_failed","borrado","eliminado"].includes(estado)) return false;
    if (["running","completed","failed"].includes(deletionStatus)) return false;
    return true;
  };

  function ms(value) {
    if (!value) return 0;
    if (typeof value?.toMillis === "function") return value.toMillis();
    if (typeof value?.toDate === "function") return value.toDate().getTime();
    if (typeof value === "number") return value > 100000000000 ? value : value * 1000;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof value?.seconds === "number") return value.seconds * 1000 + Math.round((value.nanoseconds || 0) / 1000000);
    return 0;
  }

  function rowMs(row = {}) {
    return Math.max(
      ms(row.createdAt), ms(row.completedAt), ms(row.updatedAt), ms(row.expenseDate), ms(row.fechaISO),
      Number(row.createdAtMs || 0), Number(row.timestampMs || 0), Number(row.completedAtMs || 0)
    );
  }

  function methodOf(row = {}) {
    const raw = safe(row.paymentMethod || row.metodoPago || row.financialCategory || row.receiptPaymentMethod || row.paymentProvider || row.method).toLowerCase();
    if (/cash|efectivo/.test(raw)) return "cash";
    if (/qr/.test(raw)) return "qr";
    if (/card|tarjeta|point/.test(raw)) return "card";
    if (/transfer|alias|transf/.test(raw)) return "transfer";
    return raw || "cash";
  }

  function moneyNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const text = safe(value).replace(/\s/g, "");
    if (!text) return 0;
    const cleaned = text.replace(/[^0-9,.-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === "," || cleaned === ".") return 0;
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    let normalized = cleaned;
    if (lastComma >= 0 && lastDot >= 0) {
      normalized = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(/,/g, ".") : cleaned.replace(/,/g, "");
    } else if (lastDot >= 0) {
      const tail = cleaned.slice(lastDot + 1);
      normalized = tail.length === 3 ? cleaned.replace(/\./g, "") : cleaned;
    } else if (lastComma >= 0) {
      const tail = cleaned.slice(lastComma + 1);
      normalized = tail.length === 3 ? cleaned.replace(/,/g, "") : cleaned.replace(/,/g, ".");
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function amountOf(row = {}) {
    const fields = [
      "amount", "monto", "valor", "finalPrice", "total", "importe",
      "price", "precio", "precioFinal", "montoFinal", "montoCobrado", "importeTotal",
      "finalAmount", "totalAmount", "billingAmount", "chargedAmount", "paidAmount",
      "fare", "tarifa", "value", "totalCobrado", "facturacion", "billingTotal"
    ];
    for (const field of fields) {
      const raw = row?.[field];
      if (raw === null || raw === undefined || raw === "") continue;
      const parsed = moneyNumber(raw);
      if (parsed > 0) return parsed;
    }
    return 0;
  }

  function expenseTypeLabel(row = {}) {
    const raw = safe(row.expenseType || row.tipo || row.category || row.categoria || "gasto").toLowerCase();
    const map = { combustible:"Combustible", peajes:"Peaje", peaje:"Peaje", estacionamiento:"Estacionamiento", lavado:"Lavado", mantenimiento:"Mantenimiento", compras:"Compras", gasto:"Gasto" };
    return map[raw] || raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function paymentLabel(method) {
    return ({ cash:"Cobro efectivo", transfer:"Cobro transferencia", card:"Cobro tarjeta", qr:"Cobro QR" })[method] || "Cobro";
  }

  function movementIsDeleted(row = {}) {
    const status = safe(row.status || row.estado || row.state || row.deletionStatus).toLowerCase();
    return row.deleted === true || row.isDeleted === true || row.eliminado === true || /deleted|eliminado|borrado|anulado/.test(status);
  }

  function cashboxIsExcluded(row = {}) {
    return row.excludeFromCashbox === true || row.cashboxExcluded === true || row.cajaChicaEliminada === true || row.ignoreCashbox === true || row.noCashbox === true;
  }

  function activeClosureKind(kind = state.tab) {
    const raw = safe(kind).toLowerCase();
    if (/pendiente|deuda|debt|multa|choque|prestamo|pr[eé]stamo|adelanto|loan|advance/.test(raw)) return "pendientes";
    if (/caja|chica|cashbox|bruto/.test(raw)) return "caja_chica";
    if (/gasto|expense/.test(raw)) return "gastos";
    if (/factur|billing|cobro/.test(raw)) return "facturacion";
    if (/explora|digital|transfer|qr|card|tarjeta/.test(raw)) return "explora";
    if (/chofer|driver|efectivo|cash/.test(raw)) return "chofer";
    return "";
  }

  function isBillingClosureKind(kind = state.tab) {
    const target = activeClosureKind(kind);
    return target === "chofer" || target === "explora" || target === "facturacion";
  }

  function closureKindOf(row = {}) {
    return activeClosureKind(row.closureKind || row.closureType || row.payTab || row.closeKind || row.kind || row.cierreTipo || row.type || row.category);
  }

  function normalizeHomeModuleValue(value = "") {
    const raw = safe(value).toLowerCase();
    if (!raw) return "";
    if (/^(pendientes|pendiente|deudas|deuda|debt|debts)$/.test(raw)) return "pendientes";
    if (/^(caja_chica|cajachica|caja chica|cashbox|petty_cash|petty cash|bruto)$/.test(raw)) return "caja_chica";
    if (/^(gastos|gasto|expenses|expense)$/.test(raw)) return "gastos";
    if (/^(explora|digital|admin|david|transfer|transferencia|qr|card|tarjeta)$/.test(raw)) return "explora";
    if (/^(chofer|driver|efectivo|cash)$/.test(raw)) return "chofer";
    return "";
  }

  function firstHomeModuleFromFields(row = {}, fields = []) {
    for (const field of fields) {
      const value = row?.[field];
      if (Array.isArray(value)) {
        const normalized = value.map(normalizeHomeModuleValue).find(Boolean);
        if (normalized) return normalized;
        continue;
      }
      const normalized = normalizeHomeModuleValue(value);
      if (normalized) return normalized;
    }
    return "";
  }

  function closureHomeModuleOf(row = {}) {
    // Este valor es SOLO para el cartel amarillo del Home. No se usa para cálculos.
    // Debe ser estricto: si no sabemos la tarjeta exacta donde nació el pedido,
    // no mostramos cartel en Home para evitar falsos positivos.
    const explicit = firstHomeModuleFromFields(row, [
      "homeModule", "homeTab", "homeCard",
      "requestModule", "requestedModule", "requestedTab", "requestedFrom",
      "originModule", "originTab", "sourceModule", "sourceTab", "settlementType"
    ]);
    if (explicit) return explicit;

    // Compatibilidad con cierres creados antes de guardar homeModule:
    // si la propia clase del cierre ya era exacta, podemos usarla.
    const exactKind = firstHomeModuleFromFields(row, ["payTab", "closeKind", "kind", "closureKind", "closureType", "cierreTipo"]);
    if (exactKind) return exactKind;

    // Campos genéricos solo se aceptan si dicen literalmente una tarjeta del Home.
    const generic = firstHomeModuleFromFields(row, ["module", "modulo", "source", "origin", "tab", "type", "category"]);
    if (generic) return generic;

    // Si solo aparece "facturacion"/"billing", afecta cálculos de Chofer+Explora,
    // pero NO alcanza para mostrar cartel en ninguna tarjeta específica.
    return "";
  }

  function closureMatchesHomeModule(row = {}, kind = state.tab) {
    const target = activeClosureKind(kind);
    if (!["caja_chica", "gastos", "explora", "chofer"].includes(target)) return false;
    return closureHomeModuleOf(row) === target;
  }

  function isClosureTab(kind = state.tab) {
    return ["caja_chica", "gastos", "explora", "chofer", "facturacion"].includes(activeClosureKind(kind));
  }

  function closureLabel(kind = state.tab) {
    return ({ caja_chica:"caja chica", gastos:"gastos", explora:"facturación", chofer:"facturación", facturacion:"facturación" })[activeClosureKind(kind)] || "";
  }

  function closureTitle(kind = state.tab) {
    return ({ caja_chica:"CIERRE DE CAJA CHICA", gastos:"CIERRE DE GASTOS", explora:"CIERRE DE FACTURACIÓN", chofer:"CIERRE DE FACTURACIÓN", facturacion:"CIERRE DE FACTURACIÓN" })[activeClosureKind(kind)] || "CIERRE";
  }

  function expensePayer(row = {}) {
    // En este modo operativo, los gastos abiertos se consideran cargados/pagados por el chofer.
    // Explora no paga gastos por Ualá/cuenta temporalmente; solo reintegra su 50% en el cierre de gastos.
    return "driver";
  }

  function expenseParts(row = {}) {
    const amount = amountOf(row);
    const rateRaw = Number(row.sharedRate ?? row.porcentajeCompartido ?? row.driverShareRate ?? row.porcentajeChofer);
    const rate = Number.isFinite(rateRaw) ? (rateRaw > 1 ? rateRaw / 100 : rateRaw) : .5;
    const driverPart = amount * Math.min(1, Math.max(0, rate || .5));
    const exploraPart = amount - driverPart;
    return { amount, driverPart, exploraPart, payer: expensePayer(row) };
  }


  const DEBT_ACTIVE_STATUSES = new Set(["", "active", "activo", "active_acknowledged", "acknowledged", "confirmado", "pending", "pendiente", "installment", "en_cuotas", "cuotas", "requested", "open", "abierta"]);
  const DEBT_TYPE_LABELS = Object.freeze({ fine:"Multa", crash:"Choque", personal_loan:"Préstamo", advance:"Adelanto", other:"Pendiente" });

  function debtTypeOf(row = {}) {
    const raw = safe(row.type || row.reason || row.reasonLabel || row.tipo || row.category || row.categoria).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (/personal_loan|prestamo|loan/.test(raw)) return "personal_loan";
    if (/advance|adelanto/.test(raw)) return "advance";
    if (/crash|choque|siniestro/.test(raw)) return "crash";
    if (/fine|multa|infraccion/.test(raw)) return "fine";
    return "other";
  }

  function debtTypeLabel(row = {}) {
    const type = debtTypeOf(row);
    return safe(row.reasonLabel || row.tipoLabel || row.typeLabel) || DEBT_TYPE_LABELS[type] || "Pendiente";
  }

  function debtTotalAmount(row = {}) {
    return Math.max(0, moneyNumber(row.totalAmount ?? row.originalAmount ?? row.amount ?? row.montoTotal ?? row.monto ?? row.valor ?? 0));
  }

  function debtPaidAmount(row = {}) {
    return Math.max(0, moneyNumber(row.paidAmount ?? row.amountPaid ?? row.importePagado ?? row.discountedAmount ?? 0));
  }

  function debtRemainingAmount(row = {}) {
    const stored = row.remainingAmount ?? row.saldoPendiente ?? row.remainingBalance ?? row.balance;
    if (stored !== undefined && stored !== null && stored !== "") return Math.max(0, moneyNumber(stored));
    return Math.max(0, debtTotalAmount(row) - debtPaidAmount(row));
  }

  function debtPenaltyAmount(row = {}) {
    return Math.max(0, moneyNumber(row.penaltyAccruedAmount ?? row.interestAccruedAmount ?? row.moraAcumulada ?? row.intereses ?? 0));
  }

  function debtIsActive(row = {}) {
    if (!row || movementIsDeleted(row)) return false;
    const status = safe(row.status || row.debtStatus || row.estado || "").toLowerCase();
    if (/paid|pagad|liquidad|cancel|anulad|closed|cerrad/.test(status)) return false;
    return debtRemainingAmount(row) > 0 && DEBT_ACTIVE_STATUSES.has(status);
  }

  function debtCreatedMs(row = {}) {
    return Math.max(ms(row.createdAt), ms(row.incidentDate), ms(row.fecha), Number(row.createdAtMs || 0), Number(row.incidentAtMs || 0), rowMs(row));
  }

  function debtActivityId(row = {}) {
    return safe(row.id || row.debtId || row.documentId || row.uid || "");
  }

  const PHOTO_DIRECT_FIELDS = Object.freeze([
    "receiptUrl", "comprobanteUrl", "attachmentUrl", "fileUrl", "downloadUrl", "url",
    "photoUrl", "fotoUrl", "imageUrl", "voucherUrl", "proofUrl", "proofImageUrl",
    "receiptDownloadUrl", "comprobanteDownloadUrl", "comprobantePagoUrl", "comprobanteTransferenciaUrl",
    "driverReceiptUrl", "adminReceiptUrl", "davidReceiptUrl"
  ]);
  const PHOTO_OBJECT_FIELDS = Object.freeze(["receipt", "comprobante", "attachment", "file", "photo", "foto", "image", "proof"]);
  const PHOTO_ARRAY_FIELDS = Object.freeze(["attachments", "files", "receipts", "comprobantes", "photos", "fotos", "images", "evidences"]);

  function rowPhotoAttachment(row = {}) {
    if (!row) return null;
    for (const field of PHOTO_DIRECT_FIELDS) {
      const url = safe(row[field]);
      if (url) {
        return {
          url,
          name:safe(row.receiptName || row.fileName || row.attachmentName || row.comprobanteName || row.photoName || row.name || "Comprobante"),
          mime:safe(row.receiptMime || row.mimeType || row.contentType || row.fileType || "")
        };
      }
    }
    for (const field of PHOTO_OBJECT_FIELDS) {
      const item = row[field];
      if (!item || typeof item !== "object") continue;
      const url = safe(item.url || item.receiptUrl || item.downloadUrl || item.fileUrl || item.photoUrl || item.imageUrl || item.comprobanteUrl);
      if (url) {
        return {
          url,
          name:safe(item.name || item.fileName || item.originalName || item.title || row.receiptName || "Comprobante"),
          mime:safe(item.mime || item.mimeType || item.contentType || row.receiptMime || "")
        };
      }
    }
    for (const field of PHOTO_ARRAY_FIELDS) {
      const arr = Array.isArray(row[field]) ? row[field] : [];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const url = safe(item.url || item.receiptUrl || item.downloadUrl || item.fileUrl || item.photoUrl || item.imageUrl || item.comprobanteUrl);
        if (url) {
          return {
            url,
            name:safe(item.name || item.fileName || item.originalName || item.title || row.receiptName || "Comprobante"),
            mime:safe(item.mime || item.mimeType || item.contentType || row.receiptMime || "")
          };
        }
      }
    }
    return null;
  }

  function rowHasAttachment(row = {}) {
    return !!rowPhotoAttachment(row);
  }

  function debtHasAttachment(row = {}) {
    return rowHasAttachment(row);
  }

  function activityPhotoKey(type = "activity", row = {}) {
    const raw = safe(row.id || row.paymentId || row.debtPaymentId || row.debtId || row.closureId || row.documentId || row.uid || row.createdAtMs || row.updatedAtMs || rowMs(row));
    return `${safe(type || "activity")}:${raw || rowMs(row) || Date.now()}`;
  }

  function activityPhotoRegistryRow(activity = {}) {
    const source = activity.source || {};
    return {
      ...source,
      __photoKey:activity.photoKey,
      photoKey:activity.photoKey,
      photoTitle:activity.photoTitle || activity.title || "Comprobante",
      photoMeta:activity.photoMeta || activity.meta || "Comprobante cargado",
      photoAmount:Number.isFinite(Number(activity.photoAmount)) ? Number(activity.photoAmount) : abs(activity.amount || 0),
      activityType:activity.type || "activity"
    };
  }

  function summarizePendingDebts(rows = state.debts) {
    const normalized = (Array.isArray(rows) ? rows : []).filter(debtIsActive).sort((a,b)=>debtCreatedMs(a)-debtCreatedMs(b));
    const totalOriginal = normalized.reduce((sum,row)=>sum + debtTotalAmount(row), 0);
    const totalPaid = normalized.reduce((sum,row)=>sum + debtPaidAmount(row), 0);
    const totalPenalty = normalized.reduce((sum,row)=>sum + debtPenaltyAmount(row), 0);
    const remaining = normalized.reduce((sum,row)=>sum + debtRemainingAmount(row), 0);
    const byType = normalized.reduce((acc,row)=>{ const type = debtTypeOf(row); acc[type] = (acc[type] || 0) + debtRemainingAmount(row); return acc; }, {});
    return { kind:"pendientes", debts:normalized, activeDebts:normalized, records:[], expenses:[], gross:remaining, mainTotal:remaining, totalOriginal, totalPaid, totalPenalty, remainingAmount:remaining, pendingTotal:remaining, byType, amountToDriver:0, amountFromDriver:remaining, netSettlementToDriver:-remaining, summaryLabel:"Deuda pendiente independiente" };
  }

  function debtPaymentRows(rows = state.debtPayments) {
    return (Array.isArray(rows) ? rows : []).filter(row => !movementIsDeleted(row)).sort((a,b)=>rowMs(b)-rowMs(a));
  }

  function pendingDebtOldestRow() {
    return summarizePendingDebts().activeDebts[0] || null;
  }

  function debtPaymentId(driverUid = getOwnDriverUid()) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `debtpay_${safe(driverUid || "driver").replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}_${rand}`;
  }

  function debtReceiptPath({ driverUid = getOwnDriverUid(), paymentId = debtPaymentId(driverUid), file = null } = {}) {
    const ext = extensionForFile(file || { name:"comprobante.jpg", type:"image/jpeg" });
    return `deudas/${safe(driverUid).replace(/[^a-zA-Z0-9_-]/g, "_")}/pagos/${safe(paymentId).replace(/[^a-zA-Z0-9_-]/g, "_")}/comprobante.${ext}`;
  }

  function dateShort(value) {
    const d = new Date(value || Date.now());
    return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit" }).format(d);
  }

  function timeShort(value) {
    const d = new Date(value || Date.now());
    return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, hour:"2-digit", minute:"2-digit", hour12:false }).format(d);
  }

  function dateTimeShort(value) {
    const d = new Date(value || Date.now());
    return `${dateShort(d.getTime())} · ${timeShort(d.getTime())}`;
  }

  function accountName() {
    return safe(state.profile?.nombre || state.profile?.nombreCompleto || state.profile?.displayName || state.user?.displayName || state.user?.email?.split("@")[0] || (isAdmin() ? "DAVID" : "CHOFER")).toUpperCase();
  }

  function displayName() {
    if (isAdmin()) {
      return safe(state.selectedDriverName || "SELECCIONAR CHOFER").toUpperCase();
    }
    return accountName();
  }

  function getOwnDriverUid() {
    return safe(state.profile?.uid || state.profile?.driverUid || state.profile?.choferUid || state.profileDocumentId || state.user?.uid);
  }

  function getDriverUid() {
    return isAdmin() ? safe(state.selectedDriverUid) : getOwnDriverUid();
  }

  function notificationDriverUid() {
    if (isAdmin()) return safe(state.selectedDriverUid || "");
    return getOwnDriverUid();
  }

  function closureDriverUids(row = {}) {
    return [
      row.driverUid, row.choferUid, row.uid, row.ownerUid,
      row.driverId, row.choferId, row.driver_id, row.chofer_id,
      row.userUid, row.userId, row.createdByUid, row.createdBy, row.ownerId,
      row.conductorUid, row.conductorId, row.assignedDriverUid
    ].map(safe).filter(Boolean);
  }

  function tabAlertScopeUid() {
    return safe(notificationDriverUid() || getDriverUid() || getOwnDriverUid() || state.user?.uid || "anon");
  }

  function tabAlertStorageKey(uid = tabAlertScopeUid()) {
    return `explora:pay-home:card-alerts:v4017:${uid || "anon"}`;
  }

  function normalizeTabAlertCounts(counts = {}) {
    return PAY_TAB_ORDER.reduce((acc, tab) => {
      acc[tab] = Math.max(0, Math.min(99, Math.trunc(number(counts?.[tab]))));
      return acc;
    }, { ...PAY_TAB_ALERT_ZERO });
  }

  function resetTabAlertScope() {
    state.tabAlertScope = "";
    state.tabAlertLoadedAt = 0;
    state.tabAlertMovements = {};
    state.tabAlerts = { ...PAY_TAB_ALERT_ZERO };
  }

  function ensureTabAlertState() {
    const uid = tabAlertScopeUid();
    if (state.tabAlertScope === uid) return;
    state.tabAlertScope = uid;
    state.tabAlertLoadedAt = Date.now();
    state.tabAlerts = { ...PAY_TAB_ALERT_ZERO };
    state.tabAlertMovements = {};
    try {
      const raw = localStorage.getItem(tabAlertStorageKey(uid));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      state.tabAlerts = normalizeTabAlertCounts(parsed?.counts || {});
      state.tabAlertMovements = parsed?.movements && typeof parsed.movements === "object" ? parsed.movements : {};
    } catch (_) {
      state.tabAlerts = { ...PAY_TAB_ALERT_ZERO };
      state.tabAlertMovements = {};
    }
  }

  function persistTabAlertState() {
    ensureTabAlertState();
    try {
      const entries = Object.entries(state.tabAlertMovements || {})
        .sort((a, b) => number(b[1]?.ms) - number(a[1]?.ms))
        .slice(0, 900);
      state.tabAlertMovements = Object.fromEntries(entries);
      localStorage.setItem(tabAlertStorageKey(), JSON.stringify({
        counts:normalizeTabAlertCounts(state.tabAlerts),
        movements:state.tabAlertMovements,
        updatedAt:Date.now()
      }));
    } catch (_) {}
  }

  function tabAlertRowKey(collectionName = "", row = {}) {
    const id = safe(row.id || row.recordId || row.billingRecordId || row.expenseId || row.gastoId || row.operationId || row.uid);
    if (id) return `${collectionName}:${id}`;
    return `${collectionName}:${rowMs(row)}:${amountOf(row)}:${methodOf(row)}:${safe(row.createdByUid || row.driverUid || row.choferUid)}`;
  }

  function tabAlertSignature(collectionName = "", row = {}) {
    if (collectionName === "gastos") {
      return [amountOf(row), expenseTypeLabel(row), rowMs(row), safe(row.updatedAtMs || row.estado || row.status || row.notes || row.descripcion)].join("|");
    }
    const method = methodOf(row);
    return [amountOf(row), method, rowMs(row), safe(row.updatedAtMs || row.estado || row.status || row.paymentProvider || row.metodoPago)].join("|");
  }

  function tabAlertTargetsForMovement(collectionName = "", row = {}) {
    if (collectionName === "gastos") return ["gastos"];
    if (collectionName === "deudas_choferes" || collectionName === "deuda_pagos") return ["pendientes"];
    if (collectionName !== "billing_records") return [];
    const method = methodOf(row);
    if (method === "cash") return ["chofer", "caja_chica"];
    return ["explora"];
  }

  function registerTabAlertMovements(collectionName = "", rows = []) {
    if (!collectionName || !Array.isArray(rows)) return;
    ensureTabAlertState();
    const currentUid = tabAlertScopeUid();
    if (!currentUid || currentUid === "anon") return;
    const hadStoredHistory = Object.keys(state.tabAlertMovements || {}).length > 0;
    const freshBootWindow = !hadStoredHistory && Date.now() - number(state.tabAlertLoadedAt) < 3500;
    let changed = false;
    for (const row of rows) {
      const tabs = tabAlertTargetsForMovement(collectionName, row);
      if (!tabs.length) continue;
      const key = tabAlertRowKey(collectionName, row);
      const sig = tabAlertSignature(collectionName, row);
      const previous = state.tabAlertMovements[key];
      const previousSig = safe(previous?.sig);
      const isNewOrChanged = !previous || previousSig !== sig;
      const shouldNotify = isNewOrChanged && !freshBootWindow;
      if (shouldNotify) {
        const targetTabs = Array.from(new Set([...(Array.isArray(previous?.tabs) ? previous.tabs : []), ...tabs])).filter(tab => PAY_TAB_ORDER.includes(tab));
        for (const tab of targetTabs) state.tabAlerts[tab] = Math.min(99, number(state.tabAlerts[tab]) + 1);
      }
      if (isNewOrChanged || !previous) {
        state.tabAlertMovements[key] = { sig, tabs, ms:rowMs(row) || Date.now(), collection:collectionName };
        changed = true;
      }
    }
    if (changed) persistTabAlertState();
  }

  function markTabAlertSeen(tab = state.tab) {
    const key = activeClosureKind(tab) || tab;
    if (!PAY_TAB_ORDER.includes(key)) return;
    ensureTabAlertState();
    if (!number(state.tabAlerts[key])) return;
    state.tabAlerts[key] = 0;
    persistTabAlertState();
  }

  function renderTabAlerts() {
    ensureTabAlertState();
    document.querySelectorAll("[data-pay-tab]").forEach(button => {
      const tab = activeClosureKind(button.dataset.payTab) || button.dataset.payTab;
      let badge = button.querySelector(".pay-tab-alert-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "pay-tab-alert-badge";
        button.appendChild(badge);
      }
      const count = Math.max(0, Math.trunc(number(state.tabAlerts?.[tab])));
      badge.hidden = count < 1;
      badge.textContent = `🛎️ ${count > 99 ? "99+" : count}`;
      button.classList.toggle("has-pay-alert", count > 0);
    });
  }

  function closureBelongsToDriver(row = {}, uid = "") {
    const targetUid = safe(uid);
    if (!targetUid) return false;
    return closureDriverUids(row).includes(targetUid);
  }

  function closureDriverName(row = {}) {
    return safe(
      row.driverName ||
      row.choferNombre ||
      row.nombreChofer ||
      row.selectedDriverName ||
      state.selectedDriverName ||
      "Chofer"
    );
  }

  function closureRequesterText(row = {}) {
    const requestedByRole = safe(row.requestedByRole || row.solicitadoPorRol || row.requestedRole).toLowerCase();
    if (requestedByRole === "driver" || requestedByRole === "chofer") return `${closureDriverName(row)} pidió el cierre`;
    if (requestedByRole === "admin" || requestedByRole === "explora") return "Explora pidió el cierre";
    return "Cierre solicitado";
  }

  function hasAdminDriverSelected() {
    return !isAdmin() || !!getDriverUid();
  }

  function clearListeners() {
    for (const unsub of state.unsubscribers.splice(0)) {
      try { unsub?.(); } catch (_) {}
    }
  }

  async function waitFirebase(timeout = 14000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const fb = window.ExploraFirebase || {};
      if (fb.db && fb.auth) {
        state.db = fb.db; state.auth = fb.auth; state.storage = fb.storage || null;
        return fb;
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error("Firebase no está disponible para Explora Pago Home.");
  }

  function installShell() {
    if ($("exploraPagoDashboard")) return;
    const shell = document.querySelector(".dashboard-shell-real");
    if (!shell) return;
    const html = `
      <section aria-label="Inicio financiero Explora" class="explora-pay-home" id="exploraPagoDashboard">
        <header class="pay-topbar">
          <div class="pay-hello">
            <span class="pay-avatar" id="payAvatar"><svg viewBox="0 0 24 24"><path d="M7.5 12.5 10 15l6.5-6.5"></path><path d="M3.5 12c2.4-4.4 5.6-4.4 8 0 2.4 4.4 5.6 4.4 9 0"></path></svg></span>
            <strong class="pay-title" id="payGreeting">Hola, CHOFER</strong>
          </div>
          <div class="pay-icons">
            <button class="pay-icon-btn" id="paySearchBtn" type="button" aria-label="Buscar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg></button>
            <button class="pay-icon-btn pay-bell-btn" id="payBellBtn" type="button" aria-label="Notificaciones de cierres"><svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg><span class="pay-bell-badge" id="payBellBadge" hidden>0</span></button>
          </div>
        </header>
        <nav class="pay-tabs" aria-label="Resumen de caja Explora" role="tablist">
          <button class="pay-tab is-active" data-pay-tab="chofer" type="button" role="tab" aria-selected="true"><span class="pay-tab-label">Chofer</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
          <button class="pay-tab" data-pay-tab="explora" type="button" role="tab" aria-selected="false"><span class="pay-tab-label">Explora</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
          <button class="pay-tab" data-pay-tab="gastos" type="button" role="tab" aria-selected="false"><span class="pay-tab-label">Gastos</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
          <button class="pay-tab" data-pay-tab="caja_chica" type="button" role="tab" aria-selected="false"><span class="pay-tab-label">Caja chica</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
          <button class="pay-tab" data-pay-tab="pendientes" type="button" role="tab" aria-selected="false"><span class="pay-tab-label">Pendientes</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
        </nav>
        <section class="pay-admin-driver-picker pay-admin-activity-filters" id="payAdminDriverPicker" hidden>
          <div class="pay-admin-filter-field">
            <label for="payAdminDriverSelect">Filtrar por chofer</label>
            <select id="payAdminDriverSelect"><option value="">Todos los choferes</option></select>
          </div>
          <div class="pay-admin-filter-field">
            <label for="payAdminTypeSelect">Filtrar por tipo</label>
            <select id="payAdminTypeSelect"><option value="">Todos los tipos</option></select>
          </div>
          <small id="payAdminDriverHint">Vista admin: últimas actividades de todos los choferes en tiempo real.</small>
        </section>
        <section class="pay-main-card" aria-live="polite">
          <div class="pay-main-row">
            <div class="pay-amount-wrap">
              <div class="pay-amount-line"><strong class="pay-amount" id="payMainAmount">—</strong></div>
              <span class="pay-subtitle" id="payMainSubtitle">Cargando caja operativa…</span>
            </div>
          </div>
          <div class="pay-actions">
            <button class="pay-action" data-pay-run="nuevo-servicio" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg><span>Registrar<br/>cobro</span></button>
            <button class="pay-action" data-pay-run="cargar-gastos" type="button"><svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg><span>Cargar<br/>gasto</span></button>
            <button class="pay-action" id="payClosureActionBtn" type="button" hidden disabled><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 14h6M9 17h4"></path></svg><span>Pedir<br/>cierre</span></button>
          </div>
          <div class="pay-liquid-pill"><span id="payPillLabel" class="closure-liquidation-label">Dinero a liquidar</span><strong id="payPillAmount">—</strong></div>
          <div class="pay-extra-lines" id="payExtraLines"></div>
          <div class="pay-status-pill" id="payClosureStatus" hidden><span><b>—</b><br><small id="payClosureStatusText">—</small></span><button id="payClosureStatusBtn" type="button">Ver</button></div>
        </section>
        <section class="pay-section" aria-labelledby="payActivityTitle">
          <div class="pay-section-head"><h2 id="payActivityTitle">Última actividad</h2><button id="payRefreshBtn" type="button">Actualizar →</button></div>
          <div class="pay-activity-list" id="payActivityList"><div class="pay-activity-empty">Cargando movimientos…</div></div>
        </section>
      </section>
      <section class="explora-pay-more" id="payMoreScreen" hidden aria-label="Más opciones Explora">
        <header class="pay-more-head">
          <button class="pay-more-back" id="payMoreBack" type="button" aria-label="Volver al inicio"><svg viewBox="0 0 24 24"><path d="M15 6 9 12l6 6"></path></svg></button>
          <div class="pay-more-title-wrap">
            <span class="pay-more-kicker">EXPLORA</span>
            <h1>Más</h1>
            <p id="payMoreSubtitle">Accesos rápidos y configuración de la cuenta.</p>
          </div>
        </header>
        <section class="pay-more-profile">
          <span class="pay-more-avatar" id="payMoreAvatar"><svg viewBox="0 0 24 24"><path d="M7.5 12.5 10 15l6.5-6.5"></path><path d="M3.5 12c2.4-4.4 5.6-4.4 8 0 2.4 4.4 5.6 4.4 9 0"></path></svg></span>
          <div>
            <strong id="payMoreName">CHOFER</strong>
            <small id="payMoreRole">Cuenta Explora</small>
          </div>
        </section>
        <section class="pay-more-card" id="payMoreList" aria-label="Accesos de Más"></section>
        <section class="pay-more-card pay-more-admin" id="payMoreAdminList" aria-label="Accesos administrativos" hidden></section>
        <div class="pay-more-spacer"></div>
        <section class="pay-more-logout-zone">
          <button class="pay-more-logout" id="payMoreLogoutBtn" type="button">
            <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path></svg>
            <span>Salir</span>
          </button>
        </section>
      </section>
      <section class="explora-pay-notifications" id="payNotificationsScreen" hidden aria-label="Notificaciones Explora">
        <header class="pay-notification-head">
          <button class="pay-notification-back" id="payNotificationsBack" type="button" aria-label="Volver al inicio"><svg viewBox="0 0 24 24"><path d="M15 6 9 12l6 6"></path></svg></button>
          <button class="pay-notification-settings" id="payNotificationsSettings" type="button" aria-label="Configuración"><svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"></path><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.76l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.97 1.47V21a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-1.03-1.47 1.6 1.6 0 0 0-1.76.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-.97H3a2 2 0 1 1 0-4h.09A1.6 1.6 0 0 0 4.56 9a1.6 1.6 0 0 0-.32-1.76l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 8.83 4.7 1.6 1.6 0 0 0 9.8 3.23V3a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.76-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9c.63.23 1.05.83 1.05 1.5V12c0 .67-.42 1.27-1.05 1.5Z"></path></svg></button>
        </header>
        <h1 class="pay-notification-title">Notificaciones</h1>
        <div class="pay-notification-list" id="payNotificationList">
          <div class="pay-notification-empty">No tenés cierres abiertos.</div>
        </div>
      </section>
      <button class="pay-floating-spark pay-efficiency-btn" id="payEfficiencyBtn" type="button" aria-label="Eficiencia Operativa"><span class="pay-efficiency-icon" aria-hidden="true"></span><span class="pay-efficiency-asterisk" aria-hidden="true">*</span></button>
      <nav class="pay-bottom-nav" id="payBottomNav" aria-label="Navegación principal Explora">
        <button class="pay-nav-btn is-active" data-pay-nav="inicio" type="button"><svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 10v10h14V10"></path></svg><span>Inicio</span></button>
        <button class="pay-nav-btn" data-pay-nav="actividad" type="button"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"></path></svg><span>Actividad</span></button>
        <button class="pay-nav-btn pay-nav-main" data-pay-run="nuevo-servicio" type="button"><span class="pay-nav-plus-icon" aria-hidden="true">+</span><span>Cobrar</span></button>
        <button class="pay-nav-btn" id="payNavClosure" type="button"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 14h6M9 17h4"></path></svg><span>Cierre</span></button>
        <button class="pay-nav-btn" data-pay-nav="mas" type="button"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"></path><path d="M18 17h2M19 16v2"></path></svg><span>Más</span></button>
      </nav>
      <div class="pay-admin-delete-backdrop" id="payAdminDeleteBackdrop" aria-hidden="true">
        <section class="pay-admin-delete-modal" role="dialog" aria-modal="true" aria-labelledby="payAdminDeleteTitle">
          <header>
            <div><h2 id="payAdminDeleteTitle">Borrar movimientos</h2><p>Cobros, caja chica y gastos. El cierre se ajusta automáticamente.</p></div>
            <button class="pay-admin-delete-close" id="payAdminDeleteClose" type="button" aria-label="Cerrar">×</button>
          </header>
          <div class="pay-admin-delete-warning">Acción solo para administrador. Se modifica Firestore y se recalculan los cierres relacionados.</div>
          <div class="pay-admin-delete-message" id="payAdminDeleteMessage" role="status"></div>
          <div class="pay-admin-delete-list" id="payAdminDeleteList"></div>
          <div class="pay-admin-delete-actions"><button id="payAdminDeleteCancel" type="button">Volver</button></div>
        </section>
      </div>
      <div class="pay-efficiency-backdrop" id="payEfficiencyBackdrop" aria-hidden="true">
        <section class="pay-efficiency-modal" role="dialog" aria-modal="true" aria-labelledby="payEfficiencyTitle">
          <header><div><h2 id="payEfficiencyTitle">Eficiencia operativa</h2><p>Comparación contra tu propio historial.</p></div><button class="pay-efficiency-close" id="payEfficiencyClose" type="button" aria-label="Cerrar">×</button></header>
          <div class="pay-efficiency-body" id="payEfficiencyBody"><div class="pay-efficiency-loading">Calculando eficiencia…</div></div>
        </section>
      </div>
      <div class="pay-closure-backdrop" id="payClosureBackdrop" aria-hidden="true">
        <section class="pay-closure-modal" role="dialog" aria-modal="true" aria-labelledby="payClosureTitle">
          <header><div><h2 id="payClosureTitle">Cierre a demanda</h2><p id="payClosureSubtitle">Pedí o confirmá un cierre cuando sea necesario.</p></div><button class="pay-closure-close" id="payClosureClose" type="button" aria-label="Cerrar">×</button></header>
          <div class="pay-closure-field" id="payClosureDriverField" hidden><label for="payClosureDriverSelect">Chofer</label><select id="payClosureDriverSelect"><option value="">Cargando choferes…</option></select></div>
          <div class="pay-closure-field pay-closure-km-field" id="payClosureKmField" hidden><label for="payClosureKmInput">KM actual del auto</label><input id="payClosureKmInput" type="number" inputmode="numeric" min="0" step="1" placeholder="Ej: 100200" /><small id="payClosureKmHint">Este KM cierra el período de eficiencia y será el inicio del próximo.</small></div>
          <div class="pay-closure-summary" id="payClosureSummary"></div>
          <div class="pay-closure-field" id="payDebtPaymentField" hidden><label for="payDebtPaymentAmountInput">Monto a pagar</label><input id="payDebtPaymentAmountInput" type="text" inputmode="numeric" autocomplete="off" placeholder="$ 0" /><small id="payDebtPaymentHint">El pago reduce la deuda pendiente actual.</small></div>
          <div class="pay-closure-field" id="payClosureFileField" hidden><label for="payClosureReceiptInput">Comprobante de transferencia</label><input id="payClosureReceiptInput" type="file" accept="image/*,application/pdf" /></div>
          <div class="pay-closure-message" id="payClosureMessage"></div>
          <div class="pay-closure-actions"><button class="pay-closure-secondary" id="payClosureCancel" type="button">Cancelar</button><button class="pay-closure-primary" id="payClosureSubmit" type="button">Pedir cierre</button></div>
        </section>
      </div>
      <div class="pay-profile-backdrop" id="payProfileBackdrop" aria-hidden="true">
        <section class="pay-profile-modal" role="dialog" aria-modal="true" aria-labelledby="payProfileTitle">
          <header><div><h2 id="payProfileTitle">Mi perfil</h2><p>Datos necesarios para cobrar y pedir cierres.</p></div><button class="pay-profile-close" id="payProfileClose" type="button" aria-label="Volver">×</button></header>
          <div class="pay-profile-body" id="payProfileBody"></div>
          <div class="pay-profile-message" id="payProfileMessage" role="status"></div>
          <div class="pay-profile-actions"><button class="pay-profile-secondary" id="payProfileBack" type="button">Volver</button><button class="pay-profile-primary" id="payProfileSave" type="button">Guardar</button></div>
        </section>
      </div>
    `;
    shell.insertAdjacentHTML("afterbegin", html);
    document.body.classList.add("explora-pay-mode", "explora-legacy-clean");
  }

  function runExistingAction(action) {
    try {
      if (window.ExploraActions?.[action]) { window.ExploraActions[action](); return; }
      const oldButton = Array.from(document.querySelectorAll("[data-action]")).find(el => el.getAttribute("data-action") === action);
      if (oldButton && !oldButton.closest("#exploraPagoDashboard") && !oldButton.closest("#payBottomNav")) oldButton.click();
    } catch (error) { console.warn("EXPLORA_PAY_ACTION_FAILED", action, error); }
  }


  async function refreshOpenData(reason = "manual-refresh") {
    if (!state.db || !state.user || state.refreshing) return;
    state.refreshing = true;
    const refreshButton = $("payRefreshBtn");
    const originalText = refreshButton?.textContent || "Actualizar →";
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = "Actualizando…";
    }
    try {
      const activeTab = state.tab;
      const activeView = state.view;
      const selectedUid = state.selectedDriverUid;
      const selectedName = state.selectedDriverName;
      if (isAdmin()) {
        await fetchDrivers();
        if (selectedUid) {
          const driver = state.drivers.find(item => item.uid === selectedUid);
          state.selectedDriverUid = selectedUid;
          state.selectedDriverName = driver?.name || selectedName || "";
        }
      }
      const uid = getDriverUid();
      if (uid) {
        const [records, expenses, closures, debts, debtPayments] = await Promise.all([
          getScopedDocs("billing_records", uid),
          getScopedDocs("gastos", uid),
          getScopedDocs("cierres_semanales", uid),
          getScopedDocs("deudas_choferes", uid),
          getScopedDocs("deuda_pagos", uid)
        ]);
        state.records = records.sort((a,b)=>rowMs(b)-rowMs(a));
        state.expenses = expenses.sort((a,b)=>rowMs(b)-rowMs(a));
        state.closures = closures.sort((a,b)=>rowMs(b)-rowMs(a));
        state.debts = debts.sort((a,b)=>debtCreatedMs(b)-debtCreatedMs(a));
        state.debtPayments = debtPayments.sort((a,b)=>rowMs(b)-rowMs(a));
        registerTabAlertMovements("billing_records", state.records);
        registerTabAlertMovements("gastos", state.expenses);
        registerTabAlertMovements("deudas_choferes", state.debts);
        registerTabAlertMovements("deuda_pagos", state.debtPayments);
      } else if (isAdmin()) {
        const [records, expenses, closures, debts, debtPayments] = await Promise.all([
          getGlobalDocs("billing_records"),
          getGlobalDocs("gastos"),
          getGlobalDocs("cierres_semanales"),
          getGlobalDocs("deudas_choferes"),
          getGlobalDocs("deuda_pagos")
        ]);
        state.records = records.sort((a,b)=>rowMs(b)-rowMs(a));
        state.expenses = expenses.sort((a,b)=>rowMs(b)-rowMs(a));
        state.closures = closures.sort((a,b)=>rowMs(b)-rowMs(a));
        state.debts = debts.sort((a,b)=>debtCreatedMs(b)-debtCreatedMs(a));
        state.debtPayments = debtPayments.sort((a,b)=>rowMs(b)-rowMs(a));
        registerTabAlertMovements("billing_records", state.records);
        registerTabAlertMovements("gastos", state.expenses);
        registerTabAlertMovements("deudas_choferes", state.debts);
        registerTabAlertMovements("deuda_pagos", state.debtPayments);
        state.pendingClosure = null;
      }
      state.tab = activeTab;
      state.view = activeView;
      render();
      startRealtime(reason);
    } catch (error) {
      console.warn("EXPLORA_MANUAL_REFRESH", error?.code || error?.message || error);
      startRealtime(`${reason}-fallback`);
    } finally {
      state.refreshing = false;
      const updatedButton = $("payRefreshBtn");
      if (updatedButton) {
        updatedButton.disabled = false;
        updatedButton.textContent = originalText;
      }
    }
  }

  function setPendingActionMode(enabled = false) {
    const actions = $("payClosureActionBtn")?.closest(".pay-actions");
    actions?.classList.toggle("is-pending-mode", !!enabled);
    document.querySelectorAll("[data-pay-run]").forEach(button => {
      button.hidden = !!enabled;
      button.setAttribute("aria-hidden", enabled ? "true" : "false");
    });
  }

  function scrollActivePayTabIntoView() {
    const active = document.querySelector(".pay-tab.is-active");
    if (!active) return;
    try { active.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
    catch (_) { active.scrollIntoView(false); }
  }

  function bindShell() {
    document.querySelectorAll("[data-pay-tab]").forEach(button => button.addEventListener("click", () => {
      state.tab = button.dataset.payTab || "chofer";
      markTabAlertSeen(state.tab);
      render();
      scrollActivePayTabIntoView();
    }));
    document.querySelectorAll("[data-pay-run]").forEach(button => button.addEventListener("click", () => {
      if (isAdmin() && button.closest("#payBottomNav")) {
        showPayView("notificaciones");
        return;
      }
      runExistingAction(button.dataset.payRun);
    }));
    $("payClosureActionBtn")?.addEventListener("click", () => {
      if (activeClosureKind(state.tab) === "pendientes") {
        openDebtPaymentModal();
        return;
      }
      // Pedir cierre SIEMPRE crea un cierre nuevo del período abierto actual.
      // No debe abrir un cierre viejo pendiente: eso queda para "Ver", notificaciones o actividad.
      if (!closureButtonState(state.tab, state.latestSummary || computeSummary()).enabled) return;
      openClosureModal("request", null, state.tab);
    });
    $("payEfficiencyBtn")?.addEventListener("click", openEfficiencyModal);
    $("payNavClosure")?.addEventListener("click", () => {
      if (isAdmin()) {
        showPayView("mas");
        return;
      }
      // Botón inferior "Cierre" = ver/resolver cierres existentes abiertos o historial.
      // NO crea un cierre nuevo. Para crear uno nuevo, usar el botón "Pedir cierre" dentro de cada módulo.
      const pending = pendingClosureRows(notificationDriverUid());
      if (pending.length === 1) {
        // Un solo cierre abierto: abrir directo su detalle
        showPayView("inicio");
        const row = pending[0];
        const kind = closureKindOf(row) || state.tab;
        openClosureModal(isAdmin() ? "admin-review" : "confirm", row, kind);
      } else {
        // Sin pendientes o varios: ir a la pantalla de notificaciones/lista de cierres
        showPayView("notificaciones");
      }
    });
    $("payClosureStatusBtn")?.addEventListener("click", () => {
      const pending = state.pendingClosure || pendingHomeClosureFor(getDriverUid(), state.tab);
      if (!pending) return;
      const kind = closureHomeModuleOf(pending) || closureKindOf(pending) || state.tab;
      openClosureModal(pending && !isAdmin() ? "confirm" : "admin-review", pending, kind);
    });
    $("payBellBtn")?.addEventListener("click", () => showPayView("notificaciones"));
    $("payMainSubtitle")?.addEventListener("click", event => {
      const button = event.target?.closest?.("[data-pay-previous-toggle]");
      if (!button) return;
      const key = activeClosureKind(button.dataset.payPreviousToggle || state.tab);
      if (!["caja_chica", "gastos", "explora", "chofer", "pendientes"].includes(key)) return;
      state.previousDetailsOpen[key] = !state.previousDetailsOpen[key];
      renderMainCard(state.latestSummary || computeSummary());
    });
    $("payRefreshBtn")?.addEventListener("click", () => refreshOpenData("manual-refresh"));
    $("payAdminDriverSelect")?.addEventListener("change", event => selectAdminDriver(event.target?.value || ""));
    $("payAdminTypeSelect")?.addEventListener("change", event => selectAdminActivityType(event.target?.value || ""));
    $("payClosureClose")?.addEventListener("click", closeClosureModal);
    $("payClosureCancel")?.addEventListener("click", closeClosureModal);
    $("payClosureBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payClosureBackdrop") closeClosureModal(); });
    $("payEfficiencyClose")?.addEventListener("click", closeEfficiencyModal);
    $("payEfficiencyBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payEfficiencyBackdrop") closeEfficiencyModal(); });
    $("payEfficiencyBody")?.addEventListener("click", event => {
      const action = event.target?.closest?.("[data-pay-efficiency-action]")?.dataset?.payEfficiencyAction || "";
      if (action === "close") closeEfficiencyModal();
      if (action === "save-initial-km") saveInitialKmFromEfficiency().catch(error => setEfficiencyFormMessage(error?.message || "No se pudo guardar el KM inicial.", "error"));
      if (action === "save-current-km") saveCurrentKmFromEfficiency().catch(error => setEfficiencyFormMessage(error?.message || "No se pudo guardar el KM actual.", "error"));
    });
    $("payClosureReceiptInput")?.addEventListener("change", event => { state.modalFile = event.target?.files?.[0] || null; renderClosureModal(); });
    $("payDebtPaymentAmountInput")?.addEventListener("input", event => { if (window.formatCurrencyInput) event.target.value = window.formatCurrencyInput(event.target.value); });
    $("payClosureSubmit")?.addEventListener("click", submitClosureModal);
    $("payProfileClose")?.addEventListener("click", closeDriverProfileModal);
    $("payProfileBack")?.addEventListener("click", closeDriverProfileModal);
    $("payProfileBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payProfileBackdrop") closeDriverProfileModal(); });
    $("payProfileSave")?.addEventListener("click", saveDriverProfileModal);
    document.querySelector('[data-pay-nav="inicio"]')?.addEventListener("click", () => {
      if (isAdmin()) {
        state.adminActivityType = "pendientes";
        showPayView("inicio");
        render();
        setTimeout(() => $("payActivityTitle")?.scrollIntoView({ behavior:"smooth", block:"start" }), 40);
        return;
      }
      showPayView("inicio");
    });
    document.querySelector('[data-pay-nav="actividad"]')?.addEventListener("click", () => {
      if (isAdmin()) {
        showPayView("inicio");
        runExistingAction("admin-choferes");
        return;
      }
      showPayView("inicio");
      setTimeout(() => $("payActivityTitle")?.scrollIntoView({ behavior:"smooth", block:"start" }), 40);
    });
    document.querySelector('[data-pay-nav="mas"]')?.addEventListener("click", () => showPayView("mas"));
    $("payMoreBack")?.addEventListener("click", () => showPayView("inicio"));
    $("payNotificationsBack")?.addEventListener("click", () => showPayView("inicio"));
    $("payNotificationsSettings")?.addEventListener("click", () => showPayView("mas"));
    $("payAdminDeleteClose")?.addEventListener("click", closeAdminDeleteModal);
    $("payAdminDeleteCancel")?.addEventListener("click", closeAdminDeleteModal);
    $("payAdminDeleteBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payAdminDeleteBackdrop") closeAdminDeleteModal(); });
    $("payAdminDeleteList")?.addEventListener("click", event => {
      const button = event.target?.closest?.("[data-pay-admin-delete]");
      if (!button) return;
      submitAdminDeleteMovement(button.dataset.payAdminDelete, button.dataset.payAdminDeleteType, button).catch(error => setAdminDeleteMessage(error?.message || "No se pudo borrar el movimiento.", "error"));
    });
    $("payNotificationList")?.addEventListener("click", event => {
      const button = event.target.closest("[data-pay-notification-closure]");
      if (!button) return;
      openClosureFromNotification(button.dataset.payNotificationClosure);
    });
    $("payActivityList")?.addEventListener("click", event => {
      const row = event.target.closest("[data-pay-activity-closure]");
      if (!row) return;
      openClosureFromNotification(row.dataset.payActivityClosure);
    });
    $("payMoreLogoutBtn")?.addEventListener("click", logoutFromMore);
    $("payMoreList")?.addEventListener("click", event => {
      const button = event.target.closest("[data-pay-more-action]");
      if (!button) return;
      const action = safe(button.dataset.payMoreAction);
      if (action === "abrir-perfil") {
        openDriverProfileModal();
        return;
      }
      if (action === "admin-delete-movements") {
        openAdminDeleteModal();
        return;
      }
      showPayView("inicio");
      runExistingAction(action);
    });
    $("payMoreAdminList")?.addEventListener("click", event => {
      const button = event.target.closest("[data-pay-more-action]");
      if (!button) return;
      const action = safe(button.dataset.payMoreAction);
      if (action === "admin-delete-movements") {
        openAdminDeleteModal();
        return;
      }
      showPayView("inicio");
      runExistingAction(action);
    });
  }

  function setBottomNavActive(target = "inicio") {
    document.querySelectorAll("#payBottomNav .pay-nav-btn").forEach(button => {
      const nav = button.dataset.payNav || (button.id === "payNavClosure" ? "cierre" : "");
      button.classList.toggle("is-active", nav === target);
    });
  }

  function showPayView(view = "inicio") {
    const target = view === "mas" ? "mas" : view === "notificaciones" ? "notificaciones" : "inicio";
    state.view = target;
    const dashboard = $("exploraPagoDashboard");
    const more = $("payMoreScreen");
    const notifications = $("payNotificationsScreen");
    const isMore = target === "mas";
    const isNotifications = target === "notificaciones";
    const hideHome = isMore || isNotifications;
    if (dashboard) {
      dashboard.hidden = hideHome;
      dashboard.style.display = hideHome ? "none" : "";
      dashboard.setAttribute("aria-hidden", hideHome ? "true" : "false");
    }
    if (more) {
      more.hidden = !isMore;
      more.style.display = isMore ? "block" : "none";
      more.setAttribute("aria-hidden", isMore ? "false" : "true");
    }
    if (notifications) {
      notifications.hidden = !isNotifications;
      notifications.style.display = isNotifications ? "block" : "none";
      notifications.setAttribute("aria-hidden", isNotifications ? "false" : "true");
    }
    document.body.classList.toggle("pay-more-open", isMore);
    document.body.classList.toggle("pay-notifications-open", isNotifications);
    setBottomNavActive(isNotifications ? "" : target);
    if (isMore) renderMoreScreen();
    if (isNotifications) renderNotificationsScreen();
    if (isMore || isNotifications) window.scrollTo({ top: 0, behavior: "auto" });
  }

  function payOverlayIsOpen() {
    return !!document.querySelector(".pay-modal-backdrop.is-open, #payClosureBackdrop.is-open, #payEfficiencyBackdrop.is-open, #payProfileBackdrop.is-open, #payAdminDeleteBackdrop.is-open");
  }

  function forceHomeLanding() {
    state.view = "inicio";
    state.tab = "chofer";
    document.body.classList.remove("pay-more-open", "pay-notifications-open");
    const dashboard = $("exploraPagoDashboard");
    const more = $("payMoreScreen");
    const notifications = $("payNotificationsScreen");
    if (dashboard) { dashboard.hidden = false; dashboard.style.display = ""; dashboard.setAttribute("aria-hidden", "false"); }
    if (more) { more.hidden = true; more.style.display = "none"; more.setAttribute("aria-hidden", "true"); }
    if (notifications) { notifications.hidden = true; notifications.style.display = "none"; notifications.setAttribute("aria-hidden", "true"); }
    setBottomNavActive("inicio");
  }

  function moreItems() {
    return [
      { title:"Mi perfil", detail:"Datos de cuenta y preferencias", action:"abrir-perfil", icon:"user" },
      { title:"Mi auto", detail:"Vencimientos, patente y documentación", action:"mi-auto", icon:"car" },
      { title:"Multas y choques", detail:"Deudas y novedades del vehículo", action:"multas-choques", icon:"alert" },
      { title:"Préstamo Explora", detail:"Solicitud y estado del préstamo", action:"prestamo-explora", icon:"loan" },
      { title:"Comprobantes", detail:"Cobros, gastos y cierres cargados", action:"comprobantes", icon:"receipt" }
    ];
  }

  function adminMoreItems() {
    return [
      { title:"Chofer", detail:"Crear o eliminar", action:"admin-choferes", icon:"users" },
      { title:"Borrar movimientos", detail:"Cobros, caja chica y gastos", action:"admin-delete-movements", icon:"trash" },
      { title:"Cierres", detail:"Comprobantes y pagos pendientes", action:"admin-cierres", icon:"receipt" },
      { title:"Gastos", detail:"Gastos cargados por choferes", action:"admin-gastos", icon:"wallet" },
      { title:"Multas", detail:"Multas, choques y deudas", action:"admin-multas", icon:"alert" }
    ];
  }

  function moreIcon(name = "user") {
    const icons = {
      user:'<path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="8" r="4"></circle>',
      car:'<path d="M6 17h12l1-5-2-5H7l-2 5 1 5Z"></path><path d="M7 17v2M17 17v2M5 12h14"></path>',
      alert:'<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"></path>',
      loan:'<path d="M4 7h16v12H4z"></path><path d="M4 10h16"></path><path d="M8 15h4"></path>',
      receipt:'<path d="M7 3h10v18l-2-1-2 1-2-1-2 1-2-1Z"></path><path d="M9 8h6M9 12h6M9 16h4"></path>',
      users:'<path d="M16 21a6 6 0 0 0-12 0"></path><circle cx="10" cy="8" r="4"></circle><path d="M22 21a5 5 0 0 0-5-5"></path><path d="M17 4a4 4 0 0 1 0 8"></path>',
      wallet:'<path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path>',
      trash:'<path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6 7l1 14h10l1-14"></path><path d="M9 7V4h6v3"></path>'
    };
    return `<svg viewBox="0 0 24 24">${icons[name] || icons.user}</svg>`;
  }

  function adminDeleteRows(summary = state.latestSummary || computeSummary()) {
    if (!isAdmin()) return [];
    const rows = [];
    const billing = summary.billingRecords || summary.records || [];
    for (const row of billing) {
      const id = safe(row.id || row.recordId || row.billingRecordId);
      const amount = amountOf(row), method = methodOf(row), at = rowMs(row);
      if (!id || !(amount > 0)) continue;
      rows.push({
        id, type:"cobro", icon:"+", title:`${dateShort(at)} · Borrar cobro`,
        meta:paymentLabel(method), detail:`Elimina el cobro de Firestore y ajusta Chofer/Explora${method === "cash" ? " + caja chica" : ""}.`, amount
      });
      if (method === "cash" && !cashboxIsExcluded(row)) {
        rows.push({
          id, type:"caja_chica", icon:"🛎️", title:`${dateShort(at)} · Borrar caja chica`,
          meta:"Caja chica 5% generada por efectivo", detail:"Mantiene el cobro efectivo, pero lo excluye de caja chica y ajusta su cierre.", amount:amount * .05
        });
      }
    }
    for (const row of summary.expenses || []) {
      const id = safe(row.id || row.expenseId || row.gastoId);
      const amount = amountOf(row), at = rowMs(row);
      if (!id || !(amount > 0)) continue;
      rows.push({
        id, type:"gasto", icon:"−", title:`${dateShort(at)} · Borrar gasto`,
        meta:expenseTypeLabel(row), detail:"Elimina el gasto de Firestore y ajusta el cierre de gastos.", amount
      });
    }
    return rows.sort((a,b)=>b.id.localeCompare(a.id)).slice(0, 120);
  }

  function setAdminDeleteMessage(message = "", tone = "") {
    state.adminDeleteMessage = safe(message);
    const box = $("payAdminDeleteMessage");
    if (!box) return;
    box.textContent = state.adminDeleteMessage;
    box.classList.toggle("is-ok", tone === "ok");
    box.classList.toggle("is-error", tone === "error");
  }

  function renderAdminDeleteModal() {
    const list = $("payAdminDeleteList");
    if (!list) return;
    if (!isAdmin()) {
      list.innerHTML = `<div class="pay-admin-delete-empty">Esta opción es solo para administrador.</div>`;
      return;
    }
    if (!getDriverUid()) {
      list.innerHTML = `<div class="pay-admin-delete-empty">Primero seleccioná un chofer en el inicio.</div>`;
      return;
    }
    const rows = adminDeleteRows(state.latestSummary || computeSummary());
    if (!rows.length) {
      list.innerHTML = `<div class="pay-admin-delete-empty">No hay cobros, caja chica ni gastos abiertos para borrar en este chofer.</div>`;
      return;
    }
    list.innerHTML = rows.map(row => `
      <article class="pay-admin-delete-row">
        <span class="pay-admin-delete-icon">${esc(row.icon)}</span>
        <div class="pay-admin-delete-copy"><strong>${esc(row.title)}</strong><small>${esc(row.meta)} · ${currency(row.amount)}</small><em>${esc(row.detail)}</em></div>
        <button data-pay-admin-delete="${esc(row.id)}" data-pay-admin-delete-type="${esc(row.type)}" type="button" ${state.adminDeleteBusy ? "disabled" : ""}>Borrar</button>
      </article>
    `).join("");
  }

  function openAdminDeleteModal() {
    if (!isAdmin()) return;
    showPayView("inicio");
    state.adminDeleteOpen = true;
    state.adminDeleteMessage = "";
    $("payAdminDeleteBackdrop")?.classList.add("is-open");
    $("payAdminDeleteBackdrop")?.setAttribute("aria-hidden", "false");
    renderAdminDeleteModal();
    setAdminDeleteMessage(getDriverUid() ? `Chofer seleccionado: ${state.selectedDriverName || "sin nombre"}.` : "Seleccioná un chofer antes de borrar.", getDriverUid() ? "" : "error");
  }

  function closeAdminDeleteModal() {
    state.adminDeleteOpen = false;
    state.adminDeleteBusy = false;
    $("payAdminDeleteBackdrop")?.classList.remove("is-open");
    $("payAdminDeleteBackdrop")?.setAttribute("aria-hidden", "true");
  }

  function adminDeleteScrollTop() {
    const modal = document.querySelector(".pay-admin-delete-modal");
    try { modal?.scrollTo?.({ top:0, behavior:"smooth" }); } catch (_) { if (modal) modal.scrollTop = 0; }
  }

  function adminDeleteOwnerValues(row = {}) {
    return ["driverUid", "choferUid", "uid", "ownerUid", "driverId", "choferId", "userUid", "userId", "createdByUid", "ownerId", "conductorUid", "assignedDriverUid", "createdForUid", "profileId", "perfilId"]
      .map(field => safe(row[field])).filter(Boolean);
  }

  function adminDeleteMovementBelongsToSelected(row = {}, uid = getDriverUid(), documentId = "") {
    const target = safe(uid);
    const id = safe(documentId || row.id || row.recordId || row.expenseId || row.gastoId);
    if (!target || !id) return false;
    if (adminDeleteOwnerValues(row).includes(target)) return true;
    const loaded = [...(state.records || []), ...(state.expenses || [])].some(item => safe(item.id || item.recordId || item.expenseId || item.gastoId) === id);
    if (loaded) return true;
    const selectedName = safe(state.selectedDriverName || displayName()).toLowerCase();
    const rowName = safe(row.driverName || row.choferNombre || row.nombreChofer || row.conductorNombre || row.name || row.nombre).toLowerCase();
    return !!selectedName && !!rowName && selectedName === rowName;
  }

  function adminDeleteRemoveArrayItem(value, item) {
    const target = safe(item);
    return Array.isArray(value) ? value.map(safe).filter(v => v && v !== target) : [];
  }

  function adminDeleteExpenseParts(row = {}) {
    const amount = amountOf(row);
    const rawRate = Number(row.sharedRate ?? row.porcentajeCompartido ?? row.driverShareRate ?? row.porcentajeChofer);
    const rate = Number.isFinite(rawRate) ? (rawRate > 1 ? rawRate / 100 : rawRate) : .5;
    const driverPart = amount * Math.min(1, Math.max(0, rate || .5));
    const exploraPart = Math.max(0, amount - driverPart);
    return { amount, driverPart, exploraPart };
  }

  function adminDeleteBillingClosurePatch(closure = {}, movement = {}) {
    const amount = amountOf(movement);
    const method = methodOf(movement);
    const oldCash = moneyNumber(closure.cashInDriver ?? closure.cashGrossInDriver ?? closure.driverActualCash);
    const oldDigital = moneyNumber(closure.exploraCash ?? closure.nonCashInExplora ?? closure.nonCashGrossInExplora);
    const cash = Math.max(0, oldCash - (method === "cash" ? amount : 0));
    const digital = Math.max(0, oldDigital - (method === "cash" ? 0 : amount));
    const gross = Math.max(0, cash + digital);
    const share = gross * .5;
    const netToDriver = share - cash;
    return {
      gross, grossBeforeCashbox:gross, cashInDriver:cash, cashGrossInDriver:cash,
      exploraCash:digital, nonCashInExplora:digital, nonCashGrossInExplora:digital,
      billingShareEach:share, driverShare:share, exploraShare:share, driverEntitlement:share, driverFinal:share,
      netSettlementToDriver:netToDriver,
      amountDueFromDriver:Math.max(0, -netToDriver), amountFromDriver:Math.max(0, -netToDriver),
      amountDueToDriver:Math.max(0, netToDriver), amountToDriver:Math.max(0, netToDriver)
    };
  }

  function adminDeleteCashboxClosurePatch(closure = {}, movement = {}) {
    const amount = amountOf(movement);
    const reduction = amount * .05;
    const gross = Math.max(0, moneyNumber(closure.cashboxGross ?? closure.gross ?? closure.cashboxBase) - amount);
    const total = Math.max(0, moneyNumber(closure.cashboxTotal ?? closure.mainTotal ?? closure.amountDueFromDriver) - reduction);
    return {
      gross, cashboxGross:gross, mainTotal:total,
      cashboxTotal:total, cashboxInDriver:total, cashboxInExplora:0,
      amountDueFromDriver:total, amountFromDriver:total,
      amountDueToDriver:0, amountToDriver:0,
      netSettlementToDriver:-total
    };
  }

  function adminDeleteExpenseClosurePatch(closure = {}, movement = {}) {
    const { amount, driverPart, exploraPart } = adminDeleteExpenseParts(movement);
    const total = Math.max(0, moneyNumber(closure.expenseTotal ?? closure.mainTotal ?? closure.gross) - amount);
    const oldDriver = moneyNumber(closure.driverExpenseShare);
    const oldExplora = moneyNumber(closure.exploraExpenseShare ?? closure.amountDueToDriver);
    const newDriver = Math.max(0, oldDriver - driverPart);
    const newExplora = Math.max(0, oldExplora - exploraPart);
    return {
      expenseTotal:total, mainTotal:total, gross:total,
      driverExpenseShare:newDriver, exploraExpenseShare:newExplora,
      amountDueFromDriver:0, amountFromDriver:0,
      amountDueToDriver:newExplora, amountToDriver:newExplora,
      netSettlementToDriver:newExplora
    };
  }

  async function adminDeleteRelatedClosures(driverUid = "", documentId = "", includeField = "includedBillingIds") {
    const result = new Map();
    const col = collection(state.db, "cierres_semanales");
    try {
      const direct = await getDocs(query(col, where(includeField, "array-contains", documentId), limit(250)));
      direct.forEach(item => result.set(item.id, item));
    } catch (error) {
      console.warn("EXPLORA_ADMIN_DELETE_DIRECT_CLOSURE_INCLUDED_SKIP", includeField, error?.code || error?.message);
    }
    for (const field of ["driverUid", "choferUid", "uid", "driverId", "choferId"]) {
      try {
        const snap = await getDocs(query(col, where(field, "==", driverUid), limit(300)));
        snap.forEach(item => {
          const data = item.data() || {};
          if (Array.isArray(data[includeField]) && data[includeField].map(safe).includes(documentId)) result.set(item.id, item);
        });
      } catch (_) {}
    }
    return [...result.values()];
  }

  async function adminDeleteAdjustClosuresDirect({ type, driverUid, documentId, movement }) {
    const includeField = type === "gasto" ? "includedExpenseIds" : "includedBillingIds";
    const docs = await adminDeleteRelatedClosures(driverUid, documentId, includeField);
    let adjusted = 0;
    for (const snap of docs) {
      const closure = snap.data() || {};
      const kind = activeClosureKind(closure.closureKind || closure.closureType || closure.payTab || closure.closeKind || closure.kind || closure.cierreTipo || closure.type || closure.category);
      let patch = null;
      if (type === "gasto" && kind === "gastos") patch = adminDeleteExpenseClosurePatch(closure, movement);
      if (type === "cobro" && (kind === "chofer" || kind === "explora" || kind === "facturacion")) patch = adminDeleteBillingClosurePatch(closure, movement);
      if ((type === "cobro" || type === "caja_chica") && kind === "caja_chica" && methodOf(movement) === "cash") patch = adminDeleteCashboxClosurePatch(closure, movement);
      if (!patch) continue;
      await updateDoc(doc(state.db, "cierres_semanales", snap.id), {
        ...patch,
        [includeField]:adminDeleteRemoveArrayItem(closure[includeField], documentId),
        includedCount:Math.max(0, Number(closure.includedCount || 0) - 1),
        adminAdjusted:true,
        adminAdjustedReason:type === "caja_chica" ? "Caja chica excluida manualmente" : "Movimiento eliminado manualmente",
        adminAdjustedAt:serverTimestamp(),
        adminAdjustedAtMs:Date.now(),
        adminAdjustedByUid:safe(state.user?.uid || window.ExploraSession?.authUser?.uid),
        updatedAt:serverTimestamp(),
        updatedAtMs:Date.now(),
        version:VERSION
      });
      adjusted += 1;
    }
    return adjusted;
  }

  async function adminDeleteFinancialDirect({ type = "", documentId = "", driverUid = "" } = {}) {
    if (!state.db) throw new Error("Firestore no está disponible.");
    const collectionName = type === "gasto" ? "gastos" : "billing_records";
    const movementRef = doc(state.db, collectionName, documentId);
    const snap = await getDoc(movementRef);
    if (!snap.exists()) throw new Error("El movimiento ya no existe en Firestore.");
    const movement = { id:snap.id, ...snap.data() };
    if (!adminDeleteMovementBelongsToSelected(movement, driverUid, documentId)) throw new Error("El movimiento no pertenece al chofer seleccionado.");
    if (type === "caja_chica" && methodOf(movement) !== "cash") throw new Error("Solo los cobros en efectivo generan caja chica.");
    const closuresAdjusted = await adminDeleteAdjustClosuresDirect({ type, driverUid, documentId, movement });
    if (type === "caja_chica") {
      await updateDoc(movementRef, {
        excludeFromCashbox:true,
        cashboxExcluded:true,
        cajaChicaEliminada:true,
        cajaChicaEliminadaAt:serverTimestamp(),
        cajaChicaEliminadaAtMs:Date.now(),
        cajaChicaEliminadaByUid:safe(state.user?.uid || window.ExploraSession?.authUser?.uid),
        cajaChicaEliminadaReason:"Borrado manual desde panel administrador",
        updatedAt:serverTimestamp(),
        updatedAtMs:Date.now(),
        updatedByUid:safe(state.user?.uid || window.ExploraSession?.authUser?.uid)
      });
    } else {
      await deleteDoc(movementRef);
    }
    return { ok:true, direct:true, closuresAdjusted };
  }

  function adminDeleteCallableShouldFallback(error) {
    const code = safe(error?.code || error?.details?.code).toLowerCase();
    const message = safe(error?.message).toLowerCase();
    return !code || code.includes("not-found") || code.includes("unavailable") || code.includes("deadline") || code.includes("internal") || code.includes("functions") || message.includes("not found") || message.includes("no está disponible") || message.includes("deadline") || message.includes("network");
  }

  function adminDeleteCanTryServerAfterDirect(error) {
    const code = safe(error?.code).toLowerCase();
    const message = safe(error?.message).toLowerCase();
    return code.includes("permission") || code.includes("denied") || message.includes("permission") || message.includes("permisos") || message.includes("insufficient");
  }

  async function adminDeleteCallServerOrDirect(payload) {
    try {
      return await adminDeleteFinancialDirect(payload);
    } catch (directError) {
      const fb = window.ExploraFirebase || {};
      if (!fb.functions || !fb.httpsCallable || !adminDeleteCanTryServerAfterDirect(directError)) throw directError;
      console.warn("EXPLORA_ADMIN_DELETE_DIRECT_FALLBACK_TO_CALLABLE", directError?.code || directError?.message || directError);
      const callable = fb.httpsCallable(fb.functions, "adminDeleteFinancialMovement", { timeout: 30000 });
      const response = await callable({ ...payload, reason:"Borrado manual desde panel administrador" });
      return { ...(response?.data || {}), direct:false };
    }
  }

  async function submitAdminDeleteMovement(documentId = "", type = "", sourceButton = null) {
    if (!isAdmin()) throw new Error("Solo el administrador puede borrar movimientos.");
    const uid = getDriverUid();
    if (!uid) throw new Error("Seleccioná un chofer antes de borrar.");
    const cleanType = safe(type);
    const cleanId = safe(documentId);
    if (!cleanId) throw new Error("No se encontró el ID del movimiento.");
    const label = cleanType === "caja_chica" ? "la caja chica" : cleanType === "gasto" ? "el gasto" : "el cobro";
    const ok = window.confirm(`¿Borrar ${label}?\n\nEsta acción modifica Firestore y recalcula los cierres relacionados.`);
    if (!ok) return;
    state.adminDeleteBusy = true;
    state.adminDeleteBusyKey = `${cleanType}:${cleanId}`;
    if (sourceButton) {
      sourceButton.disabled = true;
      sourceButton.textContent = "Borrando…";
    }
    setAdminDeleteMessage("Borrando y ajustando cierre… No cierres esta pantalla.");
    adminDeleteScrollTop();
    renderAdminDeleteModal();
    try {
      const result = await adminDeleteCallServerOrDirect({ type:cleanType, documentId:cleanId, driverUid:uid });
      await refreshOpenData("admin-delete-financial-movement");
      setAdminDeleteMessage(`Listo. Movimiento borrado. Cierres ajustados: ${number(result.closuresAdjusted || 0)}${result.direct ? " · modo Firestore directo" : ""}.`, "ok");
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(35);
      renderAdminDeleteModal();
      adminDeleteScrollTop();
    } catch (error) {
      const msg = error?.message || "No se pudo borrar el movimiento.";
      setAdminDeleteMessage(msg, "error");
      adminDeleteScrollTop();
      window.alert(msg);
      throw error;
    } finally {
      state.adminDeleteBusy = false;
      state.adminDeleteBusyKey = "";
      renderAdminDeleteModal();
    }
  }

  function renderMoreScreen() {
    const name = isAdmin() ? accountName() : displayName();
    const roleLabel = isAdmin() ? "Administrador" : "Chofer";
    const subtitle = $("payMoreSubtitle");
    const moreName = $("payMoreName");
    const moreRole = $("payMoreRole");
    if (subtitle) subtitle.textContent = isAdmin() ? "Panel blanco de accesos rápidos administrativos." : "Accesos rápidos de tu cuenta Explora.";
    if (moreName) moreName.textContent = name;
    if (moreRole) moreRole.textContent = roleLabel;
    const list = $("payMoreList");
    if (list) list.innerHTML = moreItems().map(item => `
      <button class="pay-more-row" data-pay-more-action="${esc(item.action)}" type="button">
        <span class="pay-more-row-icon">${moreIcon(item.icon)}</span>
        <span class="pay-more-row-copy"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></span>
        <span class="pay-more-chevron">›</span>
      </button>
    `).join("");
    const adminList = $("payMoreAdminList");
    if (adminList) {
      adminList.hidden = !isAdmin();
      adminList.innerHTML = !isAdmin() ? "" : `<div class="pay-more-card-title">Administración</div>` + adminMoreItems().map(item => `
        <button class="pay-more-row" data-pay-more-action="${esc(item.action)}" type="button">
          <span class="pay-more-row-icon">${moreIcon(item.icon)}</span>
          <span class="pay-more-row-copy"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></span>
          <span class="pay-more-chevron">›</span>
        </button>
      `).join("");
    }
  }

  function renderAdminDriverPicker() {
    const picker = $("payAdminDriverPicker");
    const select = $("payAdminDriverSelect");
    const typeSelect = $("payAdminTypeSelect");
    const hint = $("payAdminDriverHint");
    if (!picker || !select) return;
    picker.hidden = !isAdmin();
    if (!isAdmin()) return;
    const current = safe(state.selectedDriverUid);
    const options = [`<option value="">Todos los choferes</option>`].concat(state.drivers.map(driver => `<option value="${esc(driver.uid)}">${esc(driver.name)}</option>`));
    select.innerHTML = options.join("");
    select.value = current;
    if (typeSelect) {
      typeSelect.innerHTML = ADMIN_ACTIVITY_TYPES.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
      typeSelect.value = safe(state.adminActivityType);
    }
    const typeLabel = ADMIN_ACTIVITY_TYPES.find(([value]) => value === safe(state.adminActivityType))?.[1] || "Todos los tipos";
    if (hint) hint.textContent = current
      ? `Vista admin: ${state.selectedDriverName || "chofer seleccionado"} · ${typeLabel}.`
      : `Vista admin: todos los choferes · ${typeLabel}.`;
  }

  function selectAdminActivityType(value = "") {
    const next = safe(value);
    state.adminActivityType = ADMIN_ACTIVITY_TYPES.some(([key]) => key === next) ? next : "";
    render();
  }

  function selectAdminDriver(uid = "") {
    const nextUid = safe(uid);
    const driver = state.drivers.find(item => item.uid === nextUid);
    state.selectedDriverUid = nextUid;
    state.selectedDriverName = driver?.name || "";
    state.records = [];
    state.expenses = [];
    state.closures = [];
    state.debts = [];
    state.debtPayments = [];
    state.pendingClosure = null;
    state.previousDetailsOpen = { chofer:false, explora:false, gastos:false, caja_chica:false, pendientes:false };
    resetTabAlertScope();
    render();
    startRealtime("admin-driver-selected");
  }

  function logoutFromMore() {
    if (window.ExploraActions?.salir) { window.ExploraActions.salir(); return; }
    const explicit = $("exploraRoleLogout");
    if (explicit) { explicit.click(); return; }
    const oldLogout = Array.from(document.querySelectorAll('[data-action="salir"], .logout-pill-real')).find(el => !el.closest("#payMoreScreen"));
    if (oldLogout) oldLogout.click();
  }

  async function fetchDrivers() {
    if (!state.db) return [];
    const collections = ["choferes", "usuarios"];
    const map = new Map();
    for (const name of collections) {
      try {
        const snap = await getDocs(query(collection(state.db, name), limit(300)));
        snap.forEach(item => {
          const data = item.data() || {};
          const role = driverRole(data);
          const uid = safe(data.uid || data.authUid || data.driverUid || data.choferUid || data.userId || item.id);
          const driverName = safe(data.nombre || data.nombreCompleto || data.displayName || data.name);
          if (!uid || EXPLORA_ADMIN_UIDS.has(uid) || EXPLORA_ADMIN_UIDS.has(item.id)) return;
          if (role !== "chofer") return;
          if (!driverIsActive(data)) return;
          if (!driverName) return;
          map.set(uid, { uid, id:item.id, collection:name, name:driverName, role, profile:data });
        });
      } catch (error) { console.warn("EXPLORA_PAY_DRIVERS_READ", name, error?.code || error?.message); }
    }
    state.drivers = Array.from(map.values()).sort((a,b)=>a.name.localeCompare(b.name, "es"));
    return state.drivers;
  }

  function scopedQuery(collectionName, uid, max = 180) {
    const col = collection(state.db, collectionName);
    if (isAdmin() && !uid) return query(col, limit(max));
    return query(col, where("driverUid", "==", uid || getDriverUid()));
  }

  async function getGlobalDocs(collectionName, max = 300) {
    try {
      const snap = await getDocs(query(collection(state.db, collectionName), limit(max)));
      return snap.docs.map(item => ({ id:item.id, ...item.data() }));
    } catch (error) {
      console.warn("EXPLORA_PAY_GLOBAL_READ", collectionName, error?.code || error?.message);
      return [];
    }
  }

  async function getScopedDocs(collectionName, uid) {
    const fields = ["driverUid", "choferUid", "uid", "ownerUid", "driverId", "choferId", "driver_id", "chofer_id", "userUid", "userId", "createdByUid", "ownerId", "conductorUid", "conductorId", "assignedDriverUid"];
    const map = new Map();
    for (const field of fields) {
      try {
        const snap = await getDocs(query(collection(state.db, collectionName), where(field, "==", uid), limit(250)));
        snap.forEach(docSnap => map.set(docSnap.id, { id:docSnap.id, ...docSnap.data() }));
      } catch (_) {}
    }
    return Array.from(map.values());
  }

  function listenCollection(collectionName, targetArray, uid) {
    try {
      const targetUid = safe(uid || getDriverUid());
      if (!targetUid) {
        return onSnapshot(scopedQuery(collectionName, targetUid), snap => {
          state[targetArray] = snap.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b)=>rowMs(b)-rowMs(a));
          if (["billing_records", "gastos", "deudas_choferes", "deuda_pagos"].includes(collectionName)) registerTabAlertMovements(collectionName, state[targetArray]);
          render();
        }, error => {
          console.warn(`EXPLORA_PAY_LISTENER_${collectionName}`, error?.code || error?.message);
        });
      }
      const fields = ["driverUid", "choferUid", "uid", "ownerUid", "driverId", "choferId", "driver_id", "chofer_id", "userUid", "userId", "createdByUid", "ownerId", "conductorUid", "conductorId", "assignedDriverUid"];
      const snapshots = new Map();
      const publish = () => {
        const merged = new Map();
        for (const docs of snapshots.values()) {
          for (const item of docs) merged.set(item.id, item);
        }
        state[targetArray] = Array.from(merged.values()).sort((a,b)=>rowMs(b)-rowMs(a));
        if (["billing_records", "gastos", "deudas_choferes", "deuda_pagos"].includes(collectionName)) registerTabAlertMovements(collectionName, state[targetArray]);
        render();
      };
      const unsubs = fields.map(field => {
        try {
          return onSnapshot(query(collection(state.db, collectionName), where(field, "==", targetUid), limit(250)), snap => {
            snapshots.set(field, snap.docs.map(d => ({ id:d.id, ...d.data() })));
            publish();
          }, error => {
            console.warn(`EXPLORA_PAY_LISTENER_${collectionName}_${field}`, error?.code || error?.message);
          });
        } catch (error) {
          console.warn(`EXPLORA_PAY_LISTENER_SETUP_${collectionName}_${field}`, error?.code || error?.message);
          return null;
        }
      }).filter(Boolean);
      return () => unsubs.forEach(unsub => { try { unsub?.(); } catch (_) {} });
    } catch (error) {
      console.warn(`EXPLORA_PAY_LISTENER_SETUP_${collectionName}`, error?.code || error?.message);
      return null;
    }
  }

  function startRealtime(reason = "start") {
    if (!state.db || !state.user) return;
    clearListeners();
    const uid = getDriverUid();
    if (isAdmin()) {
      fetchDrivers().then(() => {
        if (state.selectedDriverUid && !state.drivers.some(driver => driver.uid === state.selectedDriverUid)) {
          state.selectedDriverUid = "";
          state.selectedDriverName = "";
        }
        render();
      }).catch(()=>{});
      if (!uid) {
        state.pendingClosure = null;
        const unsubs = [
          listenCollection("billing_records", "records", ""),
          listenCollection("gastos", "expenses", ""),
          listenCollection("cierres_semanales", "closures", ""),
          listenCollection("deudas_choferes", "debts", ""),
          listenCollection("deuda_pagos", "debtPayments", "")
        ].filter(Boolean);
        state.unsubscribers.push(...unsubs);
        render();
        console.info("EXPLORA_PAY_REALTIME", VERSION, reason, "admin-global-activity");
        return;
      }
    }
    const unsubs = [
      listenCollection("billing_records", "records", uid),
      listenCollection("gastos", "expenses", uid),
      listenCollection("cierres_semanales", "closures", uid),
      listenCollection("deudas_choferes", "debts", uid),
      listenCollection("deuda_pagos", "debtPayments", uid)
    ].filter(Boolean);
    state.unsubscribers.push(...unsubs);
    console.info("EXPLORA_PAY_REALTIME", VERSION, reason, uid || "no-driver");
  }

  function closureCutMs(row = {}) {
    // El corte operativo queda fijado cuando se pide el cierre.
    // Subir el comprobante cierra el trámite, pero NO debe mover el corte ni borrar movimientos cargados después.
    const explicitCutoff = Number(row.cutoffAtMs || 0) || ms(row.cutoffAt);
    if (explicitCutoff > 0) return explicitCutoff;
    const requestedCutoff = Number(row.requestedAtMs || 0) || ms(row.requestedAt) || Number(row.createdAtMs || 0) || ms(row.createdAt);
    if (requestedCutoff > 0) return requestedCutoff;
    return Math.max(
      Number(row.driverUploadedAtMs || 0), Number(row.adminUploadedAtMs || 0), Number(row.receiptUploadedAtMs || 0),
      Number(row.confirmedAtMs || 0), Number(row.closedAtMs || 0),
      ms(row.driverUploadedAt), ms(row.adminUploadedAt), ms(row.receiptUploadedAt), ms(row.confirmedAt), ms(row.closedAt), rowMs(row)
    );
  }

  function lastClosureMs(rows, kind = state.tab) {
    const target = activeClosureKind(kind);
    if (!target) return 0;
    const cuts = rows
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => {
        const rowKind = closureKindOf(row);
        if (target === "caja_chica") return rowKind === "caja_chica";
        if (target === "gastos") return rowKind === "gastos";
        // Un cierre pedido desde Chofer o desde Explora corta TODO el período de facturación.
        // Por eso ambos contadores usan el mismo corte: efectivo del chofer + digital de Explora.
        if (isBillingClosureKind(target)) return isBillingClosureKind(rowKind);
        return rowKind === target;
      })
      .filter(row => !/cancelled|canceled|anulado|rechazado/i.test(safe(row.status || row.estado)))
      .map(closureCutMs)
      .filter(Boolean)
      .sort((a,b)=>b-a);
    return cuts[0] || 0;
  }

  function lastBillingClosureMs(rows = []) {
    return lastClosureMs(rows, "facturacion");
  }

  function pendingClosureFor(uid = getDriverUid(), kind = state.tab) {
    const targetUid = safe(uid);
    const target = activeClosureKind(kind);
    if (!target) return null;
    if (isAdmin() && !targetUid) return null;
    const pending = state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => {
        const rowKind = closureKindOf(row);
        if (target === "caja_chica") return rowKind === "caja_chica";
        if (target === "gastos") return rowKind === "gastos";
        if (isBillingClosureKind(target)) return isBillingClosureKind(rowKind);
        return rowKind === target;
      })
      .filter(row => !targetUid || closureBelongsToDriver(row, targetUid))
      .filter(row => !/confirmed|completed|closed|cerrado|al_dia|al día|pagado|cancelled|canceled|anulado|rechazado/i.test(safe(row.status || row.estado)))
      .sort((a,b)=>rowMs(b)-rowMs(a));
    return pending[0] || null;
  }

  function pendingClosureRows(uid = notificationDriverUid()) {
    const targetUid = safe(uid);
    const rows = state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => !/confirmed|completed|closed|cerrado|al_dia|al día|pagado|cancelled|canceled|anulado|rechazado/i.test(safe(row.status || row.estado)))
      .filter(row => targetUid ? closureBelongsToDriver(row, targetUid) : isAdmin())
      .filter(row => closureActionForViewer(row) !== "none")
      .sort((a,b)=>rowMs(b)-rowMs(a));
    const unique = new Map();
    for (const row of rows) unique.set(safe(row.id || `${closureHomeModuleOf(row) || closureKindOf(row)}_${rowMs(row)}`), row);
    return Array.from(unique.values());
  }

  function pendingHomeClosureFor(uid = getDriverUid(), kind = state.tab) {
    const targetUid = safe(uid);
    if (isAdmin() && !targetUid) return null;
    return state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => !/confirmed|completed|closed|cerrado|al_dia|al día|pagado|cancelled|canceled|anulado|rechazado/i.test(safe(row.status || row.estado)))
      .filter(row => closureMatchesHomeModule(row, kind))
      .filter(row => !targetUid || closureBelongsToDriver(row, targetUid))
      .filter(row => closureActionForViewer(row) !== "none")
      .sort((a,b)=>rowMs(b)-rowMs(a))[0] || null;
  }

  function closureResultText(closure = {}) {
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    const kind = activeClosureKind(closureKindOf(closure));
    if (due > 0) return `Chofer debe liquidar a Explora ${currency(due)}`;
    if (toDriver > 0) return `Explora debe liquidar a chofer ${currency(toDriver)}`;
    return "Nadie debe liquidar";
  }

  function closureTimeLabel(row = {}) {
    const at = rowMs(row) || Date.now();
    const now = Date.now();
    const sameDay = new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit", year:"numeric" }).format(at) === new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit", year:"numeric" }).format(now);
    if (sameDay) return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, hour:"2-digit", minute:"2-digit" }).format(at);
    return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit" }).format(at);
  }


  function closureHasProof(closure = {}) {
    return !!safe(closure.receiptUrl || closure.driverReceiptUrl || closure.adminReceiptUrl || closure.davidReceiptUrl || closure.comprobanteUrl || closure.receiptPath || closure.driverReceiptPath || closure.adminReceiptPath);
  }

  function closureProofUrl(closure = {}) {
    return safe(closure.receiptUrl || closure.driverReceiptUrl || closure.adminReceiptUrl || closure.davidReceiptUrl || closure.comprobanteUrl || "");
  }

  function closureStatusText(closure = {}) {
    const status = safe(closure.status || closure.estado || closure.statusLabel).toLowerCase();
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    const proof = closureHasProof(closure);
    if (/confirmed|confirmado|completed|closed|cerrado|al_dia|al día|pagado/.test(status)) return "Cierre completo";
    if (due > 0 && proof) return "El chofer ya liquidó, chequea el comprobante en tus notificaciones.";
    if (toDriver > 0 && proof) return "Explora ya liquidó, chequea el comprobante en tus notificaciones.";
    if (due > 0) return "Falta que el chofer liquide y envíe comprobante";
    if (toDriver > 0) return "Falta que Explora liquide y envíe comprobante";
    return "Cierre solicitado";
  }

  function closureIsCompleted(closure = {}) {
    const status = safe(closure.status || closure.estado || closure.statusLabel).toLowerCase();
    return /confirmed|confirmado|completed|closed|cerrado|al_dia|al día|pagado/.test(status);
  }

  function closureActivityStateText(closure = {}) {
    return closureIsCompleted(closure) ? "CERRADO" : "ABIERTO";
  }

  function closureActivityMeta(closure = {}) {
    const stateText = closureActivityStateText(closure);
    const statusText = closureStatusText(closure);
    return stateText === "CERRADO" ? "CERRADO · Cierre completo" : `ABIERTO · ${statusText}`;
  }

  function closurePayerClass(closure = {}) {
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    if (due > 0) return "is-paid-by-driver";
    if (toDriver > 0) return "is-paid-by-explora";
    return "is-balanced-closure";
  }

  function closureActionForViewer(closure = {}) {
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const proof = closureHasProof(closure);
    if (closureIsCompleted(closure)) return "none";
    if (!isAdmin() && closureNeedsDriverKm(closure)) return "driver_km";
    if (isAdmin()) {
      const targetUid = notificationDriverUid();
      if (targetUid && !closureBelongsToDriver(closure, targetUid)) return "none";
      if (toDriver > 0 && !proof) return "admin_upload";
      if (due > 0 && proof) return "admin_review";
      if (due > 0 && !proof) return "admin_waiting_driver";
      return "view";
    }
    const driverUid = getOwnDriverUid();
    if (!driverUid || !closureBelongsToDriver(closure, driverUid)) return "none";
    if (due > 0 && !proof) return "driver_upload";
    if (toDriver > 0 && proof) return "driver_review";
    if (toDriver > 0 && !proof) return "driver_waiting_admin";
    return "view";
  }

  function closureYellowBannerMessage(closure = {}) {
    if (!closure || closureIsCompleted(closure)) return null;
    const action = closureActionForViewer(closure);
    if (action === "none" || action === "view") return null;
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    const proof = closureHasProof(closure);
    if (toDriver > 0) {
      return proof
        ? "Explora ya liquidó, chequea el comprobante en tus notificaciones."
        : "Falta que Explora liquide y envíe comprobante";
    }
    if (due > 0) {
      return proof
        ? "El chofer ya liquidó, chequea el comprobante en tus notificaciones."
        : "Falta que el chofer liquide y envíe comprobante";
    }
    return null;
  }

  function homePendingClosureCardData(closure = {}, kind = state.tab, uid = getDriverUid()) {
    const target = activeClosureKind(kind);
    const targetUid = safe(uid);
    if (!closure || !["caja_chica", "gastos", "explora", "chofer"].includes(target)) return null;
    if (isAdmin() && !targetUid) return null;
    if (closureIsCompleted(closure)) return null;
    if (safe(closure.closureMode || closure.periodType) !== "on_demand") return null;
    if (!closureMatchesHomeModule(closure, target)) return null;
    if (targetUid && !closureBelongsToDriver(closure, targetUid)) return null;
    const action = closureActionForViewer(closure);
    if (!action || action === "none" || action === "view") return null;
    const message = safe(closureYellowBannerMessage(closure));
    if (!message) return null;
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    const amount = Math.max(due, toDriver);
    const title = `${closureTitle(closureHomeModuleOf(closure) || closureKindOf(closure))}${amount > 0 ? ` · ${currency(amount)}` : ""}`;
    if (!safe(title)) return null;
    return { closure, message, title, action, amount };
  }


  function parseKmValue(raw) {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    const text = safe(raw);
    if (!text) return 0;
    const digits = text.replace(/[^0-9]/g, "");
    const parsed = Number(digits || text.replace(/[^0-9.,-]/g, "").replace(/,/g, "."));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function kmNumberFrom(row = {}, fields = []) {
    for (const field of fields) {
      const raw = row?.[field];
      if (raw === null || raw === undefined || raw === "") continue;
      const parsed = parseKmValue(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return 0;
  }

  const KM_INITIAL_FIELDS = ["kmInicialPeriodo", "kmInicioPeriodo", "kmInicial", "kmInicio", "currentEfficiencyPeriodStartKm", "efficiencyPeriodStartKm", "odometerStart", "mileageStart", "initialKm", "startKm", "kilometrajeInicial"];
  const KM_CURRENT_FIELDS = ["kmActual", "kmActualDeclarado", "kmActualPeriodo", "kilometrajeActual", "kmDeclarado", "lastKnownKm", "odometer", "odometerKm", "mileageCurrent", "currentKm", "lastKm", "ultimoKm", "kmFinal", "kmFinalPeriodo", "kilometrajeFinal"];
  const KM_FINAL_FIELDS = ["kmFinalPeriodo", "kmFinal", "kmActual", "kmActualDeclarado", "kmActualCierre", "kilometrajeActual", "kmDeclarado", "lastKnownKm", "odometer", "odometerKm", "mileageFinal", "finalKm", "currentKm"];

  function validBillingClosuresFor(uid = "", rows = state.closures) {
    const targetUid = safe(uid);
    return (rows || [])
      .filter(row => {
        const mode = safe(row.closureMode || row.periodType).toLowerCase();
        return mode === "on_demand" || row.billingClosure === true || isBillingClosureKind(closureKindOf(row));
      })
      .filter(row => row.billingClosure === true || isBillingClosureKind(closureKindOf(row)))
      .filter(row => !targetUid || closureBelongsToDriver(row, targetUid))
      .filter(row => !/cancelled|canceled|anulado|rechazado/i.test(safe(row.status || row.estado)))
      .sort((a,b)=>closureCutMs(b)-closureCutMs(a) || rowMs(b)-rowMs(a));
  }

  function latestBillingClosureFor(uid = "", rows = state.closures, beforeMs = 0) {
    return validBillingClosuresFor(uid, rows)
      .filter(row => !beforeMs || closureCutMs(row) < beforeMs)
      [0] || null;
  }

  function kmFinalSeedFromClosure(row = {}) {
    return kmNumberFrom(row || {}, KM_FINAL_FIELDS.concat(["efficiencyNextKmInitial", "kmInicialNuevoPeriodo", "nextKmInitial", "proximoKmInicial", "ultimoKmCierre"]));
  }

  function latestBillingClosureWithKmFinal(uid = "", rows = state.closures, beforeMs = 0) {
    return validBillingClosuresFor(uid, rows)
      .filter(row => !beforeMs || closureCutMs(row) < beforeMs)
      .filter(row => kmFinalSeedFromClosure(row) > 0)
      [0] || null;
  }

  function profileKmSeed(profile = {}) {
    return kmNumberFrom(profile || {}, KM_INITIAL_FIELDS.concat(KM_CURRENT_FIELDS).concat(["lastKnownKm", "ultimoKmCierre", "kmInicialNuevoPeriodo", "efficiencyNextKmInitial"]));
  }

  function hasKmInitialSeedForDriver(uid = getDriverUid(), closures = state.closures, profile = driverProfileForEfficiency(uid)) {
    const targetUid = safe(uid);
    if (kmFinalSeedFromClosure(latestBillingClosureWithKmFinal(targetUid, closures)) > 0) return true;
    return profileKmSeed(profile || {}) > 0;
  }

  function kmInitialForOpenPeriod(uid = getDriverUid(), closures = state.closures, profile = state.profile) {
    // Regla clave: el KM final del último cierre válido pasa automáticamente a ser
    // el KM inicial del período nuevo. Por eso el botón "Cargar KM inicial" solo
    // debe aparecer cuando el chofer nunca cargó ningún KM.
    const targetUid = safe(uid);
    const latestWithKm = latestBillingClosureWithKmFinal(targetUid, closures);
    const fromClosure = kmFinalSeedFromClosure(latestWithKm);
    if (fromClosure > 0) return fromClosure;
    return profileKmSeed(profile || {});
  }

  function kmInitialForClosure(closure = {}) {
    const uid = safe(closure.driverUid || closure.choferUid || closure.uid || getDriverUid());
    const cut = closureCutMs(closure) || Date.now();
    const previousWithKm = latestBillingClosureWithKmFinal(uid, state.closures, cut);
    const fromPrevious = kmFinalSeedFromClosure(previousWithKm);
    if (fromPrevious > 0) return fromPrevious;
    const driverProfile = (state.drivers.find(driver => driver.uid === uid)?.profile) || (uid === getOwnDriverUid() ? state.profile : {});
    return profileKmSeed(driverProfile || {});
  }

  function closureNeedsDriverKm(closure = {}) {
    if (!closure || closureIsCompleted(closure)) return false;
    if (!isBillingClosureKind(closureKindOf(closure))) return false;
    const requestedByRole = safe(closure.requestedByRole || closure.solicitadoPorRol || closure.requestedRole).toLowerCase();
    const explicitlyPending = closure.kmPendienteChofer === true || closure.eficienciaPendienteDatos === true || /pendiente.*km|km.*pendiente/i.test(safe(closure.statusLabel || closure.estado || closure.status));
    const hasFinal = kmNumberFrom(closure, KM_FINAL_FIELDS.concat(["kmRecorridos"]));
    return requestedByRole !== "driver" && (explicitlyPending || !hasFinal);
  }

  function driverProfileForEfficiency(uid = getDriverUid()) {
    const targetUid = safe(uid);
    if (!targetUid || targetUid === getOwnDriverUid()) return state.profile || {};
    return state.drivers.find(driver => driver.uid === targetUid)?.profile || {};
  }

  function currentKmForEfficiency(uid = getDriverUid(), records = state.records, profile = driverProfileForEfficiency(uid), kmInicial = 0) {
    const initial = Number(kmInicial || 0);
    const values = [kmNumberFrom(profile || {}, KM_CURRENT_FIELDS)]
      .concat((records || []).map(row => kmNumberFrom(row, KM_CURRENT_FIELDS)))
      .filter(value => value > 0)
      .sort((a,b)=>b-a);
    const current = values[0] || 0;
    // El último KM final guardado en un cierre pasa a ser el KM inicial del período abierto.
    // No debe interpretarse como "KM actual" ni disparar un formulario manual al abrir eficiencia.
    if (initial > 0 && current <= initial) return 0;
    return current;
  }

  function lastKnownKmForValidation(uid = getDriverUid()) {
    const targetUid = safe(uid);
    const profile = driverProfileForEfficiency(targetUid);
    const fromProfile = kmNumberFrom(profile || {}, KM_CURRENT_FIELDS.concat(["lastKnownKm", "currentEfficiencyPeriodStartKm"]));
    const fromClosure = kmNumberFrom(latestBillingClosureFor(targetUid, state.closures) || {}, KM_FINAL_FIELDS.concat(["kmInicialNuevoPeriodo", "efficiencyNextKmInitial"]));
    return Math.max(fromProfile || 0, fromClosure || 0);
  }

  function updateLocalDriverKmState(uid = getDriverUid(), fields = {}) {
    const targetUid = safe(uid);
    if (!targetUid) return;
    if (targetUid === getOwnDriverUid()) state.profile = { ...(state.profile || {}), ...fields };
    const driver = state.drivers.find(item => item.uid === targetUid);
    if (driver) driver.profile = { ...(driver.profile || {}), ...fields };
  }

  function driverDocCandidates(uid = getDriverUid()) {
    const targetUid = safe(uid);
    const candidates = [];
    const add = (collectionName, id) => {
      const docId = safe(id);
      if (!collectionName || !docId) return;
      const key = `${collectionName}/${docId}`;
      if (!candidates.some(item => item.key === key)) candidates.push({ key, collectionName, id:docId });
    };
    const driver = state.drivers.find(item => item.uid === targetUid);
    if (driver?.collection && driver?.id) add(driver.collection, driver.id);
    if (driver?.id) { add("choferes", driver.id); add("usuarios", driver.id); }
    if (targetUid === getOwnDriverUid() && state.profileDocumentId) { add("choferes", state.profileDocumentId); add("usuarios", state.profileDocumentId); }
    add("choferes", targetUid);
    add("usuarios", targetUid);
    return candidates;
  }


  function firstProfileValue(profile = {}, fields = []) {
    for (const field of fields) {
      const value = profile?.[field];
      if (value === null || value === undefined || value === "") continue;
      if (typeof value === "object") continue;
      const text = safe(value);
      if (text) return text;
    }
    return "";
  }

  function driverFullNameFromProfile(profile = state.profile) {
    return firstProfileValue(profile, ["nombreCompleto", "fullName", "nombre", "displayName", "name", "email"]) || displayName();
  }

  function driverCarLabel(profile = state.profile) {
    const model = firstProfileValue(profile, ["autoModelo", "modeloAuto", "vehicleModel", "carModel", "modelo", "auto", "vehiculo", "rodado"])
      || safe(profile?.auto?.modelo || profile?.vehiculo?.modelo || profile?.car?.model);
    const plate = firstProfileValue(profile, ["patente", "plate", "dominio", "licensePlate", "autoPatente", "vehiclePlate"])
      || safe(profile?.auto?.patente || profile?.vehiculo?.patente || profile?.car?.plate);
    const label = [model, plate].filter(Boolean).join(" · ");
    return label || "Sin auto asignado";
  }

  function driverPaymentProfile(profile = state.profile) {
    return {
      fullName:driverFullNameFromProfile(profile),
      car:driverCarLabel(profile),
      phone:firstProfileValue(profile, ["telefono", "teléfono", "phone", "celular", "mobile", "whatsapp", "numeroTelefono", "numeroDeTelefono"]),
      cuit:firstProfileValue(profile, ["cuit", "CUIT", "cuil", "taxId", "dniFiscal"]),
      alias:firstProfileValue(profile, ["aliasCobro", "paymentAlias", "aliasParaCobrar", "alias", "mercadoPagoAlias", "aliasMp", "mpAlias"])
    };
  }

  function driverPaymentProfileForUid(uid = getDriverUid()) {
    const targetUid = safe(uid);
    const profile = targetUid && targetUid !== getOwnDriverUid()
      ? (state.drivers.find(driver => driver.uid === targetUid)?.profile || {})
      : (state.profile || {});
    return driverPaymentProfile(profile);
  }

  function paymentProfileMissingFields(data = driverPaymentProfile()) {
    const missing = [];
    if (!safe(data.phone)) missing.push("número de teléfono");
    if (!safe(data.cuit)) missing.push("CUIT");
    if (!safe(data.alias)) missing.push("alias para cobrar");
    return missing;
  }

  function requireOwnPaymentProfileComplete() {
    if (isAdmin()) return;
    const payment = driverPaymentProfile(state.profile || {});
    const missing = paymentProfileMissingFields(payment);
    if (missing.length) throw new Error(`Completá Mi perfil antes de pedir el cierre: ${missing.join(", ")}.`);
  }

  function closureAmountLine(summary = {}) {
    const fromDriver = number(summary.amountFromDriver || summary.amountDueFromDriver || 0);
    const toDriver = number(summary.amountToDriver || summary.amountDueToDriver || 0);
    if (toDriver > 0) return { direction:"explora_to_driver", label:"Explora debe liquidar al chofer", amount:toDriver };
    if (fromDriver > 0) return { direction:"driver_to_explora", label:"Chofer debe liquidar a Explora", amount:fromDriver };
    return { direction:"balanced", label:"Nadie debe liquidar", amount:0 };
  }

  function closurePaymentRowsHtml({ driverPayment = {}, direction = "balanced" } = {}) {
    if (direction === "explora_to_driver") {
      return [
        ["Alias chofer", driverPayment.alias || "Sin cargar"],
        ["CUIT chofer", driverPayment.cuit || "Sin cargar"],
        ["Teléfono chofer", driverPayment.phone || "Sin cargar"]
      ].map(([label,value]) => `<article class="pay-payment-info-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("");
    }
    if (direction === "driver_to_explora") {
      return [
        ["Alias Explora", EXPLORA_ALIAS],
        ["CUIT David", EXPLORA_CUIT],
        ["WhatsApp Explora", EXPLORA_WHATSAPP_DISPLAY]
      ].map(([label,value]) => `<article class="pay-payment-info-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("");
    }
    return "";
  }

  function closurePaymentDataForPayload(targetUid = getDriverUid(), summary = {}) {
    const driverPayment = driverPaymentProfileForUid(targetUid);
    const result = closureAmountLine(summary);
    return {
      driverPaymentPhone:safe(driverPayment.phone),
      driverPaymentCuit:safe(driverPayment.cuit),
      driverPaymentAlias:safe(driverPayment.alias),
      exploraPaymentAlias:EXPLORA_ALIAS,
      exploraPaymentCuit:EXPLORA_CUIT,
      exploraPaymentWhatsapp:EXPLORA_WHATSAPP_DISPLAY,
      paymentDirection:result.direction,
      paymentResultLabel:result.label,
      paymentResultAmount:Number(result.amount || 0)
    };
  }

  function paymentDataFromClosure(closure = {}) {
    const direction = safe(closure.paymentDirection) || (number(closure.amountDueToDriver || 0) > 0 ? "explora_to_driver" : number(closure.amountDueFromDriver || 0) > 0 ? "driver_to_explora" : "balanced");
    return {
      direction,
      driverPayment:{
        phone:safe(closure.driverPaymentPhone || closure.choferTelefono || closure.telefonoChofer),
        cuit:safe(closure.driverPaymentCuit || closure.choferCuit || closure.cuitChofer),
        alias:safe(closure.driverPaymentAlias || closure.choferAlias || closure.aliasChofer)
      }
    };
  }

  function closureWhatsappText({ kind = state.tab, summary = {}, targetName = displayName(), targetUid = getDriverUid(), requestedBy = displayName() } = {}) {
    const result = closureAmountLine(summary);
    const driverPayment = driverPaymentProfileForUid(targetUid);
    const k = activeClosureKind(kind);
    const lines = [
      "*PEDIDO DE CIERRE EXPLORA*",
      `Chofer: ${targetName}`,
      `Pedido por: ${requestedBy}`,
      `Tipo: ${closureTitle(k)}`,
      `Resultado: *${result.label}${result.amount > 0 ? ` ${currency(result.amount)}` : ""}*`
    ];
    if (k === "gastos") {
      lines.push(`Gastos cargados: ${currency(summary.expenseTotal || 0)}`);
      lines.push(`Parte Explora: ${currency(summary.exploraExpenseShare || summary.amountToDriver || 0)}`);
    } else if (k === "caja_chica") {
      lines.push(`Efectivo base: ${currency(summary.gross || 0)}`);
      lines.push(`Caja chica 5%: ${currency(summary.cashboxTotal || summary.amountFromDriver || 0)}`);
    } else {
      lines.push(`Efectivo chofer: ${currency(summary.cashInDriver || 0)}`);
      lines.push(`Digital Explora: ${currency(summary.nonCashInExplora || 0)}`);
      lines.push(`Total facturado: ${currency(summary.gross || 0)}`);
      lines.push(`Parte de cada uno: ${currency(summary.billingShareEach || 0)}`);
    }
    if (result.direction === "explora_to_driver") {
      lines.push("");
      lines.push("*Datos para pagar al chofer:* ");
      lines.push(`Alias: ${driverPayment.alias || "sin cargar"}`);
      lines.push(`CUIT: ${driverPayment.cuit || "sin cargar"}`);
      lines.push(`Teléfono: ${driverPayment.phone || "sin cargar"}`);
    } else if (result.direction === "driver_to_explora") {
      lines.push("");
      lines.push("*Datos de Explora para recibir:* ");
      lines.push(`Alias: ${EXPLORA_ALIAS}`);
      lines.push(`CUIT David: ${EXPLORA_CUIT}`);
      lines.push(`WhatsApp: ${EXPLORA_WHATSAPP_DISPLAY}`);
    }
    lines.push("");
    lines.push("El comprobante se cargará por la app.");
    return lines.join("\n");
  }

  function openWhatsappToExplora(text = "") {
    const encodedText = encodeURIComponent(text || "");
    const webUrl = `https://wa.me/${EXPLORA_WHATSAPP}?text=${encodedText}`;
    const nativeUrl = `whatsapp://send?phone=${EXPLORA_WHATSAPP}&text=${encodedText}`;
    const ua = safe(navigator?.userAgent || "");
    const mobile = /Android|iPhone|iPad|iPod/i.test(ua);

    // En iOS/Android no usamos wa.me/api.whatsapp.com como primera opción porque abre
    // una página intermedia de WhatsApp. El esquema nativo abre directamente la app.
    if (mobile) {
      let appOpened = false;
      let fallbackTimer = null;
      const markOpened = () => { appOpened = true; };
      const onVisibility = () => {
        if (document.visibilityState === "hidden") markOpened();
      };
      const cleanup = () => {
        window.removeEventListener("pagehide", markOpened);
        window.removeEventListener("blur", markOpened);
        document.removeEventListener("visibilitychange", onVisibility);
        if (fallbackTimer) clearTimeout(fallbackTimer);
      };

      try {
        window.addEventListener("pagehide", markOpened, { once:true });
        window.addEventListener("blur", markOpened, { once:true });
        document.addEventListener("visibilitychange", onVisibility);
        window.location.href = nativeUrl;
        fallbackTimer = window.setTimeout(() => {
          cleanup();
          if (!appOpened && document.visibilityState !== "hidden") window.location.href = webUrl;
        }, 1600);
        return true;
      } catch (_) {
        cleanup();
        try { window.location.href = webUrl; return true; } catch (__) { return false; }
      }
    }

    try {
      const opened = window.open(webUrl, "_blank", "noopener");
      if (!opened) window.location.href = webUrl;
      return true;
    } catch (_) {
      try { window.location.href = webUrl; return true; } catch (__) { return false; }
    }
  }

  function renderDriverProfileModal() {
    const body = $("payProfileBody");
    if (!body) return;
    const data = driverPaymentProfile(state.profile || {});
    body.innerHTML = `
      <div class="pay-profile-readonly"><span>Nombre completo</span><strong>${esc(data.fullName || "Chofer")}</strong></div>
      <div class="pay-profile-readonly"><span>Auto modelo y patente</span><strong>${esc(data.car || "Sin auto asignado")}</strong></div>
      <label class="pay-profile-field" for="payProfilePhone"><span>Número de teléfono</span><input id="payProfilePhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Ej: 3757461564" value="${esc(data.phone)}" required /></label>
      <label class="pay-profile-field" for="payProfileCuit"><span>CUIT</span><input id="payProfileCuit" type="text" inputmode="numeric" autocomplete="off" placeholder="Ej: 20-00000000-0" value="${esc(data.cuit)}" required /></label>
      <label class="pay-profile-field" for="payProfileAlias"><span>Alias para cobrar</span><input id="payProfileAlias" type="text" autocomplete="off" placeholder="Ej: alias.mercadopago" value="${esc(data.alias)}" required /></label>
      <div class="pay-profile-note">Estos tres datos los carga el chofer y se adjuntan al pedir cierre para que Explora pueda liquidar más rápido.</div>`;
    const msg = $("payProfileMessage");
    if (msg) { msg.textContent = ""; msg.className = "pay-profile-message"; }
  }

  function openDriverProfileModal() {
    showPayView("inicio");
    renderDriverProfileModal();
    const backdrop = $("payProfileBackdrop");
    if (!backdrop) return;
    backdrop.classList.add("is-open");
    backdrop.setAttribute("aria-hidden", "false");
    setTimeout(() => $("payProfilePhone")?.focus?.(), 60);
  }

  function closeDriverProfileModal() {
    const backdrop = $("payProfileBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("is-open");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function setProfileMessage(message = "", type = "") {
    const msg = $("payProfileMessage");
    if (!msg) return;
    msg.textContent = message;
    msg.className = `pay-profile-message ${type ? `is-${type}` : ""}`.trim();
  }

  async function saveDriverProfileModal() {
    if (isAdmin()) return;
    const phone = safe($("payProfilePhone")?.value || "");
    const cuit = safe($("payProfileCuit")?.value || "");
    const alias = safe($("payProfileAlias")?.value || "");
    const missing = paymentProfileMissingFields({ phone, cuit, alias });
    if (missing.length) { setProfileMessage(`Completá: ${missing.join(", ")}.`, "error"); return; }
    const fields = {
      telefono:phone,
      numeroTelefono:phone,
      whatsapp:phone,
      cuit,
      aliasCobro:alias,
      aliasParaCobrar:alias,
      paymentAlias:alias,
      paymentProfileCompleted:true,
      paymentProfileUpdatedAt:serverTimestamp(),
      paymentProfileUpdatedAtMs:Date.now()
    };
    setProfileMessage("Guardando…");
    try {
      await updateDriverEfficiencyState(getOwnDriverUid(), fields);
      state.profile = { ...(state.profile || {}), ...fields };
      setProfileMessage("Perfil guardado.", "ok");
      setTimeout(closeDriverProfileModal, 650);
    } catch (error) {
      setProfileMessage(error?.message || "No se pudo guardar el perfil.", "error");
    }
  }

  async function updateDriverEfficiencyState(uid = getDriverUid(), rawFields = {}) {
    if (!state.db) throw new Error("No hay conexión con Firestore.");
    const targetUid = safe(uid);
    if (!targetUid) throw new Error("No se pudo identificar el chofer.");
    const candidates = driverDocCandidates(targetUid);
    let lastError = null;
    for (const candidate of candidates) {
      try {
        await updateDoc(doc(state.db, candidate.collectionName, candidate.id), rawFields);
        updateLocalDriverKmState(targetUid, Object.fromEntries(Object.entries(rawFields).filter(([, value]) => typeof value !== "function")));
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("No se pudo guardar el KM del chofer.");
  }

  async function saveInitialKmFromEfficiency() {
    const input = $("payEfficiencyKmInitialInput");
    const km = parseKmValue(input?.value || "");
    if (!Number.isFinite(km) || km <= 0) throw new Error("El KM inicial debe ser numérico y mayor a cero.");
    const uid = getDriverUid();
    const lastKnown = lastKnownKmForValidation(uid);
    if (lastKnown > 0 && km < lastKnown) throw new Error("El KM inicial no puede ser menor al último KM declarado.");
    const nowMs = Date.now();
    const fields = {
      lastKnownKm:Number(km),
      currentEfficiencyPeriodStartKm:Number(km),
      currentEfficiencyPeriodStartAt:serverTimestamp(),
      currentEfficiencyPeriodStartAtMs:nowMs,
      kmInicialPeriodo:Number(km),
      kmActual:Number(km),
      kmInitialSeedLoaded:true,
      efficiencyKmSeeded:true,
      kmInicialCargadoUnaVez:true,
      kmUpdatedAt:serverTimestamp(),
      kmUpdatedAtMs:nowMs
    };
    setEfficiencyFormMessage("Guardando KM inicial…");
    await updateDriverEfficiencyState(uid, fields);
    updateLocalDriverKmState(uid, { ...fields, currentEfficiencyPeriodStartAtMs:nowMs, kmUpdatedAtMs:nowMs });
    setEfficiencyFormMessage("KM inicial guardado.", "ok");
    renderEfficiencyButton();
    setTimeout(renderEfficiencyModal, 450);
  }

  async function saveCurrentKmFromEfficiency() {
    const input = $("payEfficiencyKmCurrentInput");
    const km = parseKmValue(input?.value || "");
    if (!Number.isFinite(km) || km <= 0) throw new Error("El KM actual debe ser numérico y mayor a cero.");
    const uid = getDriverUid();
    const kmInicial = kmInitialForOpenPeriod(uid, state.closures, driverProfileForEfficiency(uid));
    if (!(kmInicial > 0)) throw new Error("Primero cargá KM inicial del auto.");
    if (km < kmInicial) throw new Error("El KM actual no puede ser menor al KM inicial.");
    const nowMs = Date.now();
    const fields = {
      lastKnownKm:Number(km),
      kmActual:Number(km),
      kmActualDeclarado:Number(km),
      kmUpdatedAt:serverTimestamp(),
      kmUpdatedAtMs:nowMs
    };
    setEfficiencyFormMessage("Guardando KM actual…");
    await updateDriverEfficiencyState(uid, fields);
    updateLocalDriverKmState(uid, { ...fields, kmUpdatedAtMs:nowMs });
    setEfficiencyFormMessage("KM actual guardado.", "ok");
    await refreshEfficiencyOwnData(true);
    setTimeout(renderEfficiencyModal, 450);
  }

  function ownEfficiencyValueFromClosure(row = {}) {
    const billing = moneyNumber(row.eficienciaFacturacion ?? row.totalFacturado ?? row.gross ?? row.facturacion ?? row.billingTotal ?? row.totalCobrado ?? row.montoFinal);
    const kmInicial = kmNumberFrom(row, KM_INITIAL_FIELDS);
    const kmFinal = kmNumberFrom(row, KM_FINAL_FIELDS);
    const storedKm = number(row.kmRecorridos ?? row.kmDeclarados ?? row.kmDriven ?? row.kilometrosRecorridos);
    const kmRecorridos = storedKm > 0 ? storedKm : (kmFinal > 0 && kmInicial > 0 ? kmFinal - kmInicial : 0);
    if (!(billing > 0 && kmInicial > 0 && kmFinal > 0 && kmRecorridos > 0)) return 0;
    const direct = moneyNumber(row.eficienciaPorKm ?? row.efficiencyPerKm ?? row.efficiencyPerKmValue ?? row.eficienciaActual ?? row.efficiency);
    return direct > 0 ? direct : billing / kmRecorridos;
  }

  function ownEfficiencyReferenceForDriver(uid = getDriverUid(), closures = state.closures, beforeMs = 0) {
    const valid = validBillingClosuresFor(uid, closures)
      .filter(row => !beforeMs || closureCutMs(row) < beforeMs)
      .map(row => ({ row, value:ownEfficiencyValueFromClosure(row) }))
      .filter(item => item.value > 0)
      .sort((a,b)=>closureCutMs(b.row)-closureCutMs(a.row) || rowMs(b.row)-rowMs(a.row));
    const lastFive = valid.slice(0, 5);
    if (!lastFive.length) return { value:0, count:0, mode:"none" };
    const total = lastFive.reduce((sum, item) => sum + Number(item.value || 0), 0);
    return { value:total / lastFive.length, count:lastFive.length, mode:"promedio_ultimos_5" };
  }

  function efficiencyToneFromDelta(deltaPct = NaN, hasReference = false) {
    if (!hasReference || !Number.isFinite(Number(deltaPct))) return { tone:"mid", label:"Base", level:"Primer cierre guardado" };
    if (deltaPct >= -5) return { tone:"good", label:"Mejoró", level:"Igual o mejor que su promedio propio" };
    if (deltaPct >= -15) return { tone:"mid", label:"Normal", level:"Leve baja contra su promedio propio" };
    if (deltaPct >= -30) return { tone:"bad", label:"Bajó", level:"Por debajo de su promedio propio" };
    return { tone:"alert", label:"Alerta", level:"Muy por debajo de su promedio propio" };
  }

  function efficiencyToneCss(tone = "mid") {
    if (tone === "good") return "efficiency-good";
    if (tone === "bad") return "efficiency-bad";
    if (tone === "alert") return "efficiency-alert";
    return "efficiency-mid";
  }

  function billingAmountFromClosure(row = {}) {
    const direct = moneyNumber(row.eficienciaFacturacion ?? row.totalFacturado ?? row.gross ?? row.grossBeforeCashbox ?? row.facturacion ?? row.billingTotal ?? row.totalCobrado ?? row.montoFinal);
    if (direct > 0) return direct;
    return moneyNumber(row.cashInDriver) + moneyNumber(row.exploraCash ?? row.nonCashInExplora);
  }

  function efficiencyRawHistoryRowsForDriver(uid = getDriverUid(), closures = state.closures) {
    const targetUid = safe(uid);
    return validBillingClosuresFor(targetUid, closures)
      .map(row => {
        const cutMs = closureCutMs(row) || rowMs(row) || Date.now();
        const kmInicial = kmNumberFrom(row, KM_INITIAL_FIELDS);
        const kmFinal = kmFinalSeedFromClosure(row);
        const storedKm = number(row.kmRecorridos ?? row.kmDeclarados ?? row.kmDriven ?? row.kilometrosRecorridos);
        const kmRecorridos = storedKm > 0 ? storedKm : (kmFinal > 0 && kmInicial > 0 ? kmFinal - kmInicial : 0);
        const facturacion = billingAmountFromClosure(row);
        const storedPerKm = moneyNumber(row.eficienciaPorKm ?? row.efficiencyPerKm ?? row.efficiencyPerKmValue ?? row.eficienciaActual ?? row.efficiency);
        const perKm = storedPerKm > 0 ? storedPerKm : (facturacion > 0 && kmRecorridos > 0 ? facturacion / kmRecorridos : 0);
        return { row, id:safe(row.id || row.closureId || `${targetUid}_${cutMs}`), cutMs, dateLabel:dateShort(cutMs), kmInicial, kmFinal, kmRecorridos, facturacion, perKm };
      })
      .filter(item => item.facturacion > 0 && item.kmInicial > 0 && item.kmFinal > 0 && item.kmRecorridos > 0 && item.perKm > 0)
      .sort((a,b)=>a.cutMs-b.cutMs);
  }

  function normalizeStoredEfficiencyHistory(profile = {}) {
    const raw = Array.isArray(profile?.efficiencyLast5Closures) ? profile.efficiencyLast5Closures : [];
    const sorted = raw.map((item, index) => {
      const cutMs = Number(item.cutMs || item.fechaMs || item.dateMs || 0) || Date.now() + index;
      const kmRecorridos = number(item.kmRecorridos || item.km || item.kilometros || 0);
      const facturacion = moneyNumber(item.facturacion || item.total || item.monto || 0);
      const perKm = moneyNumber(item.perKm || item.eficienciaPorKm || 0) || (facturacion > 0 && kmRecorridos > 0 ? facturacion / kmRecorridos : 0);
      return {
        id:safe(item.id || `stored_${cutMs}_${index}`),
        cutMs,
        dateLabel:safe(item.dateLabel || item.fecha || dateShort(cutMs)),
        kmRecorridos,
        facturacion,
        perKm
      };
    }).filter(item => item.kmRecorridos > 0 && item.facturacion > 0 && item.perKm > 0)
      .sort((a,b)=>Number(a.cutMs || 0)-Number(b.cutMs || 0));
    const previousEntries = [];
    return sorted.map(item => {
      const referenceEntries = previousEntries.slice(-5);
      const referenceAvg = referenceEntries.length
        ? referenceEntries.reduce((sum, entry) => sum + Number(entry.perKm || 0), 0) / referenceEntries.length
        : 0;
      const deltaPct = referenceAvg > 0 ? ((item.perKm - referenceAvg) / referenceAvg) * 100 : NaN;
      const result = efficiencyToneFromDelta(deltaPct, referenceAvg > 0);
      previousEntries.push(item);
      return {
        ...item,
        referenceAvg,
        referenceCount:referenceEntries.length,
        tone:result.tone,
        label:result.label,
        level:result.level,
        deltaPct
      };
    }).slice(-5);
  }

  function efficiencyHistoryForDriver(uid = getDriverUid(), closures = state.closures, profile = driverProfileForEfficiency(uid)) {
    const raw = efficiencyRawHistoryRowsForDriver(uid, closures);
    const previousEntries = [];
    const computed = raw.map(item => {
      const referenceEntries = previousEntries.slice(-5);
      const referenceAvg = referenceEntries.length
        ? referenceEntries.reduce((sum, entry) => sum + Number(entry.perKm || 0), 0) / referenceEntries.length
        : 0;
      const deltaPct = referenceAvg > 0 ? ((item.perKm - referenceAvg) / referenceAvg) * 100 : NaN;
      const result = efficiencyToneFromDelta(deltaPct, referenceAvg > 0);
      const entry = {
        ...item,
        tone:result.tone,
        label:result.label,
        level:result.level,
        deltaPct,
        referenceAvg,
        referenceCount:referenceEntries.length
      };
      previousEntries.push(item);
      return entry;
    });
    if (computed.length) return computed.slice(-5);
    return normalizeStoredEfficiencyHistory(profile || {});
  }

  function efficiencyHistoryForStorage(uid = getDriverUid(), closures = state.closures, profile = driverProfileForEfficiency(uid)) {
    return efficiencyHistoryForDriver(uid, closures, profile).map(item => ({
      id:safe(item.id),
      cutMs:Number(item.cutMs || 0),
      dateLabel:safe(item.dateLabel || dateShort(item.cutMs)),
      kmRecorridos:Number(item.kmRecorridos || 0),
      facturacion:Number(item.facturacion || 0),
      perKm:Number(item.perKm || 0),
      referenceAvg:Number(item.referenceAvg || 0),
      referenceCount:Number(item.referenceCount || 0),
      tone:safe(item.tone || "mid"),
      label:safe(item.label || "Cierre"),
      deltaPct:Number.isFinite(Number(item.deltaPct)) ? Number(item.deltaPct) : null
    }));
  }

  function efficiencyStatusFromOwn({ hasCurrent = false, reference = 0, deltaPct = NaN } = {}) {
    if (!hasCurrent || !(reference > 0) || !Number.isFinite(deltaPct)) return { label:"Faltan datos", level:"Pendiente de datos", css:"efficiency-missing", tone:"missing" };
    const result = efficiencyToneFromDelta(deltaPct, true);
    return { label:result.label, level:result.level, css:efficiencyToneCss(result.tone), tone:result.tone };
  }

  function efficiencyStatusFromHistory({ history = [], kmSeedLoaded = false } = {}) {
    const latest = history[history.length - 1] || null;
    if (latest) {
      const tone = safe(latest.tone || "mid");
      const label = latest.label === "Base" ? "Primer cierre" : safe(latest.label || "Eficiencia");
      const level = latest.level || (latest.referenceAvg > 0 ? "Contra promedio propio" : "Primer cierre guardado");
      return { label, level, css:efficiencyToneCss(tone), tone };
    }
    if (kmSeedLoaded) return { label:"Sin cierres", level:"KM inicial cargado", css:"efficiency-mid", tone:"mid" };
    return { label:"Cargar KM inicial", level:"Chofer nuevo o sin KM", css:"efficiency-missing", tone:"missing" };
  }

  function efficiencyMissingReason({ facturacion = 0, kmInicial = 0, kmActual = 0, kmRecorridos = 0, reference = 0 } = {}) {
    if (!(kmInicial > 0)) return "Falta cargar KM inicial.";
    if (kmActual > 0 && kmActual < kmInicial) return "El KM actual no puede ser menor al KM inicial.";
    if (!(facturacion > 0)) return "Falta facturación cargada.";
    if (!(kmActual > 0) || !(kmRecorridos > 0)) return "KM inicial cargado. El KM final se declara al pedir cierre de facturación.";
    if (!(reference > 0)) return "Falta historial propio suficiente para comparar.";
    return "";
  }

  function buildEfficiencyForDriver({ uid = getDriverUid(), name = displayName(), records = state.records, closures = state.closures, profile = driverProfileForEfficiency(uid) } = {}) {
    const targetUid = safe(uid);
    const driverClosures = (closures || []).filter(row => !targetUid || closureBelongsToDriver(row, targetUid));
    const kmInicial = kmInitialForOpenPeriod(targetUid, driverClosures, profile);
    const kmSeedLoaded = hasKmInitialSeedForDriver(targetUid, driverClosures, profile);
    const history = efficiencyHistoryForDriver(targetUid, driverClosures, profile);
    const latest = history[history.length - 1] || null;
    const reference = latest?.referenceAvg > 0 ? latest.referenceAvg : 0;
    const status = efficiencyStatusFromHistory({ history, kmSeedLoaded });
    return {
      uid:targetUid,
      name,
      kmInicial,
      kmSeedLoaded,
      history,
      latestEfficiencyEntry:latest,
      previousEfficiencyEntry:null,
      facturacion:latest?.facturacion || 0,
      kmRecorridos:latest?.kmRecorridos || 0,
      eficiencia:latest?.perKm || 0,
      referenciaPropia:reference,
      diferenciaPct:Number.isFinite(Number(latest?.deltaPct)) ? Number(latest.deltaPct) : NaN,
      missingReason:kmSeedLoaded ? "" : "Falta cargar KM inicial.",
      missingReasons:kmSeedLoaded ? [] : ["Falta cargar KM inicial."],
      status
    };
  }

  function currentEfficiencySnapshot() {
    if (isAdmin() && !getDriverUid()) {
      return { status:{ label:"Seleccioná chofer", level:"Sin chofer seleccionado", css:"efficiency-missing", tone:"missing" }, missingReason:"Seleccioná un chofer.", missingReasons:["Seleccioná un chofer."], kmInicial:0, kmSeedLoaded:false, history:[], latestEfficiencyEntry:null, facturacion:0, kmRecorridos:0, eficiencia:0, referenciaPropia:0, diferenciaPct:NaN, name:"" };
    }
    return buildEfficiencyForDriver({ uid:getDriverUid(), name:displayName() });
  }

  async function refreshEfficiencyOwnData(force = false) {
    if (!force && state.efficiency.loadedAt && Date.now() - state.efficiency.loadedAt < 15000) return;
    const uid = getDriverUid();
    if (!uid) {
      state.efficiency.loadedAt = Date.now();
      renderEfficiencyButton();
      if ($("payEfficiencyBackdrop")?.classList.contains("is-open")) renderEfficiencyModal();
      return;
    }
    state.efficiency.loading = true;
    state.efficiency.error = "";
    try {
      // La eficiencia se recalcula con datos reales actuales del chofer seleccionado/logueado.
      // No compara ni consulta datos de otros choferes para armar el resultado.
      const [records, expenses, closures, debts, debtPayments] = await Promise.all([
        getScopedDocs("billing_records", uid),
        getScopedDocs("gastos", uid),
        getScopedDocs("cierres_semanales", uid),
        getScopedDocs("deudas_choferes", uid),
        getScopedDocs("deuda_pagos", uid)
      ]);
      state.records = records.sort((a,b)=>rowMs(b)-rowMs(a));
      state.expenses = expenses.sort((a,b)=>rowMs(b)-rowMs(a));
      state.closures = closures.sort((a,b)=>rowMs(b)-rowMs(a));
      state.debts = debts.sort((a,b)=>debtCreatedMs(b)-debtCreatedMs(a));
      state.debtPayments = debtPayments.sort((a,b)=>rowMs(b)-rowMs(a));
      if (isAdmin()) {
        await fetchDrivers().catch(()=>{});
        const selected = state.drivers.find(driver => driver.uid === uid);
        if (selected) state.selectedDriverName = selected.name || state.selectedDriverName;
      } else {
        await fetchDrivers().catch(()=>{});
        const own = state.drivers.find(driver => driver.uid === uid || driver.id === state.profileDocumentId);
        if (own?.profile) state.profile = { ...(state.profile || {}), ...own.profile };
      }
      state.latestSummary = computeSummary();
      state.efficiency.loadedAt = Date.now();
    } catch (error) {
      state.efficiency.error = safe(error?.code || error?.message || "No se pudo actualizar la eficiencia propia.");
    } finally {
      state.efficiency.loading = false;
      renderEfficiencyButton();
      if ($("payEfficiencyBackdrop")?.classList.contains("is-open")) renderEfficiencyModal();
    }
  }

  function renderEfficiencyButton() {
    const button = $("payEfficiencyBtn");
    if (!button) return;
    const snapshot = currentEfficiencySnapshot();
    // El botón del Home queda neutro: los colores verde/rojo pertenecen al historial interno,
    // no al estado del período actual.
    button.classList.remove("efficiency-good", "efficiency-mid", "efficiency-bad", "efficiency-missing");
    button.setAttribute("aria-label", `Eficiencia operativa: ${snapshot.status?.label || "Historial"}`);
    button.title = "Eficiencia operativa";
  }

  function signedPercent(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(1).replace(".", ",")}%`;
  }

  function efficiencyMoneyPerKm(value) {
    return value > 0 ? `${currency(value)} / km` : "—";
  }

  function efficiencyHeadlineDelta(snapshot = {}) {
    if (snapshot.status?.tone === "missing" || !(snapshot.referenciaPropia > 0)) return "";
    return `${signedPercent(snapshot.diferenciaPct)} contra tu promedio propio`;
  }

  function efficiencyResultText(snapshot = {}) {
    const tone = snapshot.status?.tone || "missing";
    if (tone === "missing") return snapshot.missingReason || "Faltan datos";
    if (tone === "mid") return "Resultado: Se mantiene";
    const label = tone === "good" ? "Mejoró" : "Bajó";
    return `Resultado: ${label} ${Math.abs(snapshot.diferenciaPct || 0).toFixed(1).replace(".", ",")}%`;
  }

  function setEfficiencyFormMessage(message = "", type = "") {
    const box = $("payEfficiencyFormMessage");
    if (!box) return;
    box.textContent = message;
    box.className = `pay-efficiency-form-message ${type ? `is-${type}` : ""}`.trim();
  }

  function renderInitialKmForm(snapshot = {}) {
    const lastKnown = lastKnownKmForValidation(snapshot.uid || getDriverUid());
    const minText = lastKnown > 0 ? `Debe ser mayor o igual al último KM conocido: ${Math.round(lastKnown)}.` : "Cargá el KM actual para iniciar el período de eficiencia.";
    return `
      <div class="pay-efficiency-initial-card">
        <strong>Cargar KM inicial del auto</strong>
        <p>Este dato abre tu período de eficiencia. No bloquea registrar cobros.</p>
        <label for="payEfficiencyKmInitialInput">KM inicial actual</label>
        <input id="payEfficiencyKmInitialInput" type="number" inputmode="numeric" min="${esc(lastKnown > 0 ? Math.floor(lastKnown) : 0)}" step="1" placeholder="Ej: 100000" />
        <small>${esc(minText)}</small>
        <div class="pay-efficiency-form-message" id="payEfficiencyFormMessage" role="status"></div>
        <div class="pay-efficiency-form-actions">
          <button class="pay-efficiency-secondary" data-pay-efficiency-action="close" type="button">Cargar después</button>
          <button class="pay-efficiency-primary" data-pay-efficiency-action="save-initial-km" type="button">Cargar KM inicial</button>
        </div>
      </div>`;
  }


  function renderCurrentKmForm(snapshot = {}) {
    const minKm = Math.max(Number(snapshot.kmInicial || 0), lastKnownKmForValidation(snapshot.uid || getDriverUid()) || 0);
    const minText = minKm > 0 ? `Debe ser mayor o igual al KM inicial: ${Math.round(minKm)}.` : "Declará el KM actual para calcular la eficiencia.";
    return `
      <div class="pay-efficiency-initial-card pay-efficiency-current-card">
        <strong>Cargar KM actual</strong>
        <p>Este dato permite calcular los kilómetros recorridos del período abierto.</p>
        <label for="payEfficiencyKmCurrentInput">KM actual del auto</label>
        <input id="payEfficiencyKmCurrentInput" type="number" inputmode="numeric" min="${esc(minKm > 0 ? Math.floor(minKm) : 0)}" step="1" placeholder="Ej: ${esc(minKm > 0 ? Math.round(minKm + 1) : 100000)}" />
        <small>${esc(minText)}</small>
        <div class="pay-efficiency-form-message" id="payEfficiencyFormMessage" role="status"></div>
        <div class="pay-efficiency-form-actions">
          <button class="pay-efficiency-secondary" data-pay-efficiency-action="close" type="button">Cargar después</button>
          <button class="pay-efficiency-primary" data-pay-efficiency-action="save-current-km" type="button">Guardar KM actual</button>
        </div>
      </div>`;
  }

  function renderEfficiencyHistoryList(history = []) {
    if (!history.length) {
      return `<div class="pay-efficiency-history-empty">Todavía no hay cierres de eficiencia. Cuando pidas un cierre de facturación, se cargará el KM final y se guardará acá.</div>`;
    }
    const ordered = [...history].sort((a,b)=>Number(b.cutMs || 0)-Number(a.cutMs || 0) || safe(b.id).localeCompare(safe(a.id)));
    return `<div class="pay-efficiency-history" aria-label="Últimos cierres de eficiencia">${ordered.map(item => {
      const tone = ["good", "mid", "bad", "alert"].includes(item.tone) ? item.tone : "mid";
      const resultText = item.label === "Base" || item.label === "Primer cierre" ? "Base" : item.label;
      const referenceCount = Number(item.referenceCount || 0);
      const delta = Number.isFinite(Number(item.deltaPct)) && item.referenceAvg > 0
        ? `<small>${esc(efficiencyMoneyPerKm(item.perKm))} · ${esc(signedPercent(item.deltaPct))} vs promedio propio${referenceCount ? ` (${referenceCount})` : ""}</small>`
        : `<small>${esc(efficiencyMoneyPerKm(item.perKm))} · primer cierre guardado</small>`;
      return `<article class="pay-efficiency-history-item is-${tone}">
        <div class="pay-efficiency-history-main">
          <strong>Cierre ${esc(item.dateLabel || dateShort(item.cutMs))}</strong>
          <span>${esc(Math.round(item.kmRecorridos || 0))} km recorridos por ${currency(item.facturacion || 0)}</span>
          ${delta}
        </div>
        <div class="pay-efficiency-history-badge">${esc(resultText)}</div>
      </article>`;
    }).join("")}</div>`;
  }

  function renderEfficiencyModal() {
    const body = $("payEfficiencyBody");
    if (!body) return;
    if (isAdmin() && !getDriverUid()) {
      body.innerHTML = `<div class="pay-efficiency-empty">Seleccioná un chofer para ver su historial de eficiencia.</div>`;
      return;
    }
    const snapshot = currentEfficiencySnapshot();
    const loading = state.efficiency.loading ? `<div class="pay-efficiency-note">Actualizando historial…</div>` : "";
    const tone = snapshot.status?.tone || "missing";
    const initialKmForm = !snapshot.kmSeedLoaded ? renderInitialKmForm(snapshot) : "";
    const historyHtml = snapshot.kmSeedLoaded ? renderEfficiencyHistoryList(snapshot.history || []) : "";
    const driverLabel = (isAdmin() ? (state.selectedDriverName || snapshot.name || "chofer") : (snapshot.name || displayName())).toUpperCase();
    const latest = snapshot.latestEfficiencyEntry;
    const deltaLine = latest && Number.isFinite(Number(latest.deltaPct)) && latest.referenceAvg > 0 ? `<span class="pay-efficiency-delta">${esc(signedPercent(latest.deltaPct))} contra el promedio propio de ${esc(latest.referenceCount || 0)} cierre${Number(latest.referenceCount || 0) === 1 ? "" : "s"}</span>` : "";
    const kmReadonlyNote = snapshot.kmSeedLoaded
      ? `<div class="pay-efficiency-note">KM inicial actual: ${esc(Math.round(snapshot.kmInicial || 0))} km. El KM final se carga únicamente al pedir cierre de facturación.</div>`
      : "";
    const warning = tone === "bad" || tone === "alert" ? `<div class="pay-efficiency-warning">El último cierre quedó por debajo del promedio propio. Revisá si faltó cargar algún cobro o si hubo más kilómetros recorridos.</div>` : "";
    body.innerHTML = `
      <div class="pay-efficiency-status ${esc(snapshot.status?.css || "efficiency-missing")}">
        <span class="pay-efficiency-status-symbol"><span class="pay-efficiency-status-icon"></span><span class="pay-efficiency-modal-asterisk" aria-hidden="true">*</span></span>
        <div class="pay-efficiency-status-copy">
          <span class="pay-efficiency-driver">${esc(driverLabel)}</span>
          <strong>${esc(snapshot.status?.label || "Eficiencia")}</strong>
          <small>${esc(snapshot.status?.level || "Últimos cierres")}</small>
          ${deltaLine}
        </div>
      </div>
      ${kmReadonlyNote}
      ${initialKmForm}
      ${historyHtml}
      <div class="pay-efficiency-disclaimer">Se muestran los últimos 5 cierres de facturación. Cada cierre nuevo se compara contra el promedio propio de hasta 5 cierres anteriores. El KM final declarado pasa automáticamente a ser el KM inicial del siguiente período.</div>
      ${warning}${loading}`;
  }

  async function openEfficiencyModal() {
    const backdrop = $("payEfficiencyBackdrop");
    if (!backdrop) return;
    backdrop.classList.add("is-open");
    backdrop.setAttribute("aria-hidden", "false");
    renderEfficiencyModal();
    refreshEfficiencyOwnData(true).catch(()=>{});
  }

  function closeEfficiencyModal() {
    const backdrop = $("payEfficiencyBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("is-open");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function renderBellBadge() {
    const badge = $("payBellBadge");
    if (!badge) return;
    const count = pendingClosureRows(notificationDriverUid()).length;
    badge.hidden = count < 1;
    badge.textContent = count > 9 ? "9+" : String(count);
    const bell = $("payBellBtn");
    if (bell) bell.setAttribute("aria-label", count ? `Notificaciones de cierres: ${count} abierto${count === 1 ? "" : "s"}` : "Notificaciones de cierres");
    const navClosure = $("payNavClosure");
    if (navClosure) navClosure.classList.toggle("is-pending-closure", count > 0);
  }

  function renderNotificationsScreen() {
    const list = $("payNotificationList");
    if (!list) return;
    const targetUid = notificationDriverUid();
    const rows = pendingClosureRows(targetUid);
    if (!rows.length) {
      list.innerHTML = `<div class="pay-notification-empty">No tenés cierres abiertos.</div>`;
      return;
    }
    list.innerHTML = rows.map(row => {
      const kind = closureKindOf(row) || "gastos";
      const action = closureActionForViewer(row);
      const driver = closureDriverName(row);
      const requestedByRole = safe(row.requestedByRole || row.solicitadoPorRol || row.requestedRole).toLowerCase();
      let title = isAdmin()
        ? (requestedByRole === "driver" || requestedByRole === "chofer" ? `${driver} pidió cierre` : `Cierre de ${driver}`)
        : (requestedByRole === "admin" || requestedByRole === "explora" ? "Explora pidió el cierre" : "Tu cierre solicitado");
      if (action === "admin_review") title = `${driver} envió comprobante`;
      if (action === "admin_waiting_driver") title = `Esperando comprobante de ${driver}`;
      if (action === "driver_review") title = "Explora envió comprobante";
      if (action === "driver_waiting_admin") title = "Esperando comprobante de Explora";
      if (action === "driver_km") title = "Cargar KM actual";
      const subtitle = `${closureTitle(kind)} · ${closureResultText(row)}`;
      const status = action === "driver_km"
        ? "Cargar KM"
        : action === "driver_upload" || action === "admin_upload"
          ? "Cargar comprobante"
          : action === "admin_review"
          ? "Revisar comprobante"
          : action === "driver_review"
            ? "Ver comprobante"
            : action === "admin_waiting_driver" || action === "driver_waiting_admin"
              ? "Esperando comprobante"
              : "Ver detalle";
      const helper = action === "driver_km" ? "Declará el KM actual para completar la eficiencia del período." : action === "admin_upload" || action === "driver_upload" ? "Resolvé tu situación" : closureStatusText(row);
      return `<button class="pay-notification-row" data-pay-notification-closure="${esc(row.id)}" type="button">
        <span class="pay-notification-icon">${notificationIcon(kind)}</span>
        <span class="pay-notification-copy"><strong>${esc(title)}</strong><small>${esc(helper)}</small><em>${esc(subtitle)}</em></span>
        <span class="pay-notification-side"><time>${esc(closureTimeLabel(row))}</time><b>${esc(status)}</b></span>
      </button>`;
    }).join("");
  }

  function notificationIcon(kind = "gastos") {
    if (activeClosureKind(kind) === "gastos") return `<svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg>`;
    return `<svg viewBox="0 0 24 24"><path d="M7 3h10v18l-2-1-2 1-2-1-2 1-2-1Z"></path><path d="M9 8h6M9 12h6M9 16h4"></path></svg>`;
  }

  function dueNeedsReceipt(closure = {}) {
    const action = closureActionForViewer(closure);
    return action === "driver_upload" || action === "admin_upload";
  }

  function openClosureFromNotification(id) {
    const targetUid = notificationDriverUid();
    const closure = state.closures.find(row => {
      if (safe(row.id) !== safe(id)) return false;
      if (isAdmin()) return targetUid ? closureBelongsToDriver(row, targetUid) : true;
      return closureBelongsToDriver(row, getOwnDriverUid());
    });
    if (!closure) return;
    if (isAdmin()) {
      const closureUid = closureDriverUids(closure)[0] || "";
      if (closureUid && closureUid !== state.selectedDriverUid) {
        state.selectedDriverUid = closureUid;
        state.selectedDriverName = closureDriverName(closure);
        setTimeout(() => startRealtime("admin-open-closure-notification"), 50);
      }
    }
    showPayView("inicio");
    const kind = closureKindOf(closure) || state.tab;
    openClosureModal(isAdmin() ? "admin-review" : "confirm", closure, kind);
  }

  function computeSummary({ records = state.records, expenses = state.expenses, closures = state.closures, debts = state.debts, debtPayments = state.debtPayments } = {}) {
    // Nuevo modo: Chofer y Explora son dos vistas del mismo cierre de facturación.
    // El corte de cualquiera de los dos corta toda la facturación: efectivo + digital.
    const resetBillingMs = lastBillingClosureMs(closures);
    const resetExpensesMs = lastClosureMs(closures, "gastos");
    const resetCashboxMs = lastClosureMs(closures, "caja_chica");

    const billingRecords = records.filter(row => !movementIsDeleted(row) && rowMs(row) > resetBillingMs).sort((a,b)=>rowMs(b)-rowMs(a));
    const cashRecords = billingRecords.filter(row => methodOf(row) === "cash");
    const exploraRecords = billingRecords.filter(row => methodOf(row) !== "cash");
    // Caja chica es módulo independiente y SOLO se genera por cobros en efectivo.
    // Cobros digitales (transferencia/QR/tarjeta) no generan ni descuentan caja chica.
    const cashboxRecords = records.filter(row => !movementIsDeleted(row) && !cashboxIsExcluded(row) && rowMs(row) > resetCashboxMs && methodOf(row) === "cash").sort((a,b)=>rowMs(b)-rowMs(a));
    const cashboxCashRecords = cashboxRecords;
    const cashboxExploraRecords = [];
    const filteredExpenses = expenses.filter(row => !movementIsDeleted(row) && rowMs(row) > resetExpensesMs).sort((a,b)=>rowMs(b)-rowMs(a));

    const cashboxRate = .05;
    let cashGrossInDriver = 0, nonCashGrossInExplora = 0;
    for (const row of cashRecords) {
      const amount = amountOf(row);
      if (amount > 0) cashGrossInDriver += amount;
    }
    for (const row of exploraRecords) {
      const amount = amountOf(row);
      if (amount > 0) nonCashGrossInExplora += amount;
    }

    // Facturación de Chofer/Explora mantiene los montos completos.
    // Caja chica NO descuenta facturación; se calcula aparte solo sobre efectivo.
    const cashboxFromBillingCash = cashGrossInDriver * cashboxRate;
    const cashboxFromBillingExplora = 0;
    const cashInDriver = cashGrossInDriver;
    const nonCashInExplora = nonCashGrossInExplora;

    const gross = cashInDriver + nonCashInExplora;
    const grossBeforeCashbox = gross;
    const cashboxGross = cashboxRecords.reduce((sum, row) => sum + amountOf(row), 0);
    const cashboxTotal = cashboxGross * cashboxRate;
    const cashboxInDriver = cashboxTotal;
    const cashboxInExplora = 0;
    const cashboxAmountFromDriver = cashboxInDriver;
    const cashboxAmountToDriver = 0;
    const billingShareEach = gross * .5;
    const billingNetToDriver = billingShareEach - cashInDriver;
    const amountToDriverForBilling = Math.max(0, billingNetToDriver);
    const amountFromDriverForBilling = Math.max(0, -billingNetToDriver);

    let expenseTotal = 0, driverExpenseShare = 0, exploraExpenseShare = 0, expensesPaidByDriver = 0, expensesPaidByExplora = 0;
    let expenseAmountToDriver = 0;
    for (const row of filteredExpenses) {
      const { amount, driverPart, exploraPart, payer } = expenseParts(row);
      if (!(amount > 0)) continue;
      expenseTotal += amount;
      driverExpenseShare += driverPart;
      exploraExpenseShare += exploraPart;
      if (payer === "explora") expensesPaidByExplora += amount;
      else expensesPaidByDriver += amount;
      // Nuevo modo de gastos: los gastos se cierran aparte y Explora reintegra siempre su mitad al chofer.
      expenseAmountToDriver += exploraPart;
    }
    const expenseAmountFromDriver = 0;
    const netSettlementToDriver = billingNetToDriver + expenseAmountToDriver;

    const billingTab = {
      resetMs:resetBillingMs, records:billingRecords, expenses:[], gross, grossBeforeCashbox, expenseTotal:0,
      cashGrossInDriver, nonCashGrossInExplora, cashInDriver, nonCashInExplora, billingShareEach,
      amountToDriver:amountToDriverForBilling, amountFromDriver:amountFromDriverForBilling,
      netSettlementToDriver:billingNetToDriver,
      summaryLabel:"Facturación abierta"
    };

    const pendientesTab = summarizePendingDebts(debts);

    const tabs = {
      pendientes:pendientesTab,
      caja_chica:{
        kind:"caja_chica", resetMs:resetCashboxMs, records:cashboxRecords, cashboxRecords, cashboxCashRecords, cashboxExploraRecords, expenses:[],
        gross:cashboxGross, expenseTotal:0, mainTotal:cashboxTotal,
        cashInDriver, nonCashInExplora, cashboxRate, cashboxTotal, cashboxInDriver, cashboxInExplora,
        amountToDriver:cashboxAmountToDriver, amountFromDriver:cashboxAmountFromDriver, netSettlementToDriver:-cashboxAmountFromDriver,
        summaryLabel:"Caja chica automática 5%"
      },
      gastos:{
        kind:"gastos", resetMs:resetExpensesMs, records:[], expenses:filteredExpenses, gross:0, expenseTotal,
        driverExpenseShare, exploraExpenseShare, expensesPaidByDriver, expensesPaidByExplora,
        amountToDriver:expenseAmountToDriver, amountFromDriver:expenseAmountFromDriver, netSettlementToDriver:expenseAmountToDriver,
        summaryLabel:"Gastos cargados por el chofer"
      },
      explora:{ kind:"explora", ...billingTab, summaryLabel:"Facturación cobrada por Chofer y Explora" },
      chofer:{ kind:"chofer", ...billingTab, summaryLabel:"Facturación cobrada por Chofer y Explora" },
      facturacion:{ kind:"facturacion", ...billingTab, summaryLabel:"Facturación cobrada por Chofer y Explora" }
    };

    return {
      resetMs:tabs[activeClosureKind(state.tab) || "caja_chica"]?.resetMs || 0,
      records:billingRecords, billingRecords, cashRecords, exploraRecords, expenses:filteredExpenses, debts, debtPayments, tabs, pendientes:pendientesTab,
      cashboxRecords, cashboxCashRecords, cashboxExploraRecords,
      gross, grossBeforeCashbox, cashGrossInDriver, nonCashGrossInExplora, cashboxFromBillingCash, cashboxFromBillingExplora, cashInDriver, nonCashInExplora, billingShareEach,
      cashboxRate, cashboxGross, cashboxTotal, cashboxInDriver, cashboxInExplora, cashboxAmountFromDriver, cashboxAmountToDriver,
      driverShare:billingShareEach, exploraShare:billingShareEach,
      driverShareFromCash:cashInDriver * .5, exploraShareFromCash:cashInDriver * .5,
      driverShareFromExplora:nonCashInExplora * .5, exploraShareFromExplora:nonCashInExplora * .5,
      expenseTotal, driverExpenseShare, exploraExpenseShare, expensesPaidByDriver, expensesPaidByExplora,
      expenseAmountToDriver, expenseAmountFromDriver,
      driverActualCash:cashInDriver,
      exploraCash:nonCashInExplora,
      driverEntitlement:billingShareEach,
      netSettlementToDriver,
      driverFinal:billingShareEach,
      amountToDriver:Math.max(0, netSettlementToDriver), amountFromDriver:Math.max(0, -netSettlementToDriver),
      amountToDriverForBilling, amountFromDriverForBilling, billingNetToDriver,
      pendingDebtTotal:pendientesTab.remainingAmount, pendingDebtPaid:pendientesTab.totalPaid, pendingDebtPenalty:pendientesTab.totalPenalty
    };
  }

  function tabSummary(summary = computeSummary(), kind = state.tab) {
    return summary.tabs?.[activeClosureKind(kind)] || summary.tabs?.[safe(kind)] || summary.tabs?.caja_chica || summary;
  }

  function billingWinner(summary = state.latestSummary || computeSummary()) {
    const cash = number(summary.cashInDriver || 0);
    const digital = number(summary.nonCashInExplora || 0);
    const total = cash + digital;
    if (!(total > 0)) return "none";
    const share = total * .5;
    const delta = cash - share;
    if (delta > 0.49) return "chofer";
    if (delta < -0.49) return "explora";
    return "balanced";
  }

  function closureButtonState(kind = state.tab, summary = state.latestSummary || computeSummary()) {
    const target = activeClosureKind(kind);
    if (!isClosureTab(target) || !hasAdminDriverSelected()) return { visible:false, enabled:false };

    const pending = pendingHomeClosureFor(getDriverUid(), target);
    if (pending) {
      // Si existe un cierre anterior pendiente, NO debe bloquear un nuevo período abierto.
      // Facturación corta Chofer+Explora juntos; por eso, si después del corte Explora vuelve a
      // tener más dinero que el chofer, el botón de Explora debe habilitarse nuevamente.
      if (target === "explora" || target === "facturacion") {
        const t = tabSummary(summary, "explora");
        const amountToDriver = number(summary.amountToDriverForBilling || t.amountToDriver || 0);
        return { visible:true, enabled:amountToDriver > 0.49, pending:true };
      }
      if (target === "chofer") {
        const t = tabSummary(summary, "chofer");
        const amountFromDriver = number(summary.amountFromDriverForBilling || t.amountFromDriver || 0);
        return { visible:true, enabled:isAdmin() && amountFromDriver > 0.49, pending:true };
      }
      if (target === "caja_chica" || target === "gastos") return { visible:true, enabled:false, pending:true };
      return { visible:false, enabled:false, pending:true };
    }

    if (target === "caja_chica") {
      const t = tabSummary(summary, "caja_chica");
      // Caja chica solo la pide Explora/admin cuando hay caja chica en efectivo para pasar.
      return { visible:true, enabled:isAdmin() && number(t.amountFromDriver || 0) > 0 };
    }

    if (target === "gastos") {
      const t = tabSummary(summary, "gastos");
      // Gastos: los pide el chofer si hay gastos abiertos para reintegrar.
      return { visible:true, enabled:!isAdmin() && number(t.expenseTotal || 0) > 0 && number(t.amountToDriver || 0) > 0 };
    }

    if (target === "chofer") {
      const t = tabSummary(summary, "chofer");
      const amountFromDriver = number(summary.amountFromDriverForBilling || t.amountFromDriver || 0);
      // Admin puede pedir cierre al chofer cuando el efectivo del chofer supera su parte.
      // El chofer no se pide a sí mismo este cierre desde su módulo.
      return { visible:true, enabled:isAdmin() && amountFromDriver > 0 };
    }

    if (target === "explora") {
      const t = tabSummary(summary, "explora");
      const amountToDriver = number(summary.amountToDriverForBilling || t.amountToDriver || 0);
      // Facturación: solo se habilita si Explora tiene más dinero y debe pagar al chofer.
      // Si el chofer tiene más dinero, este botón también queda bloqueado.
      return { visible:true, enabled:amountToDriver > 0 };
    }

    return { visible:false, enabled:false };
  }

  function requireClosureAllowed(kind = state.tab, summary = state.latestSummary || computeSummary()) {
    const status = closureButtonState(kind, summary);
    if (!status.visible || !status.enabled) {
      const target = activeClosureKind(kind);
      if (target === "caja_chica") throw new Error("No hay caja chica en efectivo pendiente para cerrar.");
      if (target === "gastos") throw new Error("No hay gastos abiertos para pedir cierre.");
      if (target === "chofer") throw new Error("No hay saldo pendiente para pedir cierre al chofer en este momento.");
      if (target === "explora") throw new Error("El cierre de facturación no corresponde a Explora en este momento.");
      throw new Error("Este módulo no tiene cierre disponible en este momento.");
    }
  }

  function driverUidOf(row = {}) {
    return closureDriverUids(row)[0] || safe(row.driverUid || row.choferUid || row.uid || row.userUid || row.ownerUid);
  }

  function driverNameForRow(row = {}) {
    const explicit = safe(row.driverName || row.choferNombre || row.nombreChofer || row.selectedDriverName || row.conductorNombre || row.driverDisplayName || row.nombre || row.name);
    if (explicit) return explicit;
    const uid = driverUidOf(row);
    return state.drivers.find(driver => driver.uid === uid || driver.id === uid)?.name || "Chofer";
  }

  function adminActivityKind(row = {}) {
    if (row.type === "expense") return "gastos";
    if (row.type === "cashbox") return "caja_chica";
    if (row.type === "debt" || row.type === "debt_payment") return "pendientes";
    if (row.type === "closure") return "cierres";
    if (row.type === "payment") return row.method === "cash" ? "chofer" : "digital";
    return "";
  }

  function adminActivityMatches(row = {}) {
    if (!isAdmin()) return true;
    const type = safe(state.adminActivityType);
    if (type && adminActivityKind(row) !== type) return false;
    const filterUid = safe(state.selectedDriverUid);
    if (!filterUid) return true;
    return closureDriverUids(row.source || row).includes(filterUid) || driverUidOf(row.source || row) === filterUid;
  }

  function renderAdminShellState() {
    const admin = isAdmin();
    const root = $("exploraPagoDashboard");
    root?.classList.toggle("is-admin-activity-home", admin);
    document.body?.classList.toggle("explora-admin-activity-home", admin);
    document.querySelectorAll("#payBottomNav .pay-nav-btn").forEach(button => {
      const span = button.querySelector("span:last-child");
      if (!span) return;
      if (button.dataset.payNav === "inicio") span.textContent = admin ? "Pendientes" : "Inicio";
      else if (button.dataset.payNav === "actividad") span.textContent = admin ? "+ Chofer" : "Actividad";
      else if (button.dataset.payRun === "nuevo-servicio") span.textContent = admin ? "Cierres" : "Cobrar";
      else if (button.id === "payNavClosure") span.textContent = admin ? "Futuro" : "Cierre";
    });
    const title = $("payActivityTitle");
    if (title) title.textContent = admin ? "Últimas actividades" : "Última actividad";
  }

  function movementRows(summary = computeSummary()) {
    const rows = [];
    // Chofer: mantiene la lógica del ciclo abierto. Admin: auditoría global en bruto.
    const adminMode = isAdmin();
    const paymentRows = adminMode ? (state.records || []) : (summary.billingRecords || summary.records || []);
    const cashboxRows = adminMode ? (state.records || []).filter(row => methodOf(row) === "cash" && !cashboxIsExcluded(row) && !movementIsDeleted(row)) : (summary.cashboxRecords || []);
    const expenseRows = adminMode ? (state.expenses || []) : (summary.expenses || []);

    for (const row of paymentRows || []) {
      if (movementIsDeleted(row)) continue;
      const amount = amountOf(row), method = methodOf(row), at = rowMs(row);
      if (!(amount > 0)) continue;
      const cashbox = method === "cash" ? amount * .05 : 0;
      const paymentHasPhoto = method !== "cash" && rowHasAttachment(row);
      rows.push({
        at, type:"payment", method, source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · ${paymentLabel(method)}`,
        meta:safe(row.description || row.detalle || row.notes || row.ruta || "Servicio registrado"),
        detail: method === "cash"
          ? `Cobró el chofer en efectivo: ${currency(amount)} · caja chica separada ${currency(cashbox)}`
          : `Cobró Explora: ${currency(amount)} · no genera caja chica`,
        amount, positive:true,
        hasPhoto:paymentHasPhoto,
        photoKey:paymentHasPhoto ? activityPhotoKey(`payment_${method}`, row) : "",
        photoTitle:paymentLabel(method),
        photoMeta:"Comprobante digital de Explora",
        photoAmount:amount
      });
    }

    for (const row of cashboxRows || []) {
      if (movementIsDeleted(row)) continue;
      const amount = amountOf(row), at = rowMs(row);
      if (!(amount > 0)) continue;
      const cashbox = amount * .05;
      rows.push({
        at: at + 1, type:"cashbox", source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · Caja chica 5%`,
        meta:safe(row.description || row.detalle || row.notes || row.ruta || "Generada automáticamente por cobro efectivo"),
        detail:`Caja chica generada solo por efectivo: la tiene el chofer y debe pasarla a Explora`,
        amount:-cashbox, negative:true
      });
    }

    for (const row of expenseRows || []) {
      if (movementIsDeleted(row)) continue;
      const at = rowMs(row);
      const { amount, driverPart, exploraPart } = expenseParts(row);
      if (!(amount > 0)) continue;
      const expenseHasPhoto = rowHasAttachment(row);
      rows.push({
        at, type:"expense", source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · ${expenseTypeLabel(row)}`,
        meta:safe(row.notes || row.descripcion || row.description || "Gasto operativo"),
        detail: `Gasto cargado por el chofer: ${currency(amount)} · Explora reintegra ${currency(exploraPart)} · Parte chofer ${currency(driverPart)}`,
        amount:-amount, negative:true,
        hasPhoto:expenseHasPhoto,
        photoKey:expenseHasPhoto ? activityPhotoKey("expense", row) : "",
        photoTitle:expenseTypeLabel(row),
        photoMeta:"Comprobante de gasto",
        photoAmount:amount
      });
    }

    const activeDebtRows = adminMode ? (state.debts || []).filter(row => !movementIsDeleted(row)) : (summarizePendingDebts(state.debts).activeDebts || []);
    try { window.ExploraPendingDebtRows = activeDebtRows; } catch (_) {}
    for (const row of activeDebtRows) {
      const at = debtCreatedMs(row) || rowMs(row);
      const remaining = debtRemainingAmount(row);
      const debtId = debtActivityId(row);
      const debtHasPhoto = debtHasAttachment(row);
      rows.push({
        at, type:"debt", source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · ${debtTypeLabel(row)}`,
        meta:safe(row.description || row.descripcion || row.reasonDetail || row.notes || "Pendiente cargado por administrador"),
        detail:`Saldo actual independiente: ${currency(remaining)} · no afecta facturación`,
        amount:-remaining, negative:true,
        debtId, hasPhoto:debtHasPhoto,
        photoKey:debtHasPhoto ? activityPhotoKey("debt", row) : "",
        photoTitle:debtTypeLabel(row),
        photoMeta:"Comprobante de pendiente",
        photoAmount:debtTotalAmount(row) || remaining
      });
    }

    for (const row of debtPaymentRows(state.debtPayments)) {
      if (movementIsDeleted(row)) continue;
      const at = rowMs(row);
      const amount = amountOf(row);
      if (!(amount > 0)) continue;
      const debtPaymentHasPhoto = rowHasAttachment(row);
      rows.push({
        at, type:"debt_payment", source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · Reducción de deuda`,
        meta:safe(row.driverName || row.choferNombre || "Comprobante cargado"),
        detail:`Pago aplicado: ${currency(amount)} · saldo nuevo ${currency(row.newBalance || 0)}`,
        amount, positive:true,
        hasPhoto:debtPaymentHasPhoto,
        photoKey:debtPaymentHasPhoto ? activityPhotoKey("debt_payment", row) : "",
        photoTitle:"Reducción de deuda",
        photoMeta:"Comprobante de pago",
        photoAmount:amount
      });
    }

    for (const row of state.closures.filter(r => safe(r.closureMode || r.periodType) === "on_demand")) {
      const at = rowMs(row);
      const closureKind = closureKindOf(row);
      const stateText = closureActivityStateText(row);
      const closureHasPhoto = rowHasAttachment(row) || !!closureProofUrl(row);
      rows.push({
        at, type:"closure", source:row, driverName:driverNameForRow(row), closureId:safe(row.id || row.closureId), tone:closurePayerClass(row), title:`${dateTimeShort(at)} · ${closureTitle(closureKind)} · ${stateText}`,
        meta:closureActivityMeta(row),
        detail:`${closureStatusText(row)} · A rendir: ${currency(row.amountDueFromDriver || 0)} · A cobrar: ${currency(row.amountDueToDriver || 0)}`,
        amount:0,
        hasPhoto:closureHasPhoto,
        photoKey:closureHasPhoto ? activityPhotoKey("closure", row) : "",
        photoTitle:closureTitle(closureKind),
        photoMeta:"Comprobante de cierre",
        photoAmount:Math.max(number(row.amountDueFromDriver || 0), number(row.amountDueToDriver || 0), number(row.mainTotal || 0))
      });
    }
    return rows.filter(adminActivityMatches).sort((a,b)=>b.at-a.at).slice(0, adminMode ? 60 : 12);
  }

  function render() {
    installShell();
    renderAdminShellState();
    const summary = computeSummary();
    state.latestSummary = summary;
    state.pendingClosure = pendingClosureFor(getDriverUid(), state.tab);
    if (!PAY_TAB_ORDER.includes(state.tab)) state.tab = "chofer";
    document.querySelectorAll("[data-pay-tab]").forEach(button => {
      const active = button.dataset.payTab === state.tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    renderTabAlerts();
    setTimeout(scrollActivePayTabIntoView, 0);
    const greeting = $("payGreeting");
    if (greeting) greeting.textContent = isAdmin() ? "Admin · últimas actividades" : `Hola, ${displayName()}`;
    renderAdminDriverPicker();
    renderMainCard(summary);
    renderClosureStatus(summary);
    renderEfficiencyButton();
    renderActivities(summary);
    renderBellBadge();
    if (state.view === "mas") {
      showPayView("mas");
    } else if (state.view === "notificaciones") {
      showPayView("notificaciones");
    } else {
      setBottomNavActive("inicio");
    }
    if ($("payClosureBackdrop")?.classList.contains("is-open")) renderClosureModal();
    if ($("payAdminDeleteBackdrop")?.classList.contains("is-open")) renderAdminDeleteModal();
  }

  function pendingValueForTab(closure = {}, kind = state.tab) {
    const target = activeClosureKind(kind);
    if (target === "caja_chica") return number(closure.cashboxTotal || closure.mainTotal || 0);
    if (target === "gastos") return number(closure.expenseTotal || 0);
    if (target === "chofer") return number(closure.cashInDriver || 0);
    if (target === "explora") return number(closure.exploraCash || closure.nonCashInExplora || 0);
    if (isBillingClosureKind(target)) return number(closure.gross || 0);
    return 0;
  }

  function pendingResultLine(closure = {}) {
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    if (due > 0) return `Chofer debe liquidar a Explora ${currency(due)}`;
    if (toDriver > 0) return `Explora debe liquidar a chofer ${currency(toDriver)}`;
    return "Nadie debe liquidar";
  }

  function closureMatchesSummaryKind(row = {}, kind = state.tab) {
    const target = activeClosureKind(kind);
    const rowKind = closureKindOf(row);
    if (!target || !rowKind) return false;
    if (target === "caja_chica") return rowKind === "caja_chica";
    if (target === "gastos") return rowKind === "gastos";
    if (isBillingClosureKind(target)) return isBillingClosureKind(rowKind);
    return rowKind === target;
  }

  function firstUsefulNumber(row = {}, fields = []) {
    let firstFinite = null;
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
      const value = number(row[field]);
      if (firstFinite === null) firstFinite = value;
      if (value > 0) return value;
    }
    return firstFinite;
  }

  function closureSnapshotAmount(row = {}, kind = state.tab) {
    const target = activeClosureKind(kind);
    if (target === "gastos") {
      const direct = firstUsefulNumber(row, ["expenseTotal", "mainTotal", "gross", "total", "amount", "monto"]);
      return direct ?? 0;
    }
    if (target === "caja_chica") {
      const direct = firstUsefulNumber(row, ["cashboxTotal", "mainTotal", "amountDueFromDriver", "amountFromDriver", "total", "amount", "monto"]);
      return direct ?? 0;
    }
    if (isBillingClosureKind(target)) {
      const direct = firstUsefulNumber(row, ["gross", "grossBeforeCashbox", "totalFacturado", "totalBilling", "billingTotal", "mainTotal", "total", "amount", "monto"]);
      if (direct !== null) return direct;
      return number(row.cashInDriver || 0) + number(row.nonCashInExplora || row.exploraCash || 0);
    }
    return 0;
  }

  function previousClosureRow(kind = state.tab, uid = getDriverUid()) {
    const targetUid = safe(uid);
    if (isAdmin() && !targetUid) return null;
    return state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => closureMatchesSummaryKind(row, kind))
      .filter(row => !targetUid || closureBelongsToDriver(row, targetUid))
      .filter(row => !/cancelled|canceled|anulado|rechazado/i.test(safe(row.status || row.estado)))
      .sort((a,b)=>closureCutMs(b)-closureCutMs(a) || rowMs(b)-rowMs(a))[0] || null;
  }

  function previousBillingClosureParts(row = {}) {
    const cash = firstUsefulNumber(row, ["cashInDriver", "cashGrossInDriver", "driverActualCash", "efectivoChofer", "cash", "efectivo"]) ?? 0;
    const digital = firstUsefulNumber(row, ["exploraCash", "nonCashInExplora", "nonCashGrossInExplora", "digitalExplora", "digitalInExplora", "digital", "transferQrCardTotal"]) ?? 0;
    const gross = firstUsefulNumber(row, ["gross", "grossBeforeCashbox", "totalFacturado", "totalBilling", "billingTotal", "mainTotal", "total", "amount", "monto"]) ?? (cash + digital);
    const storedShare = firstUsefulNumber(row, ["billingShareEach", "shareEach", "parteCadaUno", "driverEntitlement", "driverFinal", "exploraFinal"]);
    const share = storedShare !== null ? storedShare : (gross * .5);
    const fromDriver = firstUsefulNumber(row, ["amountDueFromDriver", "amountFromDriver", "paidByDriver", "liquidadoPorChofer", "driverPaidExplora"]) ?? 0;
    const toDriver = firstUsefulNumber(row, ["amountDueToDriver", "amountToDriver", "paidByExplora", "liquidadoPorExplora", "exploraPaidDriver"]) ?? 0;
    return {
      cash:Math.max(0, cash),
      digital:Math.max(0, digital),
      gross:Math.max(0, gross),
      share:Math.max(0, share),
      fromDriver:Math.max(0, fromDriver),
      toDriver:Math.max(0, toDriver)
    };
  }

  function previousExpenseClosureParts(row = {}) {
    const total = firstUsefulNumber(row, ["expenseTotal", "mainTotal", "totalGastos", "total", "amount", "monto"]) ?? 0;
    const byExplora = firstUsefulNumber(row, ["amountDueToDriver", "amountToDriver", "paidByExplora", "liquidadoPorExplora", "exploraPaidDriver", "exploraExpenseShare"]) ?? 0;
    const rendered = firstUsefulNumber(row, ["settledTotal", "rendidoTotal", "expenseSettledTotal", "expenseTotal", "mainTotal", "total", "amount", "monto"]) ?? total;
    return {
      total:Math.max(0, total),
      byExplora:Math.max(0, byExplora),
      rendered:Math.max(0, rendered)
    };
  }

  function previousCashboxClosureParts(row = {}) {
    const total = firstUsefulNumber(row, ["cashboxTotal", "mainTotal", "totalCajaChica", "total", "amount", "monto"]) ?? 0;
    const fromDriver = firstUsefulNumber(row, ["amountDueFromDriver", "amountFromDriver", "paidByDriver", "liquidadoPorChofer", "driverPaidExplora", "cashboxInDriver"]) ?? total;
    return {
      total:Math.max(0, total),
      fromDriver:Math.max(0, fromDriver)
    };
  }

  function previousSummaryRows(kind = state.tab, uid = getDriverUid()) {
    const row = previousClosureRow(kind, uid);
    const target = activeClosureKind(kind);
    if (!row) {
      const empty = isBillingClosureKind(target) ? "Sin facturación anterior" : "Sin cierre anterior";
      return [[empty, ""]];
    }
    if (target === "gastos") {
      const p = previousExpenseClosureParts(row);
      return [
        ["Gastos anteriores", currency(p.total)],
        ["Liquidado por Explora", currency(p.byExplora)],
        ["Total gastos anterior / rendido", currency(p.rendered)]
      ];
    }
    if (target === "caja_chica") {
      const p = previousCashboxClosureParts(row);
      return [
        ["Caja chica anterior", currency(p.total)],
        ["Liquidado por chofer", currency(p.fromDriver)],
        ["Total caja chica anterior", currency(p.total)]
      ];
    }
    if (target === "explora") {
      const p = previousBillingClosureParts(row);
      return [
        ["Digital anterior", currency(p.digital)],
        ["Liquidado por chofer", currency(p.fromDriver)],
        ["Total Explora anterior 50%", currency(p.share)]
      ];
    }
    if (target === "chofer") {
      const p = previousBillingClosureParts(row);
      return [
        ["Efectivo anterior", currency(p.cash)],
        ["Liquidado por Explora", currency(p.toDriver)],
        ["Total chofer anterior 50%", currency(p.share)]
      ];
    }
    const amount = closureSnapshotAmount(row, kind);
    return [["Facturación anterior", currency(amount)]];
  }

  function previousClosureSummaryHtml(kind = state.tab, uid = getDriverUid()) {
    const target = activeClosureKind(kind) || "caja_chica";
    const key = ["caja_chica", "gastos", "explora", "chofer"].includes(target) ? target : "caja_chica";
    const open = !!state.previousDetailsOpen[key];
    const panelId = `payPreviousSummary-${key}`;
    const rows = previousSummaryRows(key, uid);
    const rowsHtml = rows.map(([label, value]) => `
        <span class="pay-previous-row">
          <span>${esc(label)}</span>
          ${value ? `<strong>${esc(value)}</strong>` : ""}
        </span>`).join("");
    return `<span class="pay-previous-details${open ? " is-open" : ""}">
      <button class="pay-previous-toggle" type="button" data-pay-previous-toggle="${esc(key)}" aria-expanded="${open ? "true" : "false"}" aria-controls="${esc(panelId)}">${open ? "Ocultar detalles" : "Ver detalles"}</button>
      <span class="pay-previous-panel" id="${esc(panelId)}"${open ? "" : " hidden"}>${rowsHtml}
      </span>
    </span>`;
  }

  function renderMainCard(summary) {
    const amount = $("payMainAmount"), subtitle = $("payMainSubtitle"), pillLabel = $("payPillLabel"), pillAmount = $("payPillAmount"), extra = $("payExtraLines");
    if (!amount || !subtitle || !pillLabel || !pillAmount || !extra) return;
    const lines = [];
    if (isAdmin() && !getDriverUid()) {
      amount.textContent = currency(0);
      subtitle.innerHTML = "Seleccioná un chofer para cargar sus datos abiertos.";
      pillLabel.textContent = "Sin chofer seleccionado";
      pillAmount.textContent = currency(0);
      extra.innerHTML = `<div><span>Administrador</span><strong>Seleccionar chofer</strong></div>`;
      return;
    }
    let main = summary.cashboxTotal, sub = "Caja chica actual del período abierto", pill = "Caja chica", pillValue = 0;
    if (activeClosureKind(state.tab) === "pendientes") {
      const t = tabSummary(summary, "pendientes");
      main = t.remainingAmount || 0;
      sub = "Deuda independiente. No modifica Explora ni Chofer.";
      pill = main > 0 ? "Saldo actual pendiente" : "Sin deuda pendiente";
      pillValue = main;
      lines.push(
        ["Total deuda", currency(t.totalOriginal || main || 0)],
        ["Pagado", currency(t.totalPaid || 0)],
        ["Intereses / mora", currency(t.totalPenalty || 0)],
        ["Deudas activas", String((t.activeDebts || []).length)]
      );
      const top = (t.activeDebts || []).slice(0, 3);
      for (const debt of top) lines.push([debtTypeLabel(debt), currency(debtRemainingAmount(debt))]);
    } else if (activeClosureKind(state.tab) === "caja_chica") {
      const t = tabSummary(summary, "caja_chica");
      main = t.cashboxTotal || 0;
      sub = "Caja chica actual del período abierto";
      pill = t.amountFromDriver > 0 ? "Chofer debe liquidar a Explora" : "Nadie debe liquidar";
      pillValue = t.amountFromDriver || 0;
      lines.push(
        ["Efectivo base", currency(t.gross || 0)],
        ["Caja chica 5% efectivo", currency(t.cashboxInDriver || 0)],
        ["Total caja chica", currency(t.cashboxTotal || 0)]
      );
    } else if (state.tab === "gastos") {
      const t = tabSummary(summary, "gastos");
      main = t.expenseTotal;
      sub = "Gastos actuales del período abierto";
      pill = t.netSettlementToDriver > 0 ? "Explora debe liquidar a chofer" : t.netSettlementToDriver < 0 ? "Chofer debe liquidar a Explora" : "Nadie debe liquidar";
      pillValue = abs(t.netSettlementToDriver);
      lines.push(
        ["Gastos cargados por chofer", currency(summary.expenseTotal)],
        ["Parte chofer", currency(summary.driverExpenseShare)],
        ["Parte Explora", currency(summary.exploraExpenseShare)],
        ["Explora reintegra", currency(t.amountToDriver || 0)]
      );
    } else if (state.tab === "explora") {
      const t = tabSummary(summary, "explora");
      main = summary.nonCashInExplora;
      sub = "Digital actual del período abierto";
      pill = t.amountToDriver > 0 ? "Explora debe liquidar a chofer" : t.amountFromDriver > 0 ? "Chofer debe liquidar a Explora" : "Nadie debe liquidar";
      pillValue = Math.max(t.amountToDriver, t.amountFromDriver);
      lines.push(
        ["Digital cobrado", currency(summary.nonCashGrossInExplora || 0)],
        ["Efectivo del chofer", currency(summary.cashInDriver)],
        ["Total facturado", currency(summary.gross)],
        ["Parte de cada uno 50%", currency(summary.billingShareEach)]
      );
    } else if (state.tab === "chofer") {
      const t = tabSummary(summary, "chofer");
      main = summary.cashInDriver;
      sub = "Efectivo actual del período abierto";
      pill = t.amountToDriver > 0 ? "Explora debe liquidar a chofer" : t.amountFromDriver > 0 ? "Chofer debe liquidar a Explora" : "Nadie debe liquidar";
      pillValue = Math.max(t.amountToDriver, t.amountFromDriver);
      lines.push(
        ["Efectivo cobrado", currency(summary.cashGrossInDriver || 0)],
        ["Digital de Explora", currency(summary.nonCashInExplora)],
        ["Total facturado", currency(summary.gross)],
        ["Parte de cada uno 50%", currency(summary.billingShareEach)]
      );
    } else {
      main = summary.cashboxTotal || 0;
      sub = "Caja chica actual del período abierto";
      pill = summary.cashboxInDriver > 0 ? "Chofer debe liquidar a Explora" : "Nadie debe liquidar";
      pillValue = summary.cashboxInDriver || 0;
      lines.push(
        ["Efectivo base", currency(summary.cashboxGross || 0)],
        ["Caja chica 5% efectivo", currency(summary.cashboxInDriver || 0)]
      );
    }
    const previousHtml = activeClosureKind(state.tab) === "pendientes" ? "" : previousClosureSummaryHtml(state.tab, getDriverUid());
    amount.textContent = currency(main);
    subtitle.innerHTML = `${esc(sub)}${previousHtml}`;
    pillLabel.textContent = pill;
    pillAmount.textContent = currency(pillValue);
    extra.innerHTML = lines.map(([label,value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
  }

  function renderClosureStatus(summary) {
    const box = $("payClosureStatus"), text = $("payClosureStatusText"), action = $("payClosureActionBtn");
    const kind = activeClosureKind(state.tab);
    if (kind === "pendientes") {
      setPendingActionMode(true);
      const pending = tabSummary(summary, "pendientes");
      const canPay = !isAdmin() && number(pending.remainingAmount || 0) > 0;
      if (action) {
        action.hidden = false;
        action.disabled = !canPay;
        action.classList.toggle("is-closure-ready", canPay);
        action.classList.toggle("is-closure-locked", !canPay);
        action.querySelector("span").innerHTML = `Reducir<br/>deuda`;
      }
      if (box) { box.hidden = true; box.style.display = "none"; }
      return;
    }
    setPendingActionMode(false);
    const stateForButton = closureButtonState(kind, summary);
    if (action) {
      action.hidden = !stateForButton.visible;
      action.disabled = !stateForButton.enabled;
      action.classList.toggle("is-closure-ready", !!stateForButton.enabled);
      action.classList.toggle("is-closure-locked", stateForButton.visible && !stateForButton.enabled);
      const label = stateForButton.visible ? closureLabel(kind) : "";
      action.querySelector("span").innerHTML = `Pedir cierre<br/>${esc(label)}`;
    }
    if (!box || !text) return;
    const pending = pendingHomeClosureFor(getDriverUid(), kind);
    const card = homePendingClosureCardData(pending, kind, getDriverUid());
    state.pendingClosure = card ? card.closure : null;
    const showPendingCard = !!card;
    box.hidden = !showPendingCard;
    box.classList.toggle("is-home-module-pending", showPendingCard);
    box.style.display = showPendingCard ? "" : "none";
    const labelEl = box.querySelector("b");
    const buttonEl = box.querySelector("button");
    if (!showPendingCard) {
      if (labelEl) labelEl.textContent = "";
      text.textContent = "";
      if (buttonEl) buttonEl.hidden = true;
      return;
    }
    if (buttonEl) buttonEl.hidden = false;
    if (labelEl) labelEl.textContent = card.message;
    text.textContent = card.title;
  }

  function activityIcon(type) {
    if (type === "debt" || type === "debt_payment") return `<svg viewBox="0 0 24 24"><path d="M12 2 2 20h20L12 2Z"></path><path d="M12 8v5"></path><path d="M12 17h.01"></path></svg>`;
    if (type === "expense" || type === "cashbox") return `<svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg>`;
    if (type === "closure") return `<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path></svg>`;
    return `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>`;
  }

  function renderActivities(summary) {
    const list = $("payActivityList");
    if (!list) return;
    const rows = movementRows(summary);
    try { window.ExploraActivityPhotoRows = rows.filter(row => row.hasPhoto && row.photoKey).map(activityPhotoRegistryRow); } catch (_) {}
    if (!rows.length) { list.innerHTML = `<div class="pay-activity-empty">${isAdmin() ? "No hay actividades con esos filtros." : "Todavía no hay cobros ni gastos en el ciclo abierto."}</div>`; return; }
    list.innerHTML = rows.map(row => {
      const closureAttr = row.type === "closure" && row.closureId ? ` data-pay-activity-closure="${esc(row.closureId)}" role="button" tabindex="0"` : "";
      const closureTone = row.type === "closure" ? ` ${esc(row.tone || "")}` : "";
      const photoButton = row.hasPhoto && row.photoKey
        ? `<button class="pay-activity-photo" type="button" data-notification-attachment="${esc(row.photoKey)}">ver foto</button>`
        : "";
      const photoClass = photoButton ? " has-photo-action" : "";
      const driverLine = isAdmin() ? `<div class="pay-activity-driver-name">${esc(row.driverName || "Chofer")}</div>` : "";
      return `<article class="pay-activity ${row.type === "closure" ? "is-clickable" : ""}${closureTone}${photoClass}"${closureAttr}>
        <span class="pay-activity-icon">${activityIcon(row.type)}</span>
        <div>${driverLine}<div class="pay-activity-title">${esc(row.title)}</div><div class="pay-activity-meta">${esc(row.meta)}</div><div class="pay-activity-detail">${esc(row.detail)}</div></div>
        <strong class="pay-activity-amount ${row.positive ? "is-positive" : row.negative ? "is-negative" : ""}">${row.amount ? (row.amount > 0 ? "+" : "") + currency(row.amount) : ""}</strong>
        ${photoButton}
      </article>`;
    }).join("");
  }

  async function computeDriverSummary(uid) {
    const [records, expenses, closures, debts, debtPayments] = await Promise.all([
      getScopedDocs("billing_records", uid),
      getScopedDocs("gastos", uid),
      getScopedDocs("cierres_semanales", uid),
      getScopedDocs("deudas_choferes", uid),
      getScopedDocs("deuda_pagos", uid)
    ]);
    return computeSummary({ records, expenses, closures, debts, debtPayments });
  }


  function debtPaymentSummaryHtml(pending = summarizePendingDebts()) {
    const top = (pending.activeDebts || []).slice(0, 6);
    const rows = [
      ["Saldo actual", currency(pending.remainingAmount || 0), "closure-payment-result settlement-result-green"],
      ["Total deuda", currency(pending.totalOriginal || pending.remainingAmount || 0)],
      ["Pagado", currency(pending.totalPaid || 0)],
      ["Intereses / mora", currency(pending.totalPenalty || 0)]
    ].concat(top.map(row => [debtTypeLabel(row), currency(debtRemainingAmount(row))]));
    return rows.map(([label, value, className]) => `<article${className ? ` class="${esc(className)}"` : ""}><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("") +
      `<div class="pay-closure-alert">El pago se aplica automáticamente primero a la deuda más antigua. Este módulo no modifica la facturación.</div>`;
  }

  function openDebtPaymentModal() {
    if (state.busy) return;
    const pending = summarizePendingDebts();
    if (isAdmin()) return;
    if (!(pending.remainingAmount > 0)) return;
    state.modalMode = "debt-payment";
    state.modalKind = "pendientes";
    state.modalClosure = null;
    state.modalFile = null;
    const amountInput = $("payDebtPaymentAmountInput");
    const fileInput = $("payClosureReceiptInput");
    if (amountInput) amountInput.value = "";
    if (fileInput) fileInput.value = "";
    $("payClosureBackdrop")?.classList.add("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "false");
    renderClosureModal();
  }

  async function uploadDebtPaymentReceipt({ driverUid, paymentId, file, amount }) {
    if (!state.storage) throw new Error("Storage no está disponible.");
    if (!(file instanceof File) || !(file.size > 0)) throw new Error("Cargá la foto del comprobante.");
    if (file.size > 15 * 1024 * 1024) throw new Error("El comprobante supera 15 MB.");
    const path = debtReceiptPath({ driverUid, paymentId, file });
    const ext = extensionForFile(file);
    const ref = storageRef(state.storage, path);
    await uploadBytes(ref, file, {
      contentType:file.type || (ext === "pdf" ? "application/pdf" : "image/jpeg"),
      customMetadata:{ module:"pendientes_debt_payment", driverUid, paymentId, uploadedByUid:state.auth?.currentUser?.uid || "", amount:String(amount || 0) }
    });
    const url = await getDownloadURL(ref);
    return { url, path, ext };
  }

  async function submitDebtPayment() {
    const user = state.auth?.currentUser;
    if (!user?.uid) throw new Error("No hay sesión activa.");
    if (isAdmin()) throw new Error("Solo el chofer puede reducir su deuda desde esta tarjeta.");
    const driverUid = getOwnDriverUid();
    if (!driverUid) throw new Error("No se pudo identificar al chofer.");
    const pending = summarizePendingDebts();
    const currentBalance = moneyNumber(pending.remainingAmount || 0);
    if (!(currentBalance > 0)) throw new Error("No tenés deuda pendiente para reducir.");
    const amount = moneyNumber($("payDebtPaymentAmountInput")?.value || 0);
    if (!(amount > 0)) throw new Error("Ingresá el monto que vas a pagar.");
    if (amount > currentBalance + 0.49) throw new Error("El monto no puede ser mayor al saldo pendiente.");
    const file = state.modalFile || $("payClosureReceiptInput")?.files?.[0] || null;
    if (!(file instanceof File)) throw new Error("Cargá la foto del comprobante.");
    const paymentId = debtPaymentId(driverUid);
    const receipt = await uploadDebtPaymentReceipt({ driverUid, paymentId, file, amount });
    const nowMs = Date.now();
    const driverName = displayName();
    const oldestDebt = pendingDebtOldestRow();
    const allocations = [];
    await runTransaction(state.db, async transaction => {
      let remainingToApply = amount;
      let previousBalance = 0;
      const debtRefs = (pending.activeDebts || []).map(row => ({ row, id:safe(row.id || row.debtId) })).filter(item => item.id).map(item => ({ row:item.row, ref:doc(state.db, "deudas_choferes", item.id) }));
      const currentRows = [];
      for (const item of debtRefs) {
        const snap = await transaction.get(item.ref);
        if (!snap.exists()) continue;
        const data = { id:snap.id, ...snap.data() };
        if (!debtIsActive(data)) continue;
        currentRows.push({ ref:item.ref, row:data });
        previousBalance += debtRemainingAmount(data);
      }
      currentRows.sort((a,b)=>debtCreatedMs(a.row)-debtCreatedMs(b.row));
      if (!(previousBalance > 0)) throw new Error("La deuda ya no está activa.");
      if (amount > previousBalance + 0.49) throw new Error("El saldo cambió. Actualizá y volvé a intentar.");
      for (const item of currentRows) {
        if (!(remainingToApply > 0)) break;
        const before = debtRemainingAmount(item.row);
        if (!(before > 0)) continue;
        const applied = Math.min(before, remainingToApply);
        const after = Math.max(0, before - applied);
        const paid = debtPaidAmount(item.row) + applied;
        const status = after <= 0.49 ? "paid" : safe(item.row.status || item.row.debtStatus || "pending");
        allocations.push({ debtId:item.ref.id, type:debtTypeOf(item.row), typeLabel:debtTypeLabel(item.row), amount:applied, previousBalance:before, newBalance:after });
        transaction.update(item.ref, {
          remainingAmount:after,
          saldoPendiente:after,
          paidAmount:paid,
          amountPaid:paid,
          status,
          debtStatus:status,
          lastPaymentAt:serverTimestamp(),
          lastPaymentAtMs:nowMs,
          updatedAt:serverTimestamp(),
          updatedAtMs:nowMs,
          sourceModule:"pendientes"
        });
        remainingToApply = Math.max(0, remainingToApply - applied);
      }
      const newBalance = Math.max(0, previousBalance - amount);
      const paymentPayload = {
        paymentId,
        id:paymentId,
        driverUid,
        choferUid:driverUid,
        driverId:driverUid,
        driverName,
        debtId:safe(oldestDebt?.id || oldestDebt?.debtId || allocations[0]?.debtId || ""),
        allocations,
        amount,
        monto:amount,
        previousBalance,
        newBalance,
        receiptUrl:receipt.url,
        comprobanteUrl:receipt.url,
        receiptPath:receipt.path,
        status:"applied",
        estado:"aplicado",
        sourceModule:"pendientes",
        createdByUid:user.uid,
        createdByRole:"driver",
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        updatedAt:serverTimestamp(),
        version:VERSION
      };
      transaction.set(doc(state.db, "deuda_pagos", paymentId), paymentPayload, { merge:false });
      transaction.set(doc(state.db, "deuda_movimientos", `movement_${paymentId}`), {
        movementId:`movement_${paymentId}`,
        type:"payment",
        driverUid,
        driverName,
        debtId:paymentPayload.debtId,
        paymentId,
        amount,
        previousBalance,
        newBalance,
        receiptUrl:receipt.url,
        receiptPath:receipt.path,
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        sourceModule:"pendientes",
        version:VERSION
      }, { merge:false });
      transaction.set(doc(state.db, "notificaciones", `debt_payment_${paymentId}`), {
        notificationId:`debt_payment_${paymentId}`,
        type:"debt_payment",
        category:"pendientes",
        driverUid,
        driverName,
        paymentId,
        debtId:paymentPayload.debtId,
        title:"REDUCCIÓN DE DEUDA",
        message:`${driverName} pagó ${currency(amount)}. Saldo anterior ${currency(previousBalance)} · saldo nuevo ${currency(newBalance)}.`,
        receiptUrl:receipt.url,
        receiptPath:receipt.path,
        amount,
        previousBalance,
        newBalance,
        read:false,
        acknowledged:false,
        createdByUid:user.uid,
        createdByRole:"driver",
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        updatedAt:serverTimestamp(),
        version:VERSION
      }, { merge:false });
    });
    state.debtPayments = [{ id:paymentId, paymentId, driverUid, driverName, amount, previousBalance:currentBalance, newBalance:Math.max(0, currentBalance - amount), receiptUrl:receipt.url, receiptPath:receipt.path, createdAtMs:nowMs, allocations }, ...state.debtPayments];
    state.debts = state.debts.map(row => {
      const allocation = allocations.find(item => item.debtId === safe(row.id || row.debtId));
      if (!allocation) return row;
      const paid = debtPaidAmount(row) + allocation.amount;
      const status = allocation.newBalance <= 0.49 ? "paid" : safe(row.status || row.debtStatus || "pending");
      return { ...row, remainingAmount:allocation.newBalance, saldoPendiente:allocation.newBalance, paidAmount:paid, status, debtStatus:status, updatedAtMs:nowMs };
    });
    render();
  }

  async function openClosureModal(mode = "request", closure = null, kind = state.tab) {
    if (state.busy) return;
    const resolvedKind = closureKindOf(closure || {}) || activeClosureKind(kind);
    if (mode === "request") {
      if (!isClosureTab(resolvedKind)) return;
      const status = closureButtonState(resolvedKind, state.latestSummary || computeSummary());
      if (!status.enabled) return;
    }
    state.modalMode = mode;
    state.modalKind = resolvedKind;
    // En modo request no pre-cargar cierres abiertos anteriores.
    // "Pedir cierre" debe trabajar únicamente con el período abierto actual.
    state.modalClosure = mode === "request" ? null : (closure || pendingClosureFor(getDriverUid(), resolvedKind) || null);
    state.modalFile = null;
    const input = $("payClosureReceiptInput");
    if (input) input.value = "";
    $("payClosureBackdrop")?.classList.add("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "false");
    if (isAdmin()) await fetchDrivers();
    renderClosureModal();
  }

  function closeClosureModal() {
    $("payClosureBackdrop")?.classList.remove("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "true");
    state.modalFile = null;
    state.modalClosure = null;
    state.modalMode = "";
    state.modalKind = "";
    const debtAmountInput = $("payDebtPaymentAmountInput");
    if (debtAmountInput) debtAmountInput.value = "";
    state.busy = false;
  }

  function setModalMessage(message = "", type = "") {
    const box = $("payClosureMessage");
    if (!box) return;
    box.textContent = message;
    box.className = `pay-closure-message ${type ? `is-${type}` : ""}`;
  }

  function renderDriverSelect() {
    const field = $("payClosureDriverField"), select = $("payClosureDriverSelect");
    if (!field || !select) return;
    field.hidden = !isAdmin() || state.modalMode !== "request";
    if (field.hidden) return;
    const options = [`<option value="">Elegir chofer…</option>`].concat(state.drivers.map(driver => `<option value="${esc(driver.uid)}">${esc(driver.name)}</option>`));
    select.innerHTML = options.join("");
    select.value = safe(state.selectedDriverUid);
  }

  function closureDetailSummary(closure = {}, kind = "gastos", adminView = false) {
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const gross = number(closure.gross || 0);
    const expenseTotal = number(closure.expenseTotal || 0);
    const cash = number(closure.cashInDriver || 0);
    const digital = number(closure.exploraCash || closure.nonCashInExplora || 0);
    const share = number(closure.billingShareEach || 0);
    const status = safe(closure.statusLabel || closure.estado || closure.status || "pendiente");
    const cut = closureTimeLabel(closure);
    const driver = closureDriverName(closure);
    const kindLabel = closureTitle(kind);
    const k = activeClosureKind(kind);
    const result = due > 0 ? "Chofer debe liquidar a Explora" : toDriver > 0 ? "Explora debe liquidar a chofer" : "Nadie debe liquidar";
    const amount = Math.max(due, toDriver);
    const base = [
      ["Motivo", closureRequesterText(closure)],
      ["Chofer", driver],
      ["Tipo de cierre", kindLabel],
      ["Corte", cut],
      ["Estado", status],
      [result, currency(amount), "closure-payment-result settlement-result-green"]
    ];
    const detail = k === "caja_chica"
      ? [["Efectivo base", currency(closure.cashboxGross || gross)], ["Caja chica total 5%", currency(closure.cashboxTotal || closure.mainTotal || amount)], ["En poder del chofer", currency(closure.cashboxInDriver || due)]]
      : k === "gastos"
        ? [["Gastos incluidos", currency(expenseTotal)], ["Parte chofer 50%", currency(expenseTotal * .5)], ["Parte Explora 50%", currency(toDriver || expenseTotal * .5)]]
        : [["Efectivo chofer", currency(cash)], ["Digital Explora", currency(digital)], ["Total facturado", currency(gross)], ["Parte de cada uno", currency(share)]];
    const receiptUrl = closureProofUrl(closure);
    const receipt = receiptUrl ? [["Comprobante", "cargado"]] : [];
    const rows = base.concat(detail, [["Estado", closureStatusText(closure)]], receipt).map(([label,value,className]) => `<article${className ? ` class="${esc(className)}"` : ""}><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("");
    const paymentData = paymentDataFromClosure(closure);
    const paymentRows = closurePaymentRowsHtml({ driverPayment:paymentData.driverPayment, direction:paymentData.direction });
    const receiptLink = receiptUrl ? `<a class="pay-closure-receipt-link" href="${esc(receiptUrl)}" target="_blank" rel="noopener">Abrir comprobante</a>` : "";
    const alert = due > 0 && !receiptUrl && !adminView ? `<div class="pay-closure-alert">Para quedar al día, cargá el comprobante de transferencia.</div>` : "";
    return rows + paymentRows + receiptLink + alert;
  }

  function renderClosureModal() {
    renderDriverSelect();
    const title = $("payClosureTitle"), subtitle = $("payClosureSubtitle"), summary = $("payClosureSummary"), fileField = $("payClosureFileField"), debtField = $("payDebtPaymentField"), debtInput = $("payDebtPaymentAmountInput"), debtHint = $("payDebtPaymentHint"), kmField = $("payClosureKmField"), kmInput = $("payClosureKmInput"), kmHint = $("payClosureKmHint"), submit = $("payClosureSubmit"), cancel = $("payClosureCancel");
    const actions = submit?.closest(".pay-closure-actions");
    if (!title || !subtitle || !summary || !fileField || !submit || !cancel) return;
    const closure = state.modalClosure;
    const kind = closureKindOf(closure || {}) || activeClosureKind(state.modalKind || state.tab) || "gastos";
    const latest = tabSummary(state.latestSummary || computeSummary(), kind);
    fileField.hidden = true;
    if (debtField) debtField.hidden = true;
    if (kmField) kmField.hidden = true;
    if (kmInput) kmInput.required = false;
    cancel.textContent = "Cancelar";
    cancel.hidden = false;
    submit.hidden = false;
    if (actions) actions.hidden = false;
    submit.className = "pay-closure-primary";
    submit.disabled = false;

    if (state.modalMode === "debt-payment") {
      const pending = summarizePendingDebts();
      title.textContent = "Reducir deuda";
      subtitle.textContent = "Cargá el monto que transferiste y adjuntá la foto del comprobante.";
      summary.innerHTML = debtPaymentSummaryHtml(pending);
      fileField.hidden = false;
      const fileLabel = fileField.querySelector("label");
      if (fileLabel) fileLabel.textContent = "Comprobante obligatorio";
      if (debtField) debtField.hidden = false;
      if (debtHint) debtHint.textContent = `Saldo actual: ${currency(pending.remainingAmount || 0)}. Se descuenta primero la deuda más antigua.`;
      if (debtInput) debtInput.max = String(Math.floor(pending.remainingAmount || 0));
      if (kmField) kmField.hidden = true;
      submit.disabled = !(pending.remainingAmount > 0) || isAdmin();
      submit.textContent = "Confirmar pago";
      cancel.textContent = "Cancelar";
      return;
    }

    const normalFileLabel = fileField.querySelector("label");
    if (normalFileLabel) normalFileLabel.textContent = "Comprobante de transferencia";

    if (closure) {
      const action = closureActionForViewer(closure);
      const due = number(closure.amountDueFromDriver || 0);
      const toDriver = number(closure.amountDueToDriver || 0);
      const proof = closureHasProof(closure);
      const completed = closureIsCompleted(closure);
      const kmNeeded = action === "driver_km";
      const uploadNeeded = (action === "driver_upload" || action === "admin_upload") && !proof && !completed;
      fileField.hidden = !uploadNeeded;
      if (kmField) kmField.hidden = !kmNeeded;
      if (kmInput) {
        kmInput.required = kmNeeded;
        kmInput.value = kmNeeded ? "" : kmInput.value;
        const kmMin = kmInitialForClosure(closure);
        if (kmMin > 0) kmInput.min = String(Math.floor(kmMin));
        else kmInput.removeAttribute("min");
        if (kmHint) kmHint.textContent = kmMin > 0 ? `Debe ser mayor o igual al KM inicial ${Math.round(kmMin)}.` : "Este KM cierra el período de eficiencia y será el inicio del próximo.";
      }
      summary.innerHTML = closureDetailSummary(closure, kind, isAdmin());
      const noSubmitNeeded = (completed || proof) && !["admin_review", "driver_review"].includes(action);
      if (noSubmitNeeded) {
        submit.hidden = true;
        cancel.textContent = "Cerrar";
      }

      if (state.modalMode === "confirm") {
        title.textContent = closureRequesterText(closure);
        if (action === "driver_km") {
          subtitle.textContent = "Explora pidió el cierre de facturación. Cargá el KM actual del auto para completar la eficiencia del período.";
          submit.disabled = false;
          submit.textContent = "Guardar KM actual";
        } else if (action === "driver_upload") {
          subtitle.textContent = "Resolvé tu situación: transferí a Explora y cargá el comprobante.";
          submit.disabled = false;
          submit.textContent = "Subir comprobante y cerrar";
        } else if (action === "driver_review") {
          subtitle.textContent = "Explora cargó el comprobante. El cierre quedará cerrado automáticamente.";
          submit.disabled = false;
          submit.textContent = "Cerrar";
        } else if (action === "driver_waiting_admin") {
          subtitle.textContent = "Explora debe liquidar y cargar el comprobante. No tenés que subir archivo.";
          submit.disabled = true;
          submit.textContent = "Esperando Explora";
        } else {
          subtitle.textContent = completed ? "Cierre completo." : proof ? "Comprobante enviado. Esperando confirmación." : "Revisá el detalle del cierre solicitado.";
          submit.disabled = true;
          submit.textContent = proof ? "Comprobante enviado" : "Sin acción";
        }
        return;
      }

      if (state.modalMode === "admin-review" && isAdmin()) {
        title.textContent = `Revisar ${closureTitle(kind).toLowerCase()}`;
        if (action === "admin_upload") {
          subtitle.textContent = `${closureRequesterText(closure)}. Explora debe liquidar y cargar el comprobante para notificar al chofer.`;
          submit.disabled = false;
          submit.textContent = "Subir comprobante y cerrar";
        } else if (action === "admin_review") {
          subtitle.textContent = `${closureDriverName(closure)} cargó el comprobante. El cierre quedará cerrado automáticamente.`;
          submit.disabled = false;
          submit.textContent = "Cerrar";
        } else if (action === "admin_waiting_driver") {
          subtitle.textContent = `${closureDriverName(closure)} debe liquidar y cargar el comprobante. Explora no debe subir archivo.`;
          submit.disabled = true;
          submit.textContent = "Esperando chofer";
        } else {
          subtitle.textContent = completed ? "Cierre completo." : proof ? "Comprobante cargado. No corresponde subir otro comprobante." : "Esperando comprobante de quien debe liquidar.";
          submit.disabled = true;
          submit.textContent = proof ? "Comprobante recibido" : "Esperando";
        }
        return;
      }
    }

    title.textContent = isAdmin() ? `Pedir ${closureTitle(kind).toLowerCase()} a un chofer` : `Pedir ${closureTitle(kind).toLowerCase()}`;
    subtitle.textContent = isAdmin()
      ? (getDriverUid() ? `Chofer seleccionado: ${state.selectedDriverName || "chofer"}. El corte será inmediato.` : "Seleccioná primero un chofer para cargar sus datos y pedir el cierre.")
      : "El corte será inmediato: lo nuevo que cargues después empieza desde cero en este mismo tipo de cierre.";
    submit.textContent = `Pedir ${closureTitle(kind).toLowerCase()}`;
    submit.disabled = isAdmin() && !getDriverUid();
    // CAMBIO 3: En modo request el campo de archivo está SIEMPRE oculto.
    // El comprobante lo sube quien tiene que pagar DESPUÉS de que se crea el cierre.
    // Regla: el solicitante nunca sube comprobante al pedir —el cierre queda ABIERTO para la otra parte.
    fileField.hidden = true;
    const requestShowsKm = isBillingClosureKind(kind);
    const requestNeedsKm = requestShowsKm;
    if (kmField) kmField.hidden = !requestShowsKm;
    if (kmInput) {
      kmInput.required = requestNeedsKm;
      kmInput.value = "";
      if (requestShowsKm) {
        const kmMin = kmInitialForOpenPeriod(getDriverUid(), state.closures, isAdmin() ? driverProfileForEfficiency(getDriverUid()) : state.profile);
        if (kmMin > 0) kmInput.min = String(Math.floor(kmMin));
        else kmInput.removeAttribute("min");
        if (kmHint) kmHint.textContent = kmMin > 0 ? `Debe ser mayor o igual al último KM declarado ${Math.round(kmMin)}.` : "Primero cargá KM inicial desde Eficiencia Operativa.";
      }
    }
    if (kind === "caja_chica") {
      summary.innerHTML = `<article><span>Efectivo base</span><strong>${currency(latest.gross || 0)}</strong></article><article><span>Caja chica 5%</span><strong>${currency(latest.cashboxTotal || 0)}</strong></article><article><span>En poder del chofer</span><strong>${currency(latest.cashboxInDriver || 0)}</strong></article><article class="closure-payment-result settlement-result-green"><span class="closure-liquidation-label">Chofer debe liquidar a Explora</span><strong>${currency(latest.amountFromDriver || 0)}</strong></article>`;
    } else if (kind === "gastos") {
      summary.innerHTML = `<article><span>Gastos cargados</span><strong>${currency(latest.expenseTotal || 0)}</strong></article><article><span>Parte chofer</span><strong>${currency(latest.driverExpenseShare || 0)}</strong></article><article><span>Parte Explora</span><strong>${currency(latest.exploraExpenseShare || 0)}</strong></article><article class="closure-payment-result settlement-result-green"><span class="closure-liquidation-label">Explora debe liquidar a chofer</span><strong>${currency(latest.amountToDriver || 0)}</strong></article>`;
    } else {
      summary.innerHTML = `<article><span>Efectivo chofer</span><strong>${currency(latest.cashInDriver || 0)}</strong></article><article><span>Digital Explora</span><strong>${currency(latest.nonCashInExplora || 0)}</strong></article><article><span>Total facturado</span><strong>${currency(latest.gross || 0)}</strong></article><article><span>Parte de cada uno</span><strong>${currency(latest.billingShareEach || 0)}</strong></article><article class="closure-payment-result settlement-result-green"><span class="closure-liquidation-label">Resultado</span><strong>${latest.amountFromDriver > 0 ? `Chofer debe liquidar a Explora ${currency(latest.amountFromDriver)}` : latest.amountToDriver > 0 ? `Explora debe liquidar a chofer ${currency(latest.amountToDriver)}` : "Nadie debe liquidar"}</strong></article>`;
    }
    const payData = closureAmountLine(latest);
    const driverPayment = driverPaymentProfileForUid(getDriverUid());
    summary.innerHTML += closurePaymentRowsHtml({ driverPayment, direction:payData.direction });
  }

  async function submitClosureModal() {
    if (state.busy) return;
    state.busy = true;
    setModalMessage("Procesando…");
    const submit = $("payClosureSubmit");
    const oldText = submit?.textContent || "Aceptar";
    if (submit) submit.textContent = "Procesando…";
    try {
      if (state.modalMode === "debt-payment") await submitDebtPayment();
      else if (state.modalMode === "confirm" && state.modalClosure && closureActionForViewer(state.modalClosure) === "driver_km") await driverSubmitClosureKm(state.modalClosure);
      else if (state.modalMode === "confirm" && state.modalClosure) await driverConfirmClosure(state.modalClosure);
      else if (state.modalMode === "admin-review" && state.modalClosure && isAdmin()) await adminSubmitClosure(state.modalClosure);
      else await requestClosure();
      setModalMessage("Listo.", "ok");
      setTimeout(closeClosureModal, 700);
    } catch (error) {
      console.error("EXPLORA_PAY_CLOSURE", error);
      setModalMessage(error?.message || "No se pudo completar el cierre.", "error");
    } finally {
      state.busy = false;
      if (submit) submit.textContent = oldText;
    }
  }


  function readClosureKmInput({ initialKm = 0, required = true } = {}) {
    const raw = safe($("payClosureKmInput")?.value || "");
    if (!raw) {
      if (required) throw new Error("Cargá el KM actual del auto.");
      return 0;
    }
    const km = parseKmValue(raw);
    if (!Number.isFinite(km)) throw new Error("El KM actual debe ser numérico.");
    if (km <= 0) throw new Error("El KM actual debe ser mayor a cero.");
    if (initialKm > 0 && km < initialKm) throw new Error("El KM actual no puede ser menor al último KM declarado.");
    return km;
  }

  function efficiencySummaryFromClosure(closure = {}) {
    return {
      gross:moneyNumber(closure.eficienciaFacturacion ?? closure.totalFacturado ?? closure.gross ?? closure.grossBeforeCashbox ?? closure.facturacion ?? closure.billingTotal ?? closure.cashInDriver ?? 0),
      records:new Array(Math.max(0, Number(closure.eficienciaServicios || closure.includedBillingIds?.length || 0)))
    };
  }

  function efficiencyPayloadFromKm({ kmActual = 0, kmInicial = 0, summary = state.latestSummary || computeSummary(), pending = false, uid = getDriverUid(), beforeMs = 0 } = {}) {
    const facturacion = moneyNumber(summary.gross ?? summary.totalFacturado ?? summary.billingTotal ?? 0);
    const servicios = Number((summary.billingRecords || summary.records || []).length || summary.eficienciaServicios || 0);
    const kmRecorridos = kmActual > 0 && kmInicial > 0 ? Math.max(0, kmActual - kmInicial) : 0;
    const hasCurrent = facturacion > 0 && kmInicial > 0 && kmActual > 0 && kmRecorridos > 0;
    const eficienciaPorKm = hasCurrent ? facturacion / kmRecorridos : 0;
    const reference = ownEfficiencyReferenceForDriver(uid, state.closures, beforeMs);
    const diferenciaPct = hasCurrent && reference.value > 0 ? ((eficienciaPorKm - reference.value) / reference.value) * 100 : NaN;
    const status = efficiencyStatusFromOwn({ hasCurrent, reference:reference.value, deltaPct:diferenciaPct });
    return {
      kmActual:Number(kmActual || 0),
      lastKnownKm:Number(kmActual || 0),
      kmInicialPeriodo:Number(kmInicial || 0),
      kmFinalPeriodo:Number(kmActual || 0),
      kmRecorridos:Number(kmRecorridos || 0),
      eficienciaFacturacion:Number(facturacion || 0),
      eficienciaServicios:Number(servicios || 0),
      eficienciaPorKm:Number(eficienciaPorKm || 0),
      eficienciaEstado:status.label,
      eficienciaDiferenciaPct:Number.isFinite(diferenciaPct) ? Number(diferenciaPct) : null,
      eficienciaReferenciaPropia:Number(reference.value || 0),
      eficienciaReferenciaConteo:Number(reference.count || 0),
      eficienciaReferenciaModo:reference.mode || "none",
      efficiencyReferenceAverage:Number(reference.value || 0),
      efficiencyReferenceCount:Number(reference.count || 0),
      efficiencyReferenceMode:reference.mode || "none",
      efficiencyTone:status.tone || "missing",
      efficiencyLabel:status.label || "Faltan datos",
      eficienciaPendienteDatos:!!pending || !hasCurrent,
      eficienciaUpdatedAt:serverTimestamp(),
      eficienciaUpdatedAtMs:Date.now(),
      kmInicialNuevoPeriodo:Number(kmActual || 0),
      efficiencyNextKmInitial:Number(kmActual || 0),
      currentEfficiencyPeriodStartKm:Number(kmActual || 0),
      kmInitialSeedLoaded: kmActual > 0 || kmInicial > 0,
      efficiencyKmSeeded: kmActual > 0 || kmInicial > 0,
      kmInicialCargadoUnaVez: kmActual > 0 || kmInicial > 0
    };
  }

  async function driverSubmitClosureKm(closure = {}) {
    if (!closure?.id) throw new Error("No se pudo identificar el cierre.");
    const uid = safe(closure.driverUid || closure.choferUid || closure.uid || getDriverUid());
    const initialKm = kmInitialForClosure(closure);
    if (!(initialKm > 0)) throw new Error("Primero se necesita un KM inicial válido para medir eficiencia.");
    const kmActual = readClosureKmInput({ initialKm, required:true });
    const summary = efficiencySummaryFromClosure(closure);
    const efficiencyPayload = efficiencyPayloadFromKm({ kmActual, kmInicial:initialKm, summary, pending:false, uid, beforeMs:closureCutMs(closure) || Date.now() });
    const updatedClosure = { ...closure, ...efficiencyPayload, kmPendienteChofer:false, status:safe(closure.status || "requested"), estado:safe(closure.estado || "solicitado"), statusLabel:"KM actual declarado por chofer", updatedAtMs:Date.now() };
    await updateDoc(doc(state.db, "cierres_semanales", closure.id), {
      ...efficiencyPayload,
      kmPendienteChofer:false,
      status:safe(closure.status || "requested"),
      estado:safe(closure.estado || "solicitado"),
      statusLabel:"KM actual declarado por chofer",
      kmDeclaredByUid:state.auth?.currentUser?.uid || "",
      kmDeclaredByName:displayName(),
      kmDeclaredAt:serverTimestamp(),
      kmDeclaredAtMs:Date.now(),
      updatedAt:serverTimestamp()
    });
    state.closures = [updatedClosure, ...state.closures.filter(row => row.id !== closure.id)];
    updateDriverEfficiencyState(uid, {
      lastKnownKm:Number(kmActual || 0),
      currentEfficiencyPeriodStartKm:Number(kmActual || 0),
      currentEfficiencyPeriodStartAt:serverTimestamp(),
      currentEfficiencyPeriodStartAtMs:Date.now(),
      kmInicialPeriodo:Number(kmActual || 0),
      kmActual:Number(kmActual || 0),
      kmInitialSeedLoaded:true,
      efficiencyKmSeeded:true,
      kmInicialCargadoUnaVez:true,
      lastEfficiencyPerKm:Number(efficiencyPayload.eficienciaPorKm || 0),
      averageOwnEfficiencyPerKm:Number(efficiencyPayload.eficienciaReferenciaPropia || 0),
      efficiencyLast5Closures:efficiencyHistoryForStorage(uid, state.closures),
      kmUpdatedAt:serverTimestamp(),
      kmUpdatedAtMs:Date.now()
    }).catch(error => console.warn("EXPLORA_PAY_DRIVER_KM_STATE", error?.code || error?.message));
  }

  async function requestClosure() {
    const user = state.auth?.currentUser;
    if (!user?.uid) throw new Error("No hay sesión activa.");
    const kind = activeClosureKind(state.modalKind || state.tab);
    if (!isClosureTab(kind)) throw new Error("Elegí Caja chica, Gastos o Explora para pedir un cierre.");
    let targetUid = getDriverUid();
    let targetName = displayName();
    if (isAdmin()) {
      targetUid = safe($("payClosureDriverSelect")?.value || state.selectedDriverUid);
      const driver = state.drivers.find(d => d.uid === targetUid);
      if (!targetUid || !driver) throw new Error("Elegí un chofer para pedir el cierre.");
      state.selectedDriverUid = targetUid;
      state.selectedDriverName = driver.name;
      targetName = driver.name;
    }
    // Puede existir un cierre anterior pendiente; eso no debe impedir cortar un nuevo período
    // si ya hay movimientos nuevos después del último corte.
    if (!isAdmin()) requireOwnPaymentProfileComplete();
    const fullSummary = isAdmin() ? await computeDriverSummary(targetUid) : (state.latestSummary || computeSummary());
    requireClosureAllowed(kind, fullSummary);
    const summary = tabSummary(fullSummary, kind);
    const paymentPayload = closurePaymentDataForPayload(targetUid, summary);
    const whatsappText = closureWhatsappText({ kind, summary, targetName, targetUid, requestedBy:isAdmin() ? accountName() : displayName() });
    const cutoffAtMs = Date.now();
    let kmInitial = 0, kmActual = 0;
    const isBillingRequest = isBillingClosureKind(kind);
    let billingKmPending = false;
    if (isBillingRequest) {
      kmInitial = kmInitialForOpenPeriod(targetUid, state.closures, isAdmin() ? driverProfileForEfficiency(targetUid) : state.profile);
      if (!(kmInitial > 0)) throw new Error("Primero cargá KM inicial del auto desde Eficiencia Operativa.");
      kmActual = readClosureKmInput({ initialKm:kmInitial, required:true });
    }
    const recordIds = (summary.records || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const expenseIds = (summary.expenses || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const amountFromDriver = Number(summary.amountFromDriver || 0);
    const amountToDriver = Number(summary.amountToDriver || 0);
    const payerRole = amountFromDriver > 0.49 ? "driver" : amountToDriver > 0.49 ? "admin" : "balanced";
    const autoClosed = payerRole === "balanced";
    const payload = {
      closureMode:"on_demand",
      periodType:"on_demand",
      closureKind:kind,
      closureType:kind,
      payTab:kind,
      billingClosure:isBillingClosureKind(kind),
      billingResetGroup:isBillingClosureKind(kind) ? "facturacion" : "",
      affectsTabs:isBillingClosureKind(kind) ? ["chofer", "explora", "facturacion"] : [kind],
      homeModule:kind,
      requestModule:kind,
      originModule:kind,
      status:autoClosed ? "closed" : "requested",
      estado:autoClosed ? "cerrado" : "solicitado",
      statusLabel:autoClosed ? "Cierre equilibrado · cerrado automáticamente" : `${closureTitle(kind)} solicitado`,
      closureStatus:autoClosed ? "closed" : "requested",
      paymentStatus:autoClosed ? "paid" : "pending",
      receiptStatus:autoClosed ? "not_required" : "pending",
      paid:autoClosed,
      completed:autoClosed,
      pendingPayerRole:payerRole,
      receiptRequiredFrom:payerRole,
      driverUid:targetUid,
      choferUid:targetUid,
      uid:targetUid,
      driverName:targetName,
      requestedByUid:user.uid,
      requestedByName:isAdmin() ? accountName() : displayName(),
      requestedByRole:isAdmin() ? "admin" : "driver",
      ...paymentPayload,
      whatsappNoticeTo:EXPLORA_WHATSAPP_DISPLAY,
      whatsappNoticeText:whatsappText,
      ...(isBillingRequest ? efficiencyPayloadFromKm({ kmActual, kmInicial:kmInitial, summary, pending:billingKmPending, uid:targetUid, beforeMs:cutoffAtMs }) : {}),
      ...(isBillingRequest && isAdmin() && billingKmPending ? { kmPendienteChofer:true, kmTaskStatus:"pending_driver_km" } : {}),
      gross:Number(summary.gross || 0),
      expenseTotal:Number(summary.expenseTotal || 0),
      cashInDriver:Number(summary.cashInDriver || 0),
      exploraCash:Number(summary.nonCashInExplora || 0),
      cashboxRate:Number(summary.cashboxRate || 0),
      cashboxGross:Number(summary.gross || 0),
      cashboxTotal:Number(summary.cashboxTotal || 0),
      cashboxInDriver:Number(summary.cashboxInDriver || 0),
      cashboxInExplora:Number(summary.cashboxInExplora || 0),
      billingShareEach:Number(summary.billingShareEach || 0),
      netSettlementToDriver:Number(summary.netSettlementToDriver || 0),
      amountDueFromDriver:amountFromDriver,
      amountDueToDriver:amountToDriver,
      includedBillingIds:recordIds,
      includedExpenseIds:expenseIds,
      includedCount:Number(recordIds.length + expenseIds.length),
      cycleStartedAtMs:Number(summary.resetMs || 0),
      cutoffAtMs,
      requestedAtMs:cutoffAtMs,
      requestedAt:serverTimestamp(),
      ...(autoClosed ? { closedAt:serverTimestamp(), closedAtMs:cutoffAtMs, completedAt:serverTimestamp(), completedAtMs:cutoffAtMs } : {}),
      createdAt:serverTimestamp(),
      updatedAt:serverTimestamp(),
      version:VERSION
    };
    const created = await addDoc(collection(state.db, "cierres_semanales"), payload);
    state.closures = [{ ...payload, id:created.id, createdAtMs:cutoffAtMs, updatedAtMs:cutoffAtMs }, ...state.closures.filter(row => row.id !== created.id)];
    if (!isAdmin()) openWhatsappToExplora(whatsappText);
    if (isBillingRequest && kmActual > 0) {
      updateDriverEfficiencyState(targetUid, {
        lastKnownKm:Number(kmActual || 0),
        currentEfficiencyPeriodStartKm:Number(kmActual || 0),
        currentEfficiencyPeriodStartAt:serverTimestamp(),
        currentEfficiencyPeriodStartAtMs:Date.now(),
        kmInicialPeriodo:Number(kmActual || 0),
        kmActual:Number(kmActual || 0),
        kmInitialSeedLoaded:true,
        efficiencyKmSeeded:true,
        kmInicialCargadoUnaVez:true,
        lastEfficiencyPerKm:Number(payload.eficienciaPorKm || 0),
        averageOwnEfficiencyPerKm:Number(payload.eficienciaReferenciaPropia || 0),
        efficiencyLast5Closures:efficiencyHistoryForStorage(targetUid, state.closures),
        kmUpdatedAt:serverTimestamp(),
        kmUpdatedAtMs:Date.now()
      }).catch(error => console.warn("EXPLORA_PAY_REQUEST_KM_STATE", error?.code || error?.message));
    }
    render();
  }

  function extensionForFile(file) {
    const byName = safe(file?.name).match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
    if (byName) return byName === "jpeg" ? "jpg" : byName;
    const mime = safe(file?.type).toLowerCase();
    if (mime.includes("png")) return "png";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("pdf")) return "pdf";
    return "jpg";
  }

  async function uploadClosureReceipt(closure, file) {
    if (!state.storage) throw new Error("Storage no está disponible.");
    if (!(file instanceof File) || !(file.size > 0)) throw new Error("Seleccioná una foto o PDF del comprobante.");
    if (file.size > 15 * 1024 * 1024) throw new Error("El comprobante supera 15 MB.");
    const ext = extensionForFile(file);
    const closureId = safe(closure.id || closure.closureId || `cierre_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
    const driverUid = safe(closure.driverUid || closure.uid || getDriverUid());
    const path = `gastos/${driverUid}/${closureId}/cierre-a-demanda.${ext}`;
    const ref = storageRef(state.storage, path);
    await uploadBytes(ref, file, { contentType:file.type || (ext === "pdf" ? "application/pdf" : "image/jpeg"), customMetadata:{ module:"on_demand_closure", driverUid, closureId, uploadedByUid:state.auth?.currentUser?.uid || "" } });
    const url = await getDownloadURL(ref);
    return { url, path, ext };
  }

  function closureClosedPayload({ closure = {}, receipt = null, uploadedBy = "admin" } = {}) {
    const nowMs = Date.now();
    const isDriver = uploadedBy === "driver";
    const actorName = isDriver ? displayName() : accountName();
    const actorRole = isDriver ? "driver" : "admin";
    const label = isDriver
      ? "Cierre cerrado automáticamente con comprobante del chofer"
      : "Cierre cerrado automáticamente con comprobante de Explora";
    return {
      status:"closed",
      estado:"cerrado",
      statusLabel:label,
      closureStatus:"closed",
      paymentStatus:"paid",
      receiptStatus:"confirmed",
      paid:true,
      completed:true,
      closedByUid:state.auth?.currentUser?.uid || "",
      closedByName:actorName,
      closedByRole:actorRole,
      closedReason:"receipt_uploaded_by_payer",
      closedAt:serverTimestamp(),
      closedAtMs:nowMs,
      completedAt:serverTimestamp(),
      completedAtMs:nowMs,
      confirmedByUid:state.auth?.currentUser?.uid || "",
      confirmedByName:actorName,
      confirmedAt:serverTimestamp(),
      confirmedAtMs:nowMs,
      receiptUrl:receipt?.url || closureProofUrl(closure) || null,
      receiptPath:receipt?.path || safe(closure.receiptPath || closure.driverReceiptPath || closure.adminReceiptPath) || null,
      receiptUploadedBy:actorRole,
      receiptUploadedAt:serverTimestamp(),
      receiptUploadedAtMs:nowMs,
      updatedAt:serverTimestamp(),
      updatedAtMs:nowMs,
      ...(isDriver ? { driverUploadedAt:serverTimestamp(), driverUploadedAtMs:nowMs, driverReceiptUrl:receipt?.url || closure.driverReceiptUrl || closure.receiptUrl || null, driverReceiptPath:receipt?.path || closure.driverReceiptPath || closure.receiptPath || null } : {}),
      ...(!isDriver ? { adminUploadedAt:serverTimestamp(), adminUploadedAtMs:nowMs, adminReceiptUrl:receipt?.url || closure.adminReceiptUrl || closure.receiptUrl || null, adminReceiptPath:receipt?.path || closure.adminReceiptPath || closure.receiptPath || null } : {})
    };
  }

  async function driverConfirmClosure(closure) {
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const ref = doc(state.db, "cierres_semanales", closure.id);
    if (due > 0 && !closureHasProof(closure)) {
      const receipt = await uploadClosureReceipt(closure, state.modalFile);
      await updateDoc(ref, closureClosedPayload({ closure, receipt, uploadedBy:"driver" }));
      return;
    }
    if (toDriver > 0 && closureHasProof(closure)) {
      await updateDoc(ref, closureClosedPayload({ closure, uploadedBy:"admin" }));
      return;
    }
    if (!(due > 0) && !(toDriver > 0)) {
      await updateDoc(ref, {
        status:"closed",
        estado:"cerrado",
        statusLabel:"Cierre equilibrado · cerrado automáticamente",
        closureStatus:"closed",
        paymentStatus:"paid",
        receiptStatus:"not_required",
        paid:true,
        completed:true,
        closedByUid:state.auth?.currentUser?.uid || "",
        closedByName:displayName(),
        closedByRole:"driver",
        closedReason:"balanced_no_receipt_required",
        closedAt:serverTimestamp(),
        closedAtMs:Date.now(),
        updatedAt:serverTimestamp()
      });
      return;
    }
    throw new Error("Todavía falta el comprobante correspondiente.");
  }

  async function adminSubmitClosure(closure) {
    if (!closure?.id) throw new Error("No se pudo identificar el cierre.");
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const ref = doc(state.db, "cierres_semanales", closure.id);
    if (toDriver > 0 && !closureHasProof(closure)) {
      const receipt = await uploadClosureReceipt(closure, state.modalFile);
      await updateDoc(ref, closureClosedPayload({ closure, receipt, uploadedBy:"admin" }));
      return;
    }
    if (due > 0 && closureHasProof(closure)) {
      await updateDoc(ref, closureClosedPayload({ closure, uploadedBy:"driver" }));
      return;
    }
    if (!(due > 0) && !(toDriver > 0)) {
      await updateDoc(ref, {
        status:"closed",
        estado:"cerrado",
        statusLabel:"Cierre equilibrado · cerrado automáticamente",
        closureStatus:"closed",
        paymentStatus:"paid",
        receiptStatus:"not_required",
        paid:true,
        completed:true,
        closedByUid:state.auth?.currentUser?.uid || "",
        closedByName:accountName(),
        closedByRole:"admin",
        closedReason:"balanced_no_receipt_required",
        closedAt:serverTimestamp(),
        closedAtMs:Date.now(),
        updatedAt:serverTimestamp()
      });
      return;
    }
    throw new Error("Todavía falta el comprobante correspondiente.");
  }

  async function refreshSession(user) {
    state.user = user || state.auth?.currentUser || null;
    const session = window.ExploraSession || {};
    state.role = safe(session.role || session.profile?.role || session.profile?.rol || "driver").toLowerCase() || "driver";
    state.profile = session.profile || {};
    state.profileDocumentId = session.profileDocumentId || session.driverId || state.user?.uid || "";
    if (!isAdmin()) {
      state.selectedDriverUid = "";
      state.selectedDriverName = "";
    }
    state.previousDetailsOpen = { caja_chica:false, gastos:false, explora:false, chofer:false };
    forceHomeLanding();
    render();
    startRealtime("session");
    setTimeout(() => refreshEfficiencyOwnData(false).catch(()=>{}), 700);
  }

  async function boot() {
    try {
      installShell(); bindShell();
      forceHomeLanding();
      await waitFirebase();
      onAuthStateChanged(state.auth, user => refreshSession(user));
      window.addEventListener("explora:session-opened", () => refreshSession(state.auth?.currentUser));
      window.addEventListener("explora:auth-cleared", () => { clearListeners(); state.user = null; });
      setTimeout(() => refreshSession(state.auth?.currentUser), 1200);
    } catch (error) {
      console.warn("EXPLORA_PAY_BOOT", error?.message || error);
    }
  }

  window.addEventListener("pageshow", event => {
    if (!event.persisted && document.readyState !== "complete") return;
    if (payOverlayIsOpen()) return;
    forceHomeLanding();
    render();
  });
  let payHiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { payHiddenAt = Date.now(); return; }
    if (document.visibilityState !== "visible") return;
    if (payOverlayIsOpen()) return;
    if (payHiddenAt && Date.now() - payHiddenAt > 45000) {
      forceHomeLanding();
      render();
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once:true });
  else boot();
  window.ExploraPagoHome = Object.freeze({ version:VERSION, render, openClosureModal, computeSummary, refreshOpenData, openEfficiencyModal });
})();
