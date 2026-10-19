"use strict";

importScripts("shared.js");

var ticking = false;
var pollPromise = null;
var commitToken = 0;
var claimLock = false;
var DASHBOARD = DA.DASHBOARD;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function getState() {
  var stored = await chrome.storage.local.get(null);
  return Object.assign({}, DA.DEFAULTS, stored);
}

async function getClaim() {
  var data = await chrome.storage.local.get("claim");
  var claim = data.claim || null;
  if (!claim) return null;
  if (Date.now() - claim.startedAt > 120000) {
    await chrome.storage.local.set({ claim: null });
    return null;
  }
  return claim;
}

async function setClaim(claim) {
  await chrome.storage.local.set({ claim: claim });
}

async function logEvent(text) {
  var state = await getState();
  var log = Array.isArray(state.log) ? state.log.slice(-24) : [];
  log.push({ t: Date.now(), text: text });
  await chrome.storage.local.set({ log: log, lastEvent: text });
}

async function ensureOffscreen() {
  if (!chrome.offscreen) return;
  var has = false;
  try { has = await chrome.offscreen.hasDocument(); } catch (err) { has = false; }
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Keep the refresh and Triton notification timers running while the service worker is suspended."
    });
  } catch (err) {
    if (!/exists|single offscreen/i.test(String(err))) {
      await logEvent("Timer document failed: " + (err && err.message ? err.message : err));
    }
  }
}

async function cancelDashboardTimers() {
  var tabs = await chrome.tabs.query({ url: "https://app.dataannotation.tech/workers/projects*" });
  await Promise.all(tabs.map(function (tab) {
    return chrome.tabs.sendMessage(tab.id, { type: "cancelRefresh" }).catch(function () {});
  }));
}

async function ensureDashboardTab() {
  var tabs = await chrome.tabs.query({ url: "https://app.dataannotation.tech/workers/projects*" });
  if (tabs.length) return tabs.find(function (tab) { return tab.active; }) || tabs[0];
  var any = await chrome.tabs.query({ url: "https://app.dataannotation.tech/*" });
  if (any.length) {
    await chrome.tabs.update(any[0].id, { url: DASHBOARD });
    return any[0];
  }
  return chrome.tabs.create({ url: DASHBOARD, active: true });
}

async function kickNow(mode) {
  var state = await getState();
  if (mode === "normal" && !DA.active(state)) return;
  await chrome.storage.local.set({
    pendingMode: mode,
    nextReloadAt: Date.now() + 60000
  });
  var existing = await chrome.tabs.query({ url: "https://app.dataannotation.tech/workers/projects*" });
  if (existing.length) {
    var tab = existing.find(function (item) { return item.active; }) || existing[0];
    try { await chrome.tabs.reload(tab.id); }
    catch (err) { await chrome.tabs.update(tab.id, { url: DASHBOARD }); }
  } else {
    await ensureDashboardTab();
  }
  await logEvent(mode === "triton" ? "Notification received. Refreshing for Triton." : "Refreshing the dashboard.");
}

async function armIfActive() {
  var state = await getState();
  if (!DA.active(state)) return;
  var delayMs = DA.randomDelayMs(state.refreshSeconds);
  await chrome.storage.local.set({ nextReloadAt: Date.now() + delayMs });
  var tabs = await chrome.tabs.query({ url: "https://app.dataannotation.tech/workers/projects*" });
  await Promise.all(tabs.map(function (tab) {
    return chrome.tabs.sendMessage(tab.id, { type: "armRefresh", delayMs: delayMs }).catch(function () {});
  }));
}

async function maybeQueueHandoff(notificationId) {
  if (!notificationId) return;
  var state = await getState();
  if (!state.running || DA.active(state)) return;
  var times = DA.nextWindow(state.startHour, state.startMinute, state.endHour, state.endMinute);
  await chrome.storage.local.set({
    pendingHandoff: {
      notification_id: notificationId,
      start_time: times.start,
      end_time: times.end
    },
    pendingNotificationId: null
  });
  await logEvent("Will report this Triton notification on the next server check.");
}

async function focusDashboard(tabId) {
  if (!tabId) return;
  try { await chrome.tabs.update(tabId, { active: true }); } catch (err) {}
}

