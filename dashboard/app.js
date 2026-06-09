const state = {
  busy: false,
  events: [],
};

let adminToken =
  new URLSearchParams(location.search).get("adminToken") ||
  localStorage.getItem("gatewayAdminToken") ||
  "change-me-admin-token";
localStorage.setItem("gatewayAdminToken", adminToken);

const $ = (id) => document.getElementById(id);
const fmt = (value, suffix = "") =>
  value === null || value === undefined
    ? "—"
    : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 })}${suffix}`;
const short = (value) =>
  value && String(value).length > 18
    ? `${String(value).slice(0, 10)}…${String(value).slice(-8)}`
    : value || "—";

$("adminTokenInput").value = adminToken;
$("saveAdminToken").addEventListener("click", () => {
  adminToken = $("adminTokenInput").value.trim();
  localStorage.setItem("gatewayAdminToken", adminToken);
  refreshOverview().catch(renderOverviewError);
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw apiError(response.status, body, text);
  }
  return body;
}

async function publicApi(path) {
  const response = await fetch(path);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw apiError(response.status, body, text);
  return body;
}

function apiError(status, body, fallbackText) {
  const error = body?.error;
  const code = error?.code ?? body?.error ?? "API_ERROR";
  const message = error?.message ?? body?.message ?? fallbackText;
  return new Error(`${status} ${code}: ${message}`);
}

async function refreshOverview() {
  const [
    metrics,
    settlements,
    intents,
    events,
    withdrawals,
    pendingSettlements,
  ] = await Promise.all([
    api("/admin/gateway-metrics"),
    api("/admin/recent-settlements?limit=8"),
    api("/admin/recent-intents?limit=8"),
    api("/admin/recent-events?limit=8"),
    api("/admin/pending-withdrawals"),
    api("/admin/pending-settlements"),
  ]);

  renderMetrics(metrics);
  renderList("recentSettlements", settlements, renderSettlementItem);
  renderList("recentIntents", intents, renderIntentItem);
  renderList("recentEvents", events, renderEventItem);
  renderList("pendingWithdrawalsList", withdrawals, renderWithdrawalItem);
  renderList(
    "pendingSettlementsList",
    pendingSettlements,
    renderPendingSettlementItem,
  );
}

function renderMetrics(metrics) {
  $("chainId").textContent = metrics.chainId;
  $("vaultAddress").textContent =
    metrics.vaultAddress ?? "Deploy contracts first";
  $("operatorAddress").textContent = metrics.operatorAddress ?? "—";
  $("indexerStatus").textContent =
    `${metrics.indexer.enabled ? "enabled" : "disabled"} / ${metrics.indexer.status}`;
  $("lastProcessedBlock").textContent =
    metrics.indexer.lastProcessedBlock ?? "—";
  $("indexerLagBlocks").textContent =
    metrics.indexer.lagBlocks === null ||
    metrics.indexer.lagBlocks === undefined
      ? "—"
      : `${metrics.indexer.lagBlocks} blocks`;
  $("storageStatus").textContent =
    `${metrics.storage.driver} · ${metrics.storage.status}${metrics.storage.path ? ` · ${metrics.storage.path}` : ""}`;
  $("insuranceBalance").textContent = fmt(
    metrics.collateral.insuranceBalance,
    " mUSDC",
  );
  $("totalLiabilities").textContent = fmt(
    metrics.collateral.totalLiabilities,
    " mUSDC",
  );
  $("totalUserCollateral").textContent = fmt(
    metrics.collateral.totalUserCollateral,
    " mUSDC",
  );
  $("totalUsers").textContent = metrics.collateral.totalUsers;
  $("pendingWithdrawalsCount").textContent =
    metrics.operations.pendingWithdrawals;
  $("pendingSettlementsCount").textContent =
    metrics.operations.pendingSettlements;
  $("openPositionsCount").textContent = metrics.tradingExample.openPositions;
  $("reconOk").textContent = metrics.reconciliationSummary.OK ?? 0;
  $("reconWarning").textContent = metrics.reconciliationSummary.WARNING ?? 0;
  $("reconMismatch").textContent = metrics.reconciliationSummary.MISMATCH ?? 0;
}

function renderOverviewError(error) {
  for (const id of [
    "recentSettlements",
    "recentIntents",
    "recentEvents",
    "pendingWithdrawalsList",
    "pendingSettlementsList",
  ]) {
    $(id).innerHTML =
      `<div class="list-item error-text">${escapeHtml(error.message)}</div>`;
  }
}

function renderList(id, items, renderItem) {
  const element = $(id);
  if (!items.length) {
    element.innerHTML = '<div class="list-item muted">No records.</div>';
    return;
  }
  element.innerHTML = items.map(renderItem).join("");
}

function renderSettlementItem(settlement) {
  return `<div class="list-item">
    <strong>${escapeHtml(settlement.settlementType)}</strong>
    <span>${escapeHtml(short(settlement.settlementId))}</span>
    <small>${escapeHtml(settlement.appId)} · ${fmt(settlement.amountDelta, " mUSDC")} · ${escapeHtml(settlement.status)}</small>
  </div>`;
}

function renderIntentItem(intent) {
  return `<div class="list-item">
    <strong>${escapeHtml(intent.intentType)}</strong>
    <span>${escapeHtml(short(intent.id))}</span>
    <small>${escapeHtml(intent.appId)} · ${escapeHtml(intent.status)} · ${escapeHtml(short(intent.userAddress))}</small>
  </div>`;
}

function renderEventItem(event) {
  return `<div class="list-item">
    <strong>${escapeHtml(event.eventName)}</strong>
    <span>${escapeHtml(short(event.transactionHash))}</span>
    <small>block ${escapeHtml(event.blockNumber ?? "—")} · ${escapeHtml(short(event.userAddress))}</small>
  </div>`;
}

function renderWithdrawalItem(withdrawal) {
  return `<div class="list-item">
    <strong>${escapeHtml(short(withdrawal.userAddress))}</strong>
    <span>${fmt(withdrawal.amount, " mUSDC")}</span>
    <small>${escapeHtml(withdrawal.status)}</small>
  </div>`;
}

function renderPendingSettlementItem(settlement) {
  return `<div class="list-item">
    <strong>${escapeHtml(settlement.settlementType)}</strong>
    <span>${fmt(settlement.amountDelta, " mUSDC")}</span>
    <small>${escapeHtml(settlement.pendingReason)} · ${escapeHtml(short(settlement.userAddress))}</small>
  </div>`;
}

async function loadSettlementReport() {
  const settlementId = $("settlementIdInput").value.trim();
  if (!settlementId) return;
  $("settlementReport").textContent = "Loading...";
  try {
    const report = await publicApi(
      `/settlements/${encodeURIComponent(settlementId)}/report`,
    );
    $("settlementReport").textContent = JSON.stringify(
      {
        settlementId: report.settlementId,
        amountDelta: report.amountDelta,
        reasonHash: report.reasonHash,
        status: report.status,
        txHash: report.onChain?.txHash,
        blockNumber: report.onChain?.blockNumber,
        linkedSignedIntents: report.linkedSignedIntents,
        audit: report.audit,
      },
      null,
      2,
    );
  } catch (error) {
    $("settlementReport").textContent = error.message;
  }
}

async function loadReconciliation() {
  const userAddress = $("reconciliationAddressInput").value.trim();
  if (!userAddress) return;
  $("reconciliationReport").textContent = "Loading...";
  try {
    const report = await api(
      `/admin/reconciliation/${encodeURIComponent(userAddress)}`,
    );
    $("reconciliationStatus").innerHTML =
      `<span class="status-pill ${statusClass(report.status)}">${escapeHtml(report.status)}</span>`;
    $("reconciliationReport").textContent = JSON.stringify(
      {
        userAddress: report.userAddress,
        onChainBalance: report.onChainBalance,
        offChainBalance: report.offChainBalance,
        pendingRealizedPnl: report.pendingRealizedPnl,
        pendingWithdraw: report.pendingWithdraw,
        onChainPendingWithdraw: report.onChainPendingWithdraw,
        openPositions: report.openPositions,
        detectedIssues: report.detectedIssues,
        ts: report.ts,
      },
      null,
      2,
    );
  } catch (error) {
    $("reconciliationStatus").innerHTML = "";
    $("reconciliationReport").textContent = error.message;
  }
}

async function loadTradingMarket() {
  try {
    const quote = await publicApi("/examples/trading/market/BTC-USD");
    $("btcPrice").textContent = fmt(quote.price, " USD");
  } catch (error) {
    $("btcPrice").textContent = error.message;
  }
}

async function loadTradingPortfolio() {
  const userAddress = $("tradingUserInput").value.trim();
  if (!userAddress) return;
  $("tradingPortfolio").textContent = "Loading...";
  try {
    const portfolio = await publicApi(
      `/portfolio/${encodeURIComponent(userAddress)}`,
    );
    $("tradingPortfolio").textContent = JSON.stringify(
      {
        userAddress: portfolio.userAddress,
        collateral: portfolio.collateral,
        equity: portfolio.equity,
        marginUsed: portfolio.marginUsed,
        freeCollateral: portfolio.freeCollateral,
        pendingSettlementPnl: portfolio.pendingSettlementPnl,
        positions: portfolio.positions,
        trades: portfolio.trades.slice(-5),
      },
      null,
      2,
    );
  } catch (error) {
    $("tradingPortfolio").textContent = error.message;
  }
}

async function loadDemoState() {
  $("demoState").textContent = "Loading...";
  try {
    const demo = await api("/demo/state");
    $("demoState").textContent = JSON.stringify(demo, null, 2);
    if (demo.selectedWallet && !$("tradingUserInput").value) {
      $("tradingUserInput").value = demo.selectedWallet;
    }
  } catch (error) {
    $("demoState").textContent =
      `${error.message}\n\nDemo routes are disabled unless ENABLE_DEMO_ROUTES=true.`;
  }
}

async function runDemoAction(name) {
  if (state.busy) return;
  state.busy = true;
  setButtonsDisabled(true);
  $("lastAction").textContent = `Running ${name}...`;
  try {
    const result = await api(`/demo/${name}`, { method: "POST", body: "{}" });
    $("lastAction").textContent = JSON.stringify(
      {
        action: result.action,
        message: result.message,
        txHash: result.txHash,
        orderId: result.order?.orderId,
        tradeId: result.trade?.tradeId,
        settlementId: result.settlement?.settlementId,
        reasonHash: result.settlement?.reasonHash,
        withdrawalId: result.withdrawal?.withdrawalId,
      },
      null,
      2,
    );
    $("demoState").textContent = JSON.stringify(result.state, null, 2);
    pushEvent({ type: `demo:${name}`, payload: { message: result.message } });
    setTimeout(() => refreshOverview().catch(renderOverviewError), 1200);
  } catch (error) {
    $("lastAction").textContent =
      `${error.message}\n\nDemo routes require ENABLE_DEMO_ROUTES=true and a valid admin token.`;
  } finally {
    state.busy = false;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll("button[data-action]").forEach((button) => {
    button.disabled = disabled;
  });
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);
  ws.addEventListener("open", () => {
    $("connectionStatus").textContent = "Connected";
    $("connectionStatus").className = "status-pill connected";
  });
  ws.addEventListener("close", () => {
    $("connectionStatus").textContent = "Disconnected";
    $("connectionStatus").className = "status-pill error";
    setTimeout(connectWebSocket, 2000);
  });
  ws.addEventListener("error", () => {
    $("connectionStatus").textContent = "Error";
    $("connectionStatus").className = "status-pill error";
  });
  ws.addEventListener("message", (event) => {
    try {
      const parsed = JSON.parse(event.data);
      pushEvent(parsed);
      if (
        [
          "portfolio:updated",
          "price:update",
          "settlement:confirmed",
          "chain:deposited",
          "chain:withdrawn",
        ].includes(parsed.type)
      ) {
        refreshOverview().catch(renderOverviewError);
        loadTradingMarket().catch(console.error);
      }
    } catch {
      pushEvent({ type: "raw", payload: event.data });
    }
  });
}

function pushEvent(event) {
  state.events.push({ ...event, at: new Date().toLocaleTimeString() });
  state.events = state.events.slice(-80);
  $("eventFeed").innerHTML = state.events
    .map(
      (item) => `
    <div class="event">
      <strong>${escapeHtml(item.type)}</strong>
      <small>${escapeHtml(item.at)}</small>
      <pre>${escapeHtml(JSON.stringify(compactPayload(item.payload), null, 2))}</pre>
    </div>
  `,
    )
    .join("");
}

function compactPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const clone = { ...payload };
  for (const key of [
    "orders",
    "trades",
    "settlements",
    "positions",
    "reports",
  ]) {
    if (Array.isArray(clone[key])) clone[key] = `[${clone[key].length} items]`;
  }
  return clone;
}

function statusClass(status) {
  if (status === "OK") return "connected";
  if (status === "WARNING") return "warning";
  return "error";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".tab")
        .forEach((button) => button.classList.remove("active"));
      document
        .querySelectorAll(".tab-panel")
        .forEach((panel) => panel.classList.remove("active"));
      tab.classList.add("active");
      $(tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "overview")
        refreshOverview().catch(renderOverviewError);
      if (tab.dataset.tab === "trading")
        loadTradingMarket().catch(console.error);
    });
  });
}

wireTabs();
$("loadSettlementReport").addEventListener("click", loadSettlementReport);
$("loadReconciliation").addEventListener("click", loadReconciliation);
$("loadTradingPortfolio").addEventListener("click", loadTradingPortfolio);
$("submitReferenceOrder").addEventListener("click", () => {
  $("tradingPortfolio").textContent =
    "Static operator console does not sign user orders. Use POST /examples/trading/orders with a wallet-signed TRADING_ORDER intent, or run the Demo Walkthrough.";
});
$("loadDemoState").addEventListener("click", loadDemoState);
document.querySelectorAll("button[data-action]").forEach((button) => {
  button.addEventListener("click", () => runDemoAction(button.dataset.action));
});

refreshOverview().catch(renderOverviewError);
loadTradingMarket().catch(console.error);
connectWebSocket();
setInterval(() => refreshOverview().catch(renderOverviewError), 7000);
