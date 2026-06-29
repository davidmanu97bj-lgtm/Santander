import { collection, query, where, limit, onSnapshot, getDocs, addDoc, doc, updateDoc, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

(() => {
  "use strict";

  const VERSION = "explora-pago-home-v17-closure-button-proof-clean";
  const AR_TZ = "America/Argentina/Cordoba";
  const $ = id => document.getElementById(id);
  const state = {
    tab:"caja_chica",
    view:"inicio",
    user:null,
    role:"driver",
    profile:{},
    selectedDriverUid:"",
    selectedDriverName:"",
    db:null,
    auth:null,
    storage:null,
    drivers:[],
    records:[],
    expenses:[],
    closures:[],
    extra:[],
    unsubscribers:[],
    latestSummary:null,
    pendingClosure:null,
    modalMode:"request",
    modalKind:"",
    modalClosure:null,
    modalFile:null,
    busy:false
  };

  const currency = value => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Number(value) || 0).replace(/\s/g, "");
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const abs = value => Math.abs(number(value));
  const safe = value => String(value ?? "").trim();
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const isAdmin = () => /admin|owner|david/i.test(String(state.role || "")) || /david/i.test(String(state.profile?.nombre || state.profile?.displayName || state.user?.displayName || ""));

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

  function amountOf(row = {}) {
    return Math.max(0, number(row.amount ?? row.monto ?? row.valor ?? row.finalPrice ?? row.total ?? row.importe));
  }

  function expenseTypeLabel(row = {}) {
    const raw = safe(row.expenseType || row.tipo || row.category || row.categoria || "gasto").toLowerCase();
    const map = { combustible:"Combustible", peajes:"Peaje", peaje:"Peaje", estacionamiento:"Estacionamiento", lavado:"Lavado", mantenimiento:"Mantenimiento", compras:"Compras", gasto:"Gasto" };
    return map[raw] || raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function paymentLabel(method) {
    return ({ cash:"Cobro efectivo", transfer:"Cobro transferencia", card:"Cobro tarjeta", qr:"Cobro QR" })[method] || "Cobro";
  }

  function activeClosureKind(kind = state.tab) {
    const raw = safe(kind).toLowerCase();
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

  function dateShort(value) {
    const d = new Date(value || Date.now());
    return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit" }).format(d);
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
          <button class="pay-tab is-active" data-pay-tab="caja_chica" type="button" role="tab" aria-selected="true">Caja chica</button>
          <button class="pay-tab" data-pay-tab="gastos" type="button" role="tab" aria-selected="false">Gastos</button>
          <button class="pay-tab" data-pay-tab="explora" type="button" role="tab" aria-selected="false">Explora</button>
          <button class="pay-tab" data-pay-tab="chofer" type="button" role="tab" aria-selected="false">Chofer</button>
        </nav>
        <section class="pay-admin-driver-picker" id="payAdminDriverPicker" hidden>
          <label for="payAdminDriverSelect">Seleccionar chofer</label>
          <select id="payAdminDriverSelect"><option value="">Cargando choferes…</option></select>
          <small id="payAdminDriverHint">Elegí un chofer para ver sus valores y pedir cierres.</small>
        </section>
        <section class="pay-main-card" aria-live="polite">
          <div class="pay-main-row">
            <div class="pay-amount-wrap">
              <div class="pay-amount-line"><strong class="pay-amount" id="payMainAmount">—</strong></div>
              <span class="pay-subtitle" id="payMainSubtitle">Cargando caja operativa…</span>
            </div>
            <button class="pay-enter" id="payCardEnterBtn" type="button">Entrar <svg viewBox="0 0 24 24"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg></button>
          </div>
          <div class="pay-actions">
            <button class="pay-action" data-pay-run="nuevo-servicio" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg><span>Registrar<br/>cobro</span></button>
            <button class="pay-action" data-pay-run="cargar-gastos" type="button"><svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg><span>Cargar<br/>gasto</span></button>
            <button class="pay-action" id="payClosureActionBtn" type="button" hidden disabled><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 14h6M9 17h4"></path></svg><span>Pedir<br/>cierre</span></button>
          </div>
          <div class="pay-liquid-pill"><span id="payPillLabel">Dinero a liquidar</span><strong id="payPillAmount">—</strong></div>
          <div class="pay-extra-lines" id="payExtraLines"></div>
          <div class="pay-status-pill" id="payClosureStatus" hidden><span><b>Cierre pendiente</b><br><small id="payClosureStatusText">—</small></span><button id="payClosureStatusBtn" type="button">Ver</button></div>
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
          <div class="pay-notification-empty">No tenés cierres pendientes.</div>
        </div>
      </section>
      <button class="pay-floating-spark" id="payQuickClosureBtn" type="button" aria-label="Pedir cierre" hidden><svg viewBox="0 0 24 24"><path d="M12 2 14.8 9.2 22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z"></path></svg></button>
      <nav class="pay-bottom-nav" id="payBottomNav" aria-label="Navegación principal Explora">
        <button class="pay-nav-btn is-active" data-pay-nav="inicio" type="button"><svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 10v10h14V10"></path></svg><span>Inicio</span></button>
        <button class="pay-nav-btn" data-pay-nav="actividad" type="button"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"></path></svg><span>Actividad</span></button>
        <button class="pay-nav-btn pay-nav-main" data-pay-run="nuevo-servicio" type="button"><svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path><path d="M8 8h3v3H8zM13 8h3v3h-3zM8 13h3v3H8zM13 13h3v3h-3z"></path></svg><span>Cobrar</span></button>
        <button class="pay-nav-btn" id="payNavClosure" type="button"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 14h6M9 17h4"></path></svg><span>Cierre</span></button>
        <button class="pay-nav-btn" data-pay-nav="mas" type="button"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"></path><path d="M18 17h2M19 16v2"></path></svg><span>Más</span></button>
      </nav>
      <div class="pay-closure-backdrop" id="payClosureBackdrop" aria-hidden="true">
        <section class="pay-closure-modal" role="dialog" aria-modal="true" aria-labelledby="payClosureTitle">
          <header><div><h2 id="payClosureTitle">Cierre a demanda</h2><p id="payClosureSubtitle">Pedí o confirmá un cierre cuando sea necesario.</p></div><button class="pay-closure-close" id="payClosureClose" type="button" aria-label="Cerrar">×</button></header>
          <div class="pay-closure-field" id="payClosureDriverField" hidden><label for="payClosureDriverSelect">Chofer</label><select id="payClosureDriverSelect"><option value="">Cargando choferes…</option></select></div>
          <div class="pay-closure-summary" id="payClosureSummary"></div>
          <div class="pay-closure-field" id="payClosureFileField" hidden><label for="payClosureReceiptInput">Comprobante de transferencia</label><input id="payClosureReceiptInput" type="file" accept="image/*,application/pdf" /></div>
          <div class="pay-closure-message" id="payClosureMessage"></div>
          <div class="pay-closure-actions"><button class="pay-closure-secondary" id="payClosureCancel" type="button">Cancelar</button><button class="pay-closure-primary" id="payClosureSubmit" type="button">Pedir cierre</button></div>
        </section>
      </div>
    `;
    shell.insertAdjacentHTML("afterbegin", html);
    document.body.classList.add("explora-pay-mode");
  }

  function runExistingAction(action) {
    try {
      if (window.ExploraActions?.[action]) { window.ExploraActions[action](); return; }
      const oldButton = Array.from(document.querySelectorAll("[data-action]")).find(el => el.getAttribute("data-action") === action);
      if (oldButton && !oldButton.closest("#exploraPagoDashboard") && !oldButton.closest("#payBottomNav")) oldButton.click();
    } catch (error) { console.warn("EXPLORA_PAY_ACTION_FAILED", action, error); }
  }

  function bindShell() {
    document.querySelectorAll("[data-pay-tab]").forEach(button => button.addEventListener("click", () => {
      state.tab = button.dataset.payTab || "caja_chica";
      render();
    }));
    document.querySelectorAll("[data-pay-run]").forEach(button => button.addEventListener("click", () => runExistingAction(button.dataset.payRun)));
    $("payClosureActionBtn")?.addEventListener("click", () => {
      if (!closureButtonState(state.tab, state.latestSummary || computeSummary()).enabled) return;
      const pending = pendingClosureFor(getDriverUid(), state.tab);
      openClosureModal(pending && !isAdmin() ? "confirm" : "request", pending, state.tab);
    });
    $("payQuickClosureBtn")?.addEventListener("click", () => {
      if (!isClosureTab(state.tab) || !closureButtonState(state.tab, state.latestSummary || computeSummary()).enabled) return;
      const pending = pendingClosureFor(getDriverUid(), state.tab);
      openClosureModal(pending && !isAdmin() ? "confirm" : "request", pending, state.tab);
    });
    $("payNavClosure")?.addEventListener("click", () => {
      const kind = isClosureTab(state.tab) ? state.tab : "gastos";
      if (!closureButtonState(kind, state.latestSummary || computeSummary()).enabled) return;
      const pending = pendingClosureFor(getDriverUid(), kind);
      openClosureModal(pending && !isAdmin() ? "confirm" : "request", pending, kind);
    });
    $("payClosureStatusBtn")?.addEventListener("click", () => {
      const pending = pendingClosureFor(getDriverUid(), state.tab);
      openClosureModal(pending && !isAdmin() ? "confirm" : "admin-review", pending, state.tab);
    });
    $("payBellBtn")?.addEventListener("click", () => showPayView("notificaciones"));
    $("payCardEnterBtn")?.addEventListener("click", () => {
      if (state.tab === "gastos") { runExistingAction("cargar-gastos"); return; }
      if (state.tab === "chofer" || state.tab === "explora") {
        if (!closureButtonState(state.tab, state.latestSummary || computeSummary()).enabled) return;
        openClosureModal(state.pendingClosure && !isAdmin() ? "confirm" : "request", state.pendingClosure, state.tab);
        return;
      }
      runExistingAction("nuevo-servicio");
    });
    $("payRefreshBtn")?.addEventListener("click", () => startRealtime("manual-refresh"));
    $("payAdminDriverSelect")?.addEventListener("change", event => selectAdminDriver(event.target?.value || ""));
    $("payClosureClose")?.addEventListener("click", closeClosureModal);
    $("payClosureCancel")?.addEventListener("click", closeClosureModal);
    $("payClosureBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payClosureBackdrop") closeClosureModal(); });
    $("payClosureReceiptInput")?.addEventListener("change", event => { state.modalFile = event.target?.files?.[0] || null; renderClosureModal(); });
    $("payClosureSubmit")?.addEventListener("click", submitClosureModal);
    document.querySelector('[data-pay-nav="inicio"]')?.addEventListener("click", () => showPayView("inicio"));
    document.querySelector('[data-pay-nav="actividad"]')?.addEventListener("click", () => {
      showPayView("inicio");
      setTimeout(() => $("payActivityTitle")?.scrollIntoView({ behavior:"smooth", block:"start" }), 40);
    });
    document.querySelector('[data-pay-nav="mas"]')?.addEventListener("click", () => showPayView("mas"));
    $("payMoreBack")?.addEventListener("click", () => showPayView("inicio"));
    $("payNotificationsBack")?.addEventListener("click", () => showPayView("inicio"));
    $("payNotificationsSettings")?.addEventListener("click", () => showPayView("mas"));
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
      showPayView("inicio");
      runExistingAction(button.dataset.payMoreAction);
    });
    $("payMoreAdminList")?.addEventListener("click", event => {
      const button = event.target.closest("[data-pay-more-action]");
      if (!button) return;
      showPayView("inicio");
      runExistingAction(button.dataset.payMoreAction);
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
      { title:"Choferes", detail:"Altas, autos y gestión", action:"admin-choferes", icon:"users" },
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
      wallet:'<path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path>'
    };
    return `<svg viewBox="0 0 24 24">${icons[name] || icons.user}</svg>`;
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
    const hint = $("payAdminDriverHint");
    if (!picker || !select) return;
    picker.hidden = !isAdmin();
    if (!isAdmin()) return;
    const current = safe(state.selectedDriverUid);
    const options = [`<option value="">Seleccionar chofer…</option>`].concat(state.drivers.map(driver => `<option value="${esc(driver.uid)}">${esc(driver.name)}</option>`));
    select.innerHTML = options.join("");
    select.value = current;
    if (hint) hint.textContent = current ? `Viendo datos abiertos de ${state.selectedDriverName || "chofer seleccionado"}.` : "Hasta seleccionar un chofer, todos los valores se muestran en $0.";
  }

  function selectAdminDriver(uid = "") {
    const nextUid = safe(uid);
    const driver = state.drivers.find(item => item.uid === nextUid);
    state.selectedDriverUid = nextUid;
    state.selectedDriverName = driver?.name || "";
    state.records = [];
    state.expenses = [];
    state.closures = [];
    state.pendingClosure = null;
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
    if (!state.db || !isAdmin()) return [];
    const collections = ["choferes", "usuarios"];
    const map = new Map();
    for (const name of collections) {
      try {
        const snap = await getDocs(query(collection(state.db, name), limit(200)));
        snap.forEach(item => {
          const data = item.data() || {};
          const role = safe(data.role || data.rol || data.tipo).toLowerCase();
          const uid = safe(data.uid || data.driverUid || data.choferUid || item.id);
          const driverName = safe(data.nombre || data.nombreCompleto || data.displayName || data.name || data.email || uid);
          if (!uid || /admin/.test(role)) return;
          map.set(uid, { uid, id:item.id, name:driverName, role });
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

  async function getScopedDocs(collectionName, uid) {
    const fields = ["driverUid", "choferUid", "uid", "ownerUid"];
    const map = new Map();
    for (const field of fields) {
      try {
        const snap = await getDocs(query(collection(state.db, collectionName), where(field, "==", uid), limit(250)));
        snap.forEach(docSnap => map.set(docSnap.id, { id:docSnap.id, ...docSnap.data() }));
        if (map.size) break;
      } catch (_) {}
    }
    return Array.from(map.values());
  }

  function listenCollection(collectionName, targetArray, uid) {
    try {
      return onSnapshot(scopedQuery(collectionName, uid), snap => {
        state[targetArray] = snap.docs.map(d => ({ id:d.id, ...d.data() }));
        render();
      }, error => {
        console.warn(`EXPLORA_PAY_LISTENER_${collectionName}`, error?.code || error?.message);
      });
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
        state.records = [];
        state.expenses = [];
        state.closures = [];
        state.pendingClosure = null;
        render();
        console.info("EXPLORA_PAY_REALTIME", VERSION, reason, "admin-waiting-driver");
        return;
      }
    }
    const unsubs = [
      listenCollection("billing_records", "records", uid),
      listenCollection("gastos", "expenses", uid),
      listenCollection("cierres_semanales", "closures", uid)
    ].filter(Boolean);
    state.unsubscribers.push(...unsubs);
    console.info("EXPLORA_PAY_REALTIME", VERSION, reason, uid || "no-driver");
  }

  function closureCutMs(row = {}) {
    return Math.max(
      Number(row.cutoffAtMs || 0), Number(row.requestedAtMs || 0), Number(row.driverUploadedAtMs || 0), Number(row.confirmedAtMs || 0),
      ms(row.cutoffAt), ms(row.requestedAt), ms(row.driverUploadedAt), ms(row.confirmedAt), ms(row.closedAt), rowMs(row)
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
    const target = activeClosureKind(kind);
    if (!target) return null;
    const pending = state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => {
        const rowKind = closureKindOf(row);
        if (target === "caja_chica") return rowKind === "caja_chica";
        if (target === "gastos") return rowKind === "gastos";
        if (isBillingClosureKind(target)) return isBillingClosureKind(rowKind);
        return rowKind === target;
      })
      .filter(row => {
        if (isAdmin() && !uid) return false;
        return !uid || [row.driverUid,row.choferUid,row.uid].map(safe).includes(uid);
      })
      .filter(row => !/confirmed|completed|closed|cerrado|al_dia|al día|pagado|cancelled|canceled|anulado|rechazado/i.test(safe(row.status || row.estado)))
      .sort((a,b)=>rowMs(b)-rowMs(a));
    return pending[0] || null;
  }

  function pendingClosureRows(uid = getDriverUid()) {
    const rows = state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => !/confirmed|completed|closed|cerrado|al_dia|al día|pagado|cancelled|canceled|anulado|rechazado/i.test(safe(row.status || row.estado)))
      .filter(row => closureActionForViewer(row) !== "none")
      .sort((a,b)=>rowMs(b)-rowMs(a));
    const unique = new Map();
    for (const row of rows) unique.set(safe(row.id || `${closureKindOf(row)}_${rowMs(row)}`), row);
    return Array.from(unique.values());
  }

  function closureResultText(closure = {}) {
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    const kind = activeClosureKind(closureKindOf(closure));
    if (due > 0) return kind === "caja_chica" ? `Chofer pasa caja chica a Explora ${currency(due)}` : `Chofer paga a Explora ${currency(due)}`;
    if (toDriver > 0) return kind === "gastos" ? `Explora reintegra al chofer ${currency(toDriver)}` : `Explora paga al chofer ${currency(toDriver)}`;
    return "Cierre equilibrado";
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
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const proof = closureHasProof(closure);
    if (/confirmed|confirmado|completed|closed|cerrado|al_dia|al día|pagado/.test(status)) return "Cierre completo";
    if (proof && due > 0) return "Comprobante recibido";
    if (proof && toDriver > 0) return "Comprobante enviado";
    if (due > 0) return "Falta comprobante del chofer";
    if (toDriver > 0) return "Falta comprobante de Explora";
    return "Cierre solicitado";
  }

  function closureIsCompleted(closure = {}) {
    const status = safe(closure.status || closure.estado || closure.statusLabel).toLowerCase();
    return /confirmed|confirmado|completed|closed|cerrado|al_dia|al día|pagado/.test(status);
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
    const requestedByRole = safe(closure.requestedByRole || closure.solicitadoPorRol || closure.requestedRole).toLowerCase();
    const requestedByUid = safe(closure.requestedByUid || closure.solicitadoPorUid || closure.createdByUid);
    const ownUid = safe(state.user?.uid || getOwnDriverUid());
    if (isAdmin()) {
      if (requestedByRole === "admin" || requestedByUid === ownUid) return "none";
      if (toDriver > 0 && !proof) return "admin_upload";
      if (due > 0 && proof) return "admin_review";
      return "view";
    }
    const driverUid = getOwnDriverUid();
    const rowUids = [closure.driverUid, closure.choferUid, closure.uid, closure.ownerUid].map(safe);
    if (!rowUids.includes(driverUid)) return "none";
    if (requestedByRole !== "admin" && requestedByUid !== "admin") return "none";
    if (requestedByUid && requestedByUid === driverUid) return "none";
    if (due > 0 && !proof) return "driver_upload";
    if (toDriver > 0 && proof) return "driver_review";
    if (toDriver > 0 && !proof) return "driver_waiting_admin";
    return "view";
  }

  function renderBellBadge() {
    const badge = $("payBellBadge");
    if (!badge) return;
    const count = pendingClosureRows(getDriverUid()).length;
    badge.hidden = count < 1;
    badge.textContent = count > 9 ? "9+" : String(count);
    const bell = $("payBellBtn");
    if (bell) bell.setAttribute("aria-label", count ? `Notificaciones de cierres: ${count} pendiente${count === 1 ? "" : "s"}` : "Notificaciones de cierres");
  }

  function renderNotificationsScreen() {
    const list = $("payNotificationList");
    if (!list) return;
    const rows = pendingClosureRows(getDriverUid());
    if (!rows.length) {
      list.innerHTML = `<div class="pay-notification-empty">No tenés cierres pendientes.</div>`;
      return;
    }
    list.innerHTML = rows.map(row => {
      const kind = closureKindOf(row) || "gastos";
      const action = closureActionForViewer(row);
      let title = isAdmin() && safe(row.requestedByRole) !== "admin" ? "Chofer pidió el cierre" : "Explora pidió el cierre";
      if (action === "admin_review") title = "Chofer envió comprobante";
      if (action === "driver_review") title = "Explora envió comprobante";
      const subtitle = `${closureTitle(kind)} · ${closureResultText(row)}`;
      const status = action === "driver_upload" || action === "admin_upload" ? "Cargar comprobante" : action === "admin_review" ? "Revisar comprobante" : action === "driver_review" ? "Ver comprobante" : "Ver detalle";
      return `<button class="pay-notification-row" data-pay-notification-closure="${esc(row.id)}" type="button">
        <span class="pay-notification-icon">${notificationIcon(kind)}</span>
        <span class="pay-notification-copy"><strong>${esc(title)}</strong><small>Resolvé tu situación</small><em>${esc(subtitle)}</em></span>
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
    const closure = state.closures.find(row => safe(row.id) === safe(id));
    if (!closure) return;
    showPayView("inicio");
    const kind = closureKindOf(closure) || state.tab;
    openClosureModal(isAdmin() ? "admin-review" : "confirm", closure, kind);
  }

  function computeSummary({ records = state.records, expenses = state.expenses, closures = state.closures } = {}) {
    // Nuevo modo: Chofer y Explora son dos vistas del mismo cierre de facturación.
    // El corte de cualquiera de los dos corta toda la facturación: efectivo + digital.
    const resetBillingMs = lastBillingClosureMs(closures);
    const resetExpensesMs = lastClosureMs(closures, "gastos");
    const resetCashboxMs = lastClosureMs(closures, "caja_chica");

    const billingRecords = records.filter(row => rowMs(row) > resetBillingMs).sort((a,b)=>rowMs(b)-rowMs(a));
    const cashRecords = billingRecords.filter(row => methodOf(row) === "cash");
    const exploraRecords = billingRecords.filter(row => methodOf(row) !== "cash");
    // Caja chica es módulo independiente y SOLO se genera por cobros en efectivo.
    // Cobros digitales (transferencia/QR/tarjeta) no generan ni descuentan caja chica.
    const cashboxRecords = records.filter(row => rowMs(row) > resetCashboxMs && methodOf(row) === "cash").sort((a,b)=>rowMs(b)-rowMs(a));
    const cashboxCashRecords = cashboxRecords;
    const cashboxExploraRecords = [];
    const filteredExpenses = expenses.filter(row => rowMs(row) > resetExpensesMs).sort((a,b)=>rowMs(b)-rowMs(a));

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

    const tabs = {
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
      records:billingRecords, billingRecords, cashRecords, exploraRecords, expenses:filteredExpenses, tabs,
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
      amountToDriverForBilling, amountFromDriverForBilling, billingNetToDriver
    };
  }

  function tabSummary(summary = computeSummary(), kind = state.tab) {
    return summary.tabs?.[activeClosureKind(kind)] || summary.tabs?.caja_chica || summary;
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

    const pending = pendingClosureFor(getDriverUid(), target);
    if (pending) {
      // Si ya existe un cierre pedido, no se habilita un nuevo pedido desde la tarjeta.
      // La acción pendiente se resuelve desde la campana/notificación o desde el detalle del cierre.
      if (target === "chofer" || target === "explora" || target === "facturacion") return { visible:true, enabled:false, pending:true };
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
      // El chofer nunca pide su propio cierre de facturación desde su módulo.
      // El botón debe quedar visible, con el mismo texto, pero bloqueado/transparente.
      return { visible:true, enabled:false };
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
      if (target === "chofer") throw new Error("El cierre de facturación no corresponde al chofer en este momento.");
      if (target === "explora") throw new Error("El cierre de facturación no corresponde a Explora en este momento.");
      throw new Error("Este módulo no tiene cierre disponible en este momento.");
    }
  }

  function movementRows(summary = computeSummary()) {
    const rows = [];
    // Última actividad debe ser global e igual en todos los módulos:
    // cobros + caja chica automática + gastos + cierres, sin filtrar por pestaña.
    const paymentRows = summary.billingRecords || summary.records || [];
    const cashboxRows = summary.cashboxRecords || [];
    const expenseRows = summary.expenses || [];

    for (const row of paymentRows || []) {
      const amount = amountOf(row), method = methodOf(row), at = rowMs(row);
      if (!(amount > 0)) continue;
      const cashbox = method === "cash" ? amount * .05 : 0;
      rows.push({
        at, type:"payment", title:`${dateShort(at)} · ${paymentLabel(method)}`,
        meta:safe(row.description || row.detalle || row.notes || row.ruta || "Servicio registrado"),
        detail: method === "cash"
          ? `Cobró el chofer en efectivo: ${currency(amount)} · caja chica separada ${currency(cashbox)}`
          : `Cobró Explora: ${currency(amount)} · no genera caja chica`,
        amount, positive:true
      });
    }

    for (const row of cashboxRows || []) {
      const amount = amountOf(row), at = rowMs(row);
      if (!(amount > 0)) continue;
      const cashbox = amount * .05;
      rows.push({
        at: at + 1, type:"cashbox", title:`${dateShort(at)} · Caja chica 5%`,
        meta:safe(row.description || row.detalle || row.notes || row.ruta || "Generada automáticamente por cobro efectivo"),
        detail:`Caja chica generada solo por efectivo: la tiene el chofer y debe pasarla a Explora`,
        amount:-cashbox, negative:true
      });
    }

    for (const row of expenseRows || []) {
      const at = rowMs(row);
      const { amount, driverPart, exploraPart } = expenseParts(row);
      if (!(amount > 0)) continue;
      rows.push({
        at, type:"expense", title:`${dateShort(at)} · ${expenseTypeLabel(row)}`,
        meta:safe(row.notes || row.descripcion || row.description || "Gasto operativo"),
        detail: `Gasto cargado por el chofer: ${currency(amount)} · Explora reintegra ${currency(exploraPart)} · Parte chofer ${currency(driverPart)}`,
        amount:-amount, negative:true
      });
    }

    for (const row of state.closures.filter(r => safe(r.closureMode || r.periodType) === "on_demand").filter(closureIsCompleted)) {
      const at = rowMs(row);
      const closureKind = closureKindOf(row);
      rows.push({
        at, type:"closure", closureId:safe(row.id || row.closureId), tone:closurePayerClass(row), title:`${dateShort(at)} · ${closureTitle(closureKind)}`,
        meta:closureStatusText(row),
        detail:`A rendir: ${currency(row.amountDueFromDriver || 0)} · A cobrar: ${currency(row.amountDueToDriver || 0)}`,
        amount:0
      });
    }
    return rows.sort((a,b)=>b.at-a.at).slice(0,12);
  }

  function render() {
    installShell();
    const summary = computeSummary();
    state.latestSummary = summary;
    state.pendingClosure = pendingClosureFor(getDriverUid(), state.tab);
    document.querySelectorAll("[data-pay-tab]").forEach(button => {
      const active = button.dataset.payTab === state.tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    const greeting = $("payGreeting");
    if (greeting) greeting.textContent = isAdmin() ? (state.selectedDriverName ? `Chofer, ${displayName()}` : "Seleccionar chofer") : `Hola, ${displayName()}`;
    renderAdminDriverPicker();
    renderMainCard(summary);
    renderClosureStatus(summary);
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
    if (due > 0) return `Chofer debe pagar ${currency(due)}`;
    if (toDriver > 0) return activeClosureKind(closureKindOf(closure)) === "gastos" ? `Explora reintegra ${currency(toDriver)}` : `Explora paga ${currency(toDriver)}`;
    return "Sin diferencia";
  }

  function renderMainCard(summary) {
    const amount = $("payMainAmount"), subtitle = $("payMainSubtitle"), pillLabel = $("payPillLabel"), pillAmount = $("payPillAmount"), extra = $("payExtraLines");
    if (!amount || !subtitle || !pillLabel || !pillAmount || !extra) return;
    const lines = [];
    const pending = isClosureTab(state.tab) ? pendingClosureFor(getDriverUid(), state.tab) : null;
    if (isAdmin() && !getDriverUid()) {
      amount.textContent = currency(0);
      subtitle.innerHTML = "Seleccioná un chofer para cargar sus datos abiertos.";
      pillLabel.textContent = "Sin chofer seleccionado";
      pillAmount.textContent = currency(0);
      extra.innerHTML = `<div><span>Administrador</span><strong>Seleccionar chofer</strong></div>`;
      return;
    }
    let main = summary.cashboxTotal, sub = "Caja chica automática 5%", pill = "Caja chica", pillValue = 0;
    if (activeClosureKind(state.tab) === "caja_chica") {
      const t = tabSummary(summary, "caja_chica");
      main = t.cashboxTotal || 0;
      sub = pending ? "Caja chica nueva desde el cierre pendiente" : "Caja chica 5% desde el último cierre";
      pill = t.amountFromDriver > 0 ? "Chofer debe pasar a Explora" : "Caja chica ya está en Explora";
      pillValue = t.amountFromDriver || 0;
      lines.push(
        ["Efectivo base", currency(t.gross || 0)],
        ["Caja chica 5% efectivo", currency(t.cashboxInDriver || 0)],
        ["Total caja chica", currency(t.cashboxTotal || 0)]
      );
    } else if (state.tab === "gastos") {
      const t = tabSummary(summary, "gastos");
      main = t.expenseTotal;
      sub = pending ? "Gastos nuevos desde el cierre pendiente" : "Solo gastos desde el último cierre de gastos";
      pill = t.netSettlementToDriver > 0 ? "Explora reintegra al chofer" : t.netSettlementToDriver < 0 ? "Chofer reconoce a Explora" : "Gastos equilibrados";
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
      sub = pending ? "Digital nuevo desde el cierre pendiente" : "Facturación digital completa, sin caja chica";
      pill = t.amountToDriver > 0 ? "Explora paga al chofer" : t.amountFromDriver > 0 ? "Chofer paga a Explora" : "Facturación equilibrada";
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
      sub = pending ? "Efectivo nuevo desde el cierre pendiente" : "Facturación en efectivo completa";
      pill = t.amountToDriver > 0 ? "Explora paga al chofer" : t.amountFromDriver > 0 ? "Chofer paga a Explora" : "Facturación equilibrada";
      pillValue = Math.max(t.amountToDriver, t.amountFromDriver);
      lines.push(
        ["Efectivo cobrado", currency(summary.cashGrossInDriver || 0)],
        ["Digital de Explora", currency(summary.nonCashInExplora)],
        ["Total facturado", currency(summary.gross)],
        ["Parte de cada uno 50%", currency(summary.billingShareEach)]
      );
    } else {
      main = summary.cashboxTotal || 0;
      sub = "Caja chica 5% desde el último cierre";
      pill = summary.cashboxInDriver > 0 ? "Chofer debe pasar a Explora" : "Caja chica ya está en Explora";
      pillValue = summary.cashboxInDriver || 0;
      lines.push(
        ["Efectivo base", currency(summary.cashboxGross || 0)],
        ["Caja chica 5% efectivo", currency(summary.cashboxInDriver || 0)]
      );
    }
    // Si hay un cierre pendiente, el período nuevo ya arranca desde cero por el corte.
    // No se muestran montos anteriores en la tarjeta principal para evitar mezclar cierre viejo con movimientos nuevos.
    amount.textContent = currency(main);
    subtitle.innerHTML = `${esc(sub)} <b>${tabSummary(summary, state.tab).resetMs ? "desde último cierre" : "sin cierre previo"}</b>`;
    pillLabel.textContent = pill;
    pillAmount.textContent = currency(pillValue);
    extra.innerHTML = lines.map(([label,value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
  }

  function renderClosureStatus(summary) {
    const box = $("payClosureStatus"), text = $("payClosureStatusText"), action = $("payClosureActionBtn"), quick = $("payQuickClosureBtn");
    const kind = activeClosureKind(state.tab);
    const stateForButton = closureButtonState(kind, summary);
    if (action) {
      action.hidden = !stateForButton.visible;
      action.disabled = !stateForButton.enabled;
      action.classList.toggle("is-closure-ready", !!stateForButton.enabled);
      action.classList.toggle("is-closure-locked", stateForButton.visible && !stateForButton.enabled);
      const label = stateForButton.visible ? closureLabel(kind) : "";
      action.querySelector("span").innerHTML = `Pedir cierre<br/>${esc(label)}`;
    }
    if (quick) {
      quick.hidden = !stateForButton.visible || !stateForButton.enabled;
      quick.disabled = !stateForButton.enabled;
    }
    if (!box || !text) return;
    const pending = stateForButton.visible ? pendingClosureFor(getDriverUid(), kind) : null;
    state.pendingClosure = pending;
    const pendingAction = pending ? closureActionForViewer(pending) : "none";
    const showPendingCard = !!pending
      && !closureHasProof(pending)
      && !closureIsCompleted(pending)
      && ["driver_upload", "admin_upload"].includes(pendingAction);
    box.hidden = !showPendingCard;
    if (showPendingCard) {
      const labelEl = box.querySelector("b");
      if (labelEl) labelEl.textContent = closureStatusText(pending);
      const due = number(pending.amountDueFromDriver || 0);
      const toDriver = number(pending.amountDueToDriver || 0);
      const pk = activeClosureKind(closureKindOf(pending));
      text.textContent = `${closureTitle(closureKindOf(pending))} · ${due > 0 ? (pk === "caja_chica" ? `caja chica por ${currency(due)}` : `transferencia por ${currency(due)}`) : toDriver > 0 ? `Explora debe pagar ${currency(toDriver)}` : "sin diferencia"}`;
    }
  }

  function activityIcon(type) {
    if (type === "expense" || type === "cashbox") return `<svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg>`;
    if (type === "closure") return `<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path></svg>`;
    return `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>`;
  }

  function renderActivities(summary) {
    const list = $("payActivityList");
    if (!list) return;
    const rows = movementRows(summary);
    if (!rows.length) { list.innerHTML = `<div class="pay-activity-empty">Todavía no hay cobros ni gastos en el ciclo abierto.</div>`; return; }
    list.innerHTML = rows.map(row => {
      const closureAttr = row.type === "closure" && row.closureId ? ` data-pay-activity-closure="${esc(row.closureId)}" role="button" tabindex="0"` : "";
      const closureTone = row.type === "closure" ? ` ${esc(row.tone || "")}` : "";
      return `<article class="pay-activity ${row.type === "closure" ? "is-clickable" : ""}${closureTone}"${closureAttr}>
        <span class="pay-activity-icon">${activityIcon(row.type)}</span>
        <div><div class="pay-activity-title">${esc(row.title)}</div><div class="pay-activity-meta">${esc(row.meta)}</div><div class="pay-activity-detail">${esc(row.detail)}</div></div>
        <strong class="pay-activity-amount ${row.positive ? "is-positive" : row.negative ? "is-negative" : ""}">${row.amount ? (row.amount > 0 ? "+" : "") + currency(row.amount) : ""}</strong>
      </article>`;
    }).join("");
  }

  async function computeDriverSummary(uid) {
    const [records, expenses, closures] = await Promise.all([
      getScopedDocs("billing_records", uid),
      getScopedDocs("gastos", uid),
      getScopedDocs("cierres_semanales", uid)
    ]);
    return computeSummary({ records, expenses, closures });
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
    state.modalClosure = closure || pendingClosureFor(getDriverUid(), resolvedKind) || null;
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
    state.modalKind = "";
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
    const driver = safe(closure.driverName || closure.choferNombre || closure.nombreChofer || "Chofer");
    const kindLabel = closureTitle(kind);
    const k = activeClosureKind(kind);
    const result = due > 0 ? (k === "caja_chica" ? "Chofer pasa caja chica a Explora" : "Chofer paga a Explora") : toDriver > 0 ? (k === "gastos" ? "Explora reintegra al chofer" : "Explora paga al chofer") : "Cierre equilibrado";
    const amount = Math.max(due, toDriver);
    const base = [
      ["Motivo", "Explora pidió el cierre"],
      ["Chofer", driver],
      ["Tipo de cierre", kindLabel],
      ["Corte", cut],
      ["Estado", status],
      [result, currency(amount)]
    ];
    const detail = k === "caja_chica"
      ? [["Efectivo base", currency(closure.cashboxGross || gross)], ["Caja chica total 5%", currency(closure.cashboxTotal || closure.mainTotal || amount)], ["En poder del chofer", currency(closure.cashboxInDriver || due)]]
      : k === "gastos"
        ? [["Gastos incluidos", currency(expenseTotal)], ["Parte chofer 50%", currency(expenseTotal * .5)], ["Parte Explora 50%", currency(toDriver || expenseTotal * .5)]]
        : [["Efectivo chofer", currency(cash)], ["Digital Explora", currency(digital)], ["Total facturado", currency(gross)], ["Parte de cada uno", currency(share)]];
    const receiptUrl = closureProofUrl(closure);
    const receipt = receiptUrl ? [["Comprobante", "cargado"]] : [];
    const rows = base.concat(detail, [["Estado", closureStatusText(closure)]], receipt).map(([label,value]) => `<article><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("");
    const receiptLink = receiptUrl ? `<a class="pay-closure-receipt-link" href="${esc(receiptUrl)}" target="_blank" rel="noopener">Abrir comprobante</a>` : "";
    const alert = due > 0 && !receiptUrl && !adminView ? `<div class="pay-closure-alert">Para quedar al día, cargá el comprobante de transferencia.</div>` : "";
    return rows + receiptLink + alert;
  }

  function renderClosureModal() {
    renderDriverSelect();
    const title = $("payClosureTitle"), subtitle = $("payClosureSubtitle"), summary = $("payClosureSummary"), fileField = $("payClosureFileField"), submit = $("payClosureSubmit"), cancel = $("payClosureCancel");
    const actions = submit?.closest(".pay-closure-actions");
    if (!title || !subtitle || !summary || !fileField || !submit || !cancel) return;
    const closure = state.modalClosure;
    const kind = closureKindOf(closure || {}) || activeClosureKind(state.modalKind || state.tab) || "gastos";
    const latest = tabSummary(state.latestSummary || computeSummary(), kind);
    fileField.hidden = true;
    cancel.textContent = "Cancelar";
    cancel.hidden = false;
    submit.hidden = false;
    if (actions) actions.hidden = false;
    submit.className = "pay-closure-primary";
    submit.disabled = false;

    if (closure) {
      const action = closureActionForViewer(closure);
      const due = number(closure.amountDueFromDriver || 0);
      const toDriver = number(closure.amountDueToDriver || 0);
      const proof = closureHasProof(closure);
      const completed = closureIsCompleted(closure);
      const uploadNeeded = (action === "driver_upload" || action === "admin_upload") && !proof && !completed;
      fileField.hidden = !uploadNeeded;
      summary.innerHTML = closureDetailSummary(closure, kind, isAdmin());
      const noSubmitNeeded = (completed || proof) && !["admin_review", "driver_review"].includes(action);
      if (noSubmitNeeded) {
        submit.hidden = true;
        cancel.textContent = "Cerrar";
      }

      if (state.modalMode === "confirm") {
        title.textContent = "Explora pidió el cierre";
        if (action === "driver_upload") {
          subtitle.textContent = "Resolvé tu situación: transferí a Explora y cargá el comprobante.";
          submit.disabled = false;
          submit.textContent = "Subir comprobante";
        } else if (action === "driver_review") {
          subtitle.textContent = "Explora cargó el comprobante. Revisalo y confirmá recibido.";
          submit.disabled = false;
          submit.textContent = "Confirmar recibido";
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
          subtitle.textContent = "El chofer pidió el cierre. Pagá y cargá el comprobante para notificarlo.";
          submit.disabled = false;
          submit.textContent = "Enviar comprobante";
        } else if (action === "admin_review") {
          subtitle.textContent = "El chofer cargó el comprobante. Confirmá si la foto está correcta.";
          submit.disabled = false;
          submit.textContent = "Confirmar cierre";
        } else {
          subtitle.textContent = completed ? "Cierre completo." : proof ? "Comprobante cargado. No corresponde subir otro comprobante." : "Esperando comprobante de quien debe pagar.";
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
    if (kind === "caja_chica") {
      summary.innerHTML = `<article><span>Efectivo base</span><strong>${currency(latest.gross || 0)}</strong></article><article><span>Caja chica 5%</span><strong>${currency(latest.cashboxTotal || 0)}</strong></article><article><span>En poder del chofer</span><strong>${currency(latest.cashboxInDriver || 0)}</strong></article><article><span>Chofer pasa a Explora</span><strong>${currency(latest.amountFromDriver || 0)}</strong></article>`;
    } else if (kind === "gastos") {
      summary.innerHTML = `<article><span>Gastos cargados</span><strong>${currency(latest.expenseTotal || 0)}</strong></article><article><span>Parte chofer</span><strong>${currency(latest.driverExpenseShare || 0)}</strong></article><article><span>Parte Explora</span><strong>${currency(latest.exploraExpenseShare || 0)}</strong></article><article><span>Explora reintegra</span><strong>${currency(latest.amountToDriver || 0)}</strong></article>`;
    } else {
      summary.innerHTML = `<article><span>Efectivo chofer</span><strong>${currency(latest.cashInDriver || 0)}</strong></article><article><span>Digital Explora</span><strong>${currency(latest.nonCashInExplora || 0)}</strong></article><article><span>Total facturado</span><strong>${currency(latest.gross || 0)}</strong></article><article><span>Parte de cada uno</span><strong>${currency(latest.billingShareEach || 0)}</strong></article><article><span>Resultado</span><strong>${latest.amountFromDriver > 0 ? `Chofer paga ${currency(latest.amountFromDriver)}` : latest.amountToDriver > 0 ? `Explora paga ${currency(latest.amountToDriver)}` : "Equilibrado"}</strong></article>`;
    }
  }

  async function submitClosureModal() {
    if (state.busy) return;
    state.busy = true;
    setModalMessage("Procesando…");
    const submit = $("payClosureSubmit");
    const oldText = submit?.textContent || "Aceptar";
    if (submit) submit.textContent = "Procesando…";
    try {
      if (state.modalMode === "confirm" && state.modalClosure) await driverConfirmClosure(state.modalClosure);
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
    const pending = pendingClosureFor(targetUid, kind);
    if (pending) throw new Error(`Ese chofer ya tiene un ${closureTitle(kind).toLowerCase()} pendiente.`);
    const fullSummary = isAdmin() ? await computeDriverSummary(targetUid) : (state.latestSummary || computeSummary());
    requireClosureAllowed(kind, fullSummary);
    const summary = tabSummary(fullSummary, kind);
    const cutoffAtMs = Date.now();
    const recordIds = (summary.records || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const expenseIds = (summary.expenses || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const payload = {
      closureMode:"on_demand",
      periodType:"on_demand",
      closureKind:kind,
      closureType:kind,
      payTab:kind,
      billingClosure:isBillingClosureKind(kind),
      billingResetGroup:isBillingClosureKind(kind) ? "facturacion" : "",
      affectsTabs:isBillingClosureKind(kind) ? ["chofer", "explora", "facturacion"] : [kind],
      status:"requested",
      estado:"solicitado",
      statusLabel:`${closureTitle(kind)} solicitado`,
      driverUid:targetUid,
      choferUid:targetUid,
      uid:targetUid,
      driverName:targetName,
      requestedByUid:user.uid,
      requestedByName:isAdmin() ? accountName() : displayName(),
      requestedByRole:isAdmin() ? "admin" : "driver",
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
      amountDueFromDriver:Number(summary.amountFromDriver || 0),
      amountDueToDriver:Number(summary.amountToDriver || 0),
      includedBillingIds:recordIds,
      includedExpenseIds:expenseIds,
      includedCount:Number(recordIds.length + expenseIds.length),
      cycleStartedAtMs:Number(summary.resetMs || 0),
      cutoffAtMs,
      requestedAtMs:cutoffAtMs,
      requestedAt:serverTimestamp(),
      createdAt:serverTimestamp(),
      updatedAt:serverTimestamp(),
      version:VERSION
    };
    const created = await addDoc(collection(state.db, "cierres_semanales"), payload);
    state.closures = [{ ...payload, id:created.id, createdAtMs:cutoffAtMs, updatedAtMs:cutoffAtMs }, ...state.closures.filter(row => row.id !== created.id)];
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

  async function driverConfirmClosure(closure) {
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const proof = closureHasProof(closure);
    let receipt = null;
    if (due > 0 && !proof) receipt = await uploadClosureReceipt(closure, state.modalFile);
    const ref = doc(state.db, "cierres_semanales", closure.id);
    if (due > 0 && !proof) {
      await updateDoc(ref, {
        status:"driver_uploaded",
        estado:"comprobante_cargado",
        statusLabel:"Comprobante cargado por chofer",
        receiptUrl:receipt?.url || null,
        receiptPath:receipt?.path || null,
        receiptUploadedBy:"driver",
        receiptUploadedAt:serverTimestamp(),
        receiptUploadedAtMs:Date.now(),
        driverUploadedAt:serverTimestamp(),
        driverUploadedAtMs:Date.now(),
        updatedAt:serverTimestamp()
      });
      return;
    }
    if (toDriver > 0 && proof) {
      await updateDoc(ref, {
        status:"confirmed",
        estado:"confirmado",
        statusLabel:"Comprobante recibido por chofer",
        confirmedByUid:state.auth?.currentUser?.uid || "",
        confirmedByName:displayName(),
        confirmedAt:serverTimestamp(),
        confirmedAtMs:Date.now(),
        updatedAt:serverTimestamp()
      });
      return;
    }
    await updateDoc(ref, {
      status:"driver_viewed",
      estado:"visto_por_chofer",
      statusLabel:"Visto por chofer",
      driverViewedAt:serverTimestamp(),
      driverViewedAtMs:Date.now(),
      updatedAt:serverTimestamp()
    });
  }

  async function adminSubmitClosure(closure) {
    if (!closure?.id) throw new Error("No se pudo identificar el cierre.");
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const proof = closureHasProof(closure);
    if (toDriver > 0 && !proof) {
      const receipt = await uploadClosureReceipt(closure, state.modalFile);
      await updateDoc(doc(state.db, "cierres_semanales", closure.id), {
        status:"admin_uploaded",
        estado:"comprobante_explora_cargado",
        statusLabel:"Comprobante enviado por Explora",
        receiptUrl:receipt?.url || null,
        receiptPath:receipt?.path || null,
        receiptUploadedBy:"admin",
        receiptUploadedAt:serverTimestamp(),
        receiptUploadedAtMs:Date.now(),
        adminUploadedAt:serverTimestamp(),
        adminUploadedAtMs:Date.now(),
        updatedAt:serverTimestamp()
      });
      return;
    }
    if (due > 0 && proof) {
      await adminConfirmClosure(closure);
      return;
    }
    if (toDriver > 0 && proof) {
      await updateDoc(doc(state.db, "cierres_semanales", closure.id), {
        status:"confirmed",
        estado:"confirmado",
        statusLabel:"Cierre confirmado por Explora",
        confirmedByUid:state.auth?.currentUser?.uid || "",
        confirmedByName:accountName(),
        confirmedAt:serverTimestamp(),
        confirmedAtMs:Date.now(),
        updatedAt:serverTimestamp()
      });
      return;
    }
    throw new Error("Todavía falta el comprobante correspondiente.");
  }

  async function adminConfirmClosure(closure) {
    if (!closure?.id) throw new Error("No se pudo identificar el cierre.");
    await updateDoc(doc(state.db, "cierres_semanales", closure.id), {
      status:"confirmed",
      estado:"confirmado",
      statusLabel:"Cierre confirmado por Explora",
      confirmedByUid:state.auth?.currentUser?.uid || "",
      confirmedByName:accountName(),
      confirmedAt:serverTimestamp(),
      confirmedAtMs:Date.now(),
      updatedAt:serverTimestamp()
    });
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
    render();
    startRealtime("session");
  }

  async function boot() {
    try {
      installShell(); bindShell();
      await waitFirebase();
      onAuthStateChanged(state.auth, user => refreshSession(user));
      window.addEventListener("explora:session-opened", () => refreshSession(state.auth?.currentUser));
      window.addEventListener("explora:auth-cleared", () => { clearListeners(); state.user = null; });
      setTimeout(() => refreshSession(state.auth?.currentUser), 1200);
    } catch (error) {
      console.warn("EXPLORA_PAY_BOOT", error?.message || error);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once:true });
  else boot();
  window.ExploraPagoHome = Object.freeze({ version:VERSION, render, openClosureModal, computeSummary });
})();