async function failClaim(reason) {
  if (claimLock) return;
  claimLock = true;
  try {
  var claim = await getClaim();
  if (!claim || claim.phase === "done" || claim.phase === "failed" || claim.phase === "closing") return;
  claim.phase = "failed";
  await setClaim(claim);
  commitToken += 1;
  if (claim.tabId && claim.tabId !== claim.dashboardTabId) {
    try { await chrome.tabs.remove(claim.tabId); } catch (err) {}
  }
  await focusDashboard(claim.dashboardTabId);
  await setClaim(null);
  var detail = reason === "redirected-to-dashboard"
    ? "Claim failed (returned to the dashboard). Waiting for the next refresh."
    : reason === "no-tab"
      ? "Claim failed (no new tab). Waiting for the next refresh."
      : "Claim failed (" + reason + "). Waiting for the next refresh.";
  await logEvent(detail);
  if (claim.meta && claim.meta.fromNotification) await maybeQueueHandoff(claim.meta.notificationId);
  await armIfActive();
  } finally {
    claimLock = false;
  }
}

async function sendClaimEmail(meta) {
  var state = await getState();
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 8000);
  try {
    var res = await fetch("https://www.hehehe1012.com/da-dashboard-refresher/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({
        name: state.accountName || "",
        project_name: meta.name || "",
        rate: meta.rateLabel || "none",
        claimed_time: DA.jstStamp(new Date())
      })
    });
    if (!res.ok) throw new Error("Server responded " + res.status);
    await logEvent("Claim email requested.");
  } finally {
    clearTimeout(timer);
  }
}

async function notifyTriton() {
  var state = await getState();
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 8000);
  try {
    var res = await fetch("https://www.hehehe1012.com/da-dashboard-refresher/notify-triton", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({
        name: state.accountName || "",
        time: DA.jstStamp(new Date())
      })
    });
    if (!res.ok) throw new Error("Server responded " + res.status);
    await logEvent("Triton notification sent.");
  } finally {
    clearTimeout(timer);
  }
}

async function finalizeSuccess() {
  if (claimLock) return;
  claimLock = true;
  try {
  var claim = await getClaim();
  if (!claim || claim.phase === "done" || claim.phase === "failed" || claim.phase === "closing") return;
  claim.phase = "closing";
  await setClaim(claim);
  var meta = claim.meta || {};
  var dashboardTabId = claim.dashboardTabId;
  if (claim.tabId) {
    try { await chrome.tabs.remove(claim.tabId); } catch (err) {}
  }
  await focusDashboard(dashboardTabId);
  await cancelDashboardTimers();
  var patch = {
    running: false,
    pendingMode: null,
    nextReloadAt: 0,
    claim: null,
    pendingNotificationId: null
  };
  if (meta.fromNotification) patch.pendingHandoff = null;
  await chrome.storage.local.set(patch);
  await logEvent("Paused. Claimed " + (meta.name || "a project") + ".");
  try {
    await sendClaimEmail(meta);
  } catch (err) {
    await logEvent("Claim email failed: " + (err && err.message ? err.message : err));
  }
  if (meta.isTriton && !meta.fromNotification) {
    try { await notifyTriton(); }
    catch (err) { await logEvent("Triton notify failed: " + (err && err.message ? err.message : err)); }
  }
  } finally {
    claimLock = false;
  }
}

async function scheduleCommitSuccess() {
  var claim = await getClaim();
  if (!claim || claim.phase === "done" || claim.phase === "failed" || claim.phase === "closing") return;
  claim.phase = "confirming";
  await setClaim(claim);
  var token = ++commitToken;
  var tabId = claim.tabId;
  await sleep(3000);
  if (token !== commitToken) return;
  claim = await getClaim();
  if (!claim || claim.phase !== "confirming" || claim.tabId !== tabId) return;
  var tab;
  try { tab = await chrome.tabs.get(tabId); } catch (err) { return; }
  if (DA.isDashboardUrl(tab.url || "")) {
    await failClaim("redirected-to-dashboard");
    return;
  }
  await finalizeSuccess();
}

function sameProject(opened, expected) {
  try {
    var a = new URL(opened);
    var b = new URL(expected);
    if (a.origin !== b.origin) return false;
    var projectId = b.searchParams.get("project_id");
    if (projectId && a.searchParams.get("project_id") === projectId) return true;
    return a.pathname === b.pathname && a.search === b.search;
  } catch (err) {
    return false;
  }
}

async function prepareClaim(msg, sender) {
  if (await getClaim()) return { ok: false, error: "busy" };
  var before = (await chrome.tabs.query({})).map(function (tab) { return tab.id; });
  var claim = {
    phase: "opening",
    tabId: null,
    dashboardTabId: sender.tab ? sender.tab.id : null,
    before: before,
    startedAt: Date.now(),
    meta: {
      name: msg.project.name,
      url: msg.project.url,
      rate: msg.project.rate,
      rateLabel: msg.project.rateLabel || "none",
      isTriton: DA.isTritonName(msg.project.name),
      fromNotification: !!msg.fromNotification,
      notificationId: msg.notificationId || null
    }
  };
  await setClaim(claim);
  await chrome.storage.local.set({ nextReloadAt: Date.now() + 90000 });
  await logEvent("Opening " + claim.meta.name + ".");
  return { ok: true };
}

async function claimClickFinished() {
  await sleep(1500);
  var claim = await getClaim();
  if (!claim || claim.phase === "failed" || claim.phase === "done" || claim.phase === "closing") {
    return { ok: false };
  }
  if (claim.tabId) return { ok: true, tabId: claim.tabId };
  var tabs = await chrome.tabs.query({});
  var before = {};
  (claim.before || []).forEach(function (id) { before[id] = true; });
  var fresh = tabs.filter(function (tab) { return !before[tab.id]; });
  var chosen = fresh.find(function (tab) { return sameProject(tab.url || "", claim.meta.url); })
    || fresh.find(function (tab) { return DA.isTaskUrl(tab.url || ""); })
    || null;
  var dash = tabs.find(function (tab) { return tab.id === claim.dashboardTabId; });
  if (!chosen && dash && DA.isTaskUrl(dash.url || "")) {
    chosen = dash;
    var created = await chrome.tabs.create({ url: DASHBOARD, active: false });
    claim.dashboardTabId = created.id;
  }
  if (!chosen) {
    await failClaim("no-tab");
    return { ok: false };
  }
  claim.tabId = chosen.id;
  claim.phase = "opened";
  await setClaim(claim);
  try { await chrome.tabs.update(chosen.id, { active: true }); } catch (err) {}
  return { ok: true, tabId: chosen.id };
}

async function onTaskPageReady(msg, sender) {
  var claim = await getClaim();
  if (!claim || claim.phase === "failed" || claim.phase === "done" || claim.phase === "closing") {
    return { ignore: true, activeClaim: false };
  }
  var tabId = sender.tab && sender.tab.id;
  var url = msg.url || (sender.tab && sender.tab.url) || "";
  if (!tabId || !DA.isTaskUrl(url)) return { activeClaim: false };
  if (claim.tabId && claim.tabId !== tabId) return { activeClaim: false };
  if (!claim.tabId) {
    var known = (claim.before || []).indexOf(tabId) !== -1;
    if (known && tabId !== claim.dashboardTabId) return { activeClaim: false };
    if (known && tabId === claim.dashboardTabId) {
      var created = await chrome.tabs.create({ url: DASHBOARD, active: false });
      claim.dashboardTabId = created.id;
    }
    claim.tabId = tabId;
    claim.phase = "opened";
    await setClaim(claim);
  }
  return { activeClaim: true };
}

async function onDashboardReady(sender) {
  var state = await getState();
  var claim = state.claim && (Date.now() - state.claim.startedAt < 120000) ? state.claim : null;
  var tabId = sender.tab && sender.tab.id;
  var tabUrl = (sender.tab && sender.tab.url) || "";

  if (claim && tabId && claim.tabId === tabId && DA.isDashboardUrl(tabUrl)) {
    await failClaim("redirected-to-dashboard");
    return { mode: "ignore" };
  }
  if (claim && tabId && claim.phase !== "failed" && claim.phase !== "done" && claim.phase !== "closing" && tabId !== claim.tabId) {
    return { mode: "idle", nextReloadMs: null };
  }

  var mode = state.pendingMode === "triton" ? "triton" : state.pendingMode === "normal" ? "normal" : "idle";
  var active = DA.active(state);
  var nextReloadMs = mode === "idle" || !active ? null : DA.randomDelayMs(state.refreshSeconds);
  var patch = { pendingMode: null };
  if (mode === "normal" || mode === "triton") patch.nextReloadAt = Date.now() + 60000;
  else if (!active) patch.nextReloadAt = 0;
  await chrome.storage.local.set(patch);
  return {
    mode: mode,
    nextReloadMs: nextReloadMs,
    notificationId: state.pendingNotificationId || null,
    settings: {
      searchProjects: state.searchProjects || [],
      excludeProjects: state.excludeProjects || [],
      rateFilterEnabled: !!state.rateFilterEnabled,
      minRate: state.minRate
    }
  };
}

async function refreshAccountName() {
  var tabs = await chrome.tabs.query({ url: "https://app.dataannotation.tech/*" });
  for (var i = 0; i < tabs.length; i++) {
    try {
      var response = await chrome.tabs.sendMessage(tabs[i].id, { type: "readAccountName" });
      if (response && response.name) {
        await chrome.storage.local.set({ accountName: response.name });
        return response.name;
      }
    } catch (err) {}
  }
  var state = await getState();
  return state.accountName || "";
}

async function applyAutoStart(deferKick) {
  var state = await getState();
  var parts = DA.jstParts(new Date());
  var startHour = Number(parts.hour);
  var startMinute = Number(parts.minute);
  var endHour = Number(state.endHour);
  var endMinute = DA.clampMinute(state.endMinute);
  if (startHour === endHour && startMinute === endMinute) {
    endMinute += 1;
    if (endMinute >= 60) {
      endMinute = 0;
      endHour = (endHour + 1) % 24;
    }
  }
  await chrome.storage.local.set({
    startHour: startHour,
    startMinute: startMinute,
    endHour: endHour,
    endMinute: endMinute,
    running: true
  });
  await logEvent("Schedule start is now " + DA.pad(startHour) + ":" + DA.pad(startMinute) + " JST. Auto refresh is running.");
  if (!deferKick) await kickNow("normal");
}

async function poll() {
  var state = await getState();
  if (DA.active(state)) return;
  await chrome.storage.local.set({ lastPollAt: Date.now() });
  var name = await refreshAccountName();
  state = await getState();
  var payload = { name: name || state.accountName || "" };
  var handoff = state.pendingHandoff;
  if (handoff && handoff.notification_id) {
    payload.notification_id = handoff.notification_id;
    payload.start_time = handoff.start_time;
    payload.end_time = handoff.end_time;
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 8000);
  var response;
  try {
    response = await fetch("https://www.hehehe1012.com/da-dashboard-refresher/get-triton-notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return;
  } finally {
    clearTimeout(timer);
  }
  var data = {};
  try { data = await response.json(); } catch (err) { data = {}; }
  if (!response.ok) return;
  if (payload.notification_id) await chrome.storage.local.set({ pendingHandoff: null });
  var flag = data.flag === true || data.flag === "true";
  var autoStart = data.auto_refresh_start === true || data.auto_refresh_start === "true";
  if (autoStart) await applyAutoStart(flag);
  if (flag) {
    await chrome.storage.local.set({ pendingNotificationId: data.notification_id || null });
    await kickNow("triton");
  }
}

async function maybePoll(state) {
  if (DA.active(state)) return;
  var interval = Math.max(1, Number(state.listenSeconds) || 10) * 1000;
  if (Date.now() - (Number(state.lastPollAt) || 0) < interval) return;
  if (pollPromise) return;
  pollPromise = poll().finally(function () { pollPromise = null; });
  await pollPromise;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await ensureOffscreen();
    var state = await getState();
    var claim = await getClaim();
    var active = DA.active(state);
    if (claim) return;
    if (!active) {
      if (state.pendingMode !== "triton") {
        if (state.nextReloadAt) {
          await cancelDashboardTimers();
          await chrome.storage.local.set({ nextReloadAt: 0 });
        }
        await maybePoll(await getState());
      }
      return;
    }
    state = await getState();
    if (!state.nextReloadAt || state.nextReloadAt < Date.now() - 8000) await kickNow("normal");
  } finally {
    ticking = false;
  }
}

async function onTabUpdated(tabId, info, tab) {
  var claim = await getClaim();
  if (!claim || claim.phase === "failed" || claim.phase === "done" || claim.phase === "closing") return;
  var url = info.url || tab.url || "";
  if (claim.dashboardTabId === tabId && info.url && DA.isTaskUrl(info.url) && !claim.tabId) {
    var created = await chrome.tabs.create({ url: DASHBOARD, active: false });
    claim.tabId = tabId;
    claim.dashboardTabId = created.id;
    claim.phase = "opened";
    await setClaim(claim);
    return;
  }
  if (claim.tabId === tabId && DA.isDashboardUrl(url)) await failClaim("redirected-to-dashboard");
}

async function onTabRemoved(tabId) {
  var claim = await getClaim();
  if (!claim || claim.tabId !== tabId) return;
  if (claim.phase === "done" || claim.phase === "failed" || claim.phase === "closing") return;
  var meta = claim.meta;
  await setClaim(null);
  commitToken += 1;
  await logEvent("Claim tab closed before the task was confirmed.");
  if (meta && meta.fromNotification) await maybeQueueHandoff(meta.notificationId);
  await armIfActive();
}

async function clearServerCheckNoise() {
  var state = await getState();
  var log = Array.isArray(state.log) ? state.log.filter(function (entry) {
    return String(entry && entry.text || "").indexOf("Server check failed") !== 0;
  }) : [];
  var patch = {};
  if (!Array.isArray(state.log) || log.length !== state.log.length) patch.log = log;
  if (String(state.lastEvent || "").indexOf("Server check failed") === 0) {
    patch.lastEvent = state.running ? "Running. Waiting for the JST window." : "Paused.";
  }
  if (patch.log || patch.lastEvent) await chrome.storage.local.set(patch);
}

function setup() {
  chrome.alarms.create("watchdog", { periodInMinutes: 0.5 });
  ensureOffscreen();
  clearServerCheckNoise();
  tick();
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.alarms.onAlarm.addListener(function () { tick(); });
chrome.tabs.onUpdated.addListener(function (tabId, info, tab) { onTabUpdated(tabId, info, tab); });
chrome.tabs.onRemoved.addListener(function (tabId) { onTabRemoved(tabId); });

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  onMessage(msg || {}, sender).then(sendResponse, function (error) {
    sendResponse({ ok: false, error: String(error && error.message || error) });
  });
  return true;
});

async function onMessage(msg, sender) {
  if (msg.type === "tick") {
    await tick();
    return { ok: true };
  }
  if (msg.type === "start") {
    await chrome.storage.local.set({ running: true });
    await logEvent("Running. Waiting for the JST window.");
    await tick();
    return { ok: true };
  }
  if (msg.type === "pause") {
    await chrome.storage.local.set({ running: false, pendingMode: null, nextReloadAt: 0 });
    await cancelDashboardTimers();
    await logEvent("Paused.");
    return { ok: true };
  }
  if (msg.type === "accountName") {
    if (msg.name) await chrome.storage.local.set({ accountName: msg.name });
    return { ok: true };
  }
  if (msg.type === "note") {
    if (msg.text) await logEvent(msg.text);
    return { ok: true };
  }
  if (msg.type === "dashboardReady") return onDashboardReady(sender);
  if (msg.type === "prepareClaim") return prepareClaim(msg, sender);
  if (msg.type === "claimClickFinished") return claimClickFinished();
  if (msg.type === "taskPageReady") return onTaskPageReady(msg, sender);
  if (msg.type === "claimResult") {
    if (msg.ok) await scheduleCommitSuccess();
    else await failClaim(msg.reason || "failed");
    return { ok: true };
  }
  if (msg.type === "tritonAttemptDone") {
    if (msg.outcome === "in-progress") {
      await logEvent("Triton is already in progress.");
      return { ok: true };
    }
    var state = await getState();
    await maybeQueueHandoff(state.pendingNotificationId);
    await logEvent("No Triton task grabbed.");
    return { ok: true };
  }
  if (msg.type === "armRefresh") {
    if (msg.delayMs) await chrome.storage.local.set({ nextReloadAt: Date.now() + Number(msg.delayMs) });
    return { ok: true };
  }
  if (msg.type === "aboutToReload") {
    var current = await getState();
    if (!DA.active(current)) return { ok: false };
    await chrome.storage.local.set({ pendingMode: "normal", nextReloadAt: Date.now() + 60000 });
    return { ok: true };
  }
  return { ok: false };
}

setup();
