"use strict";

var refreshTimer = null;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function send(message) {
  return new Promise(function (resolve) {
    try {
      chrome.runtime.sendMessage(message, function (response) {
        var err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(response);
      });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
    }
  });
}

function textOf(el) {
  return ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
}

function queryAll(root, selector) {
  return Array.prototype.slice.call((root || document).querySelectorAll(selector));
}

function findProjectsTab(root) {
  var tabs = queryAll(root, '[role="tab"]');
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    var id = tab.id || "";
    var controls = tab.getAttribute("aria-controls") || "";
    if (id.slice(-13) === "-tab-projects" || controls.slice(-18) === "-tabpanel-projects") return tab;
    var label = textOf(tab);
    if (/^projects(\s|$)/i.test(label)) return tab;
  }
  return null;
}

function headingMatches(el, title) {
  var text = textOf(el);
  return text === title || text.indexOf(title + " ") === 0;
}

function tableForHeading(root, title) {
  var nodes = queryAll(root, "h1, h2, h3, table");
  var start = -1;
  for (var i = 0; i < nodes.length; i++) {
    if (/^H[123]$/.test(nodes[i].tagName) && headingMatches(nodes[i], title)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  for (var j = start + 1; j < nodes.length; j++) {
    if (nodes[j].tagName === "TABLE") return nodes[j];
    if (/^H[123]$/.test(nodes[j].tagName)) return null;
  }
  return null;
}

function parsePay(cell) {
  var text = textOf(cell);
  var match = text.match(/\$\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?\s*\/\s*hr/i);
  if (!match) return { rate: null, rateLabel: "none" };
  var label = match[0].replace(/\s+/g, "");
  var rate = parseFloat(label.replace(/[^0-9.]/g, ""));
  if (!isFinite(rate)) return { rate: null, rateLabel: "none" };
  return { rate: rate, rateLabel: label };
}

function parseTable(table) {
  if (!table) return [];
  var rows = queryAll(table, "tbody tr");
  if (!rows.length) rows = queryAll(table, "tr");
  var projects = [];
  for (var i = 0; i < rows.length; i++) {
    var link = rows[i].querySelector('a[href*="/workers/tasks"]');
    if (!link) continue;
    var pay = parsePay(rows[i].querySelector('td[data-column-id="pay"]'));
    projects.push({
      name: textOf(link),
      url: link.href,
      rate: pay.rate,
      rateLabel: pay.rateLabel
    });
  }
  return projects;
}

function extractDashboard(root) {
  root = root || document;
  var tab = findProjectsTab(root);
  var selected = !!(tab && tab.getAttribute("aria-selected") === "true");
  if (!selected) {
    return { projectsTabSelected: false, inProgress: [], available: [] };
  }
  return {
    projectsTabSelected: true,
    inProgress: parseTable(tableForHeading(root, "In Progress Tasks")),
    available: parseTable(tableForHeading(root, "Projects"))
  };
}

function readAccountName(root) {
  root = root || document;
  var anchors = queryAll(root, 'a.dropdown-toggle[data-toggle="dropdown"]');
  for (var i = 0; i < anchors.length; i++) {
    var text = textOf(anchors[i]);
    if (text && text.length < 80) return text;
  }
  return "";
}

DA.extractDashboard = extractDashboard;
DA.readAccountName = readAccountName;

function publishAccountName() {
  var name = readAccountName(document);
  if (name) send({ type: "accountName", name: name });
  return name;
}

function armLocal(delayMs) {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  if (!delayMs) return;
  refreshTimer = setTimeout(function () {
    send({ type: "aboutToReload" }).then(function (res) {
      if (res && res.ok) location.reload();
    });
  }, delayMs);
}

function clickInNewTab(anchor) {
  anchor.setAttribute("target", "_blank");
  anchor.click();
}

async function startClaim(project, fromNotification, notificationId) {
  var prepared = await send({
    type: "prepareClaim",
    project: project,
    fromNotification: !!fromNotification,
    notificationId: notificationId || null
  });
  if (!prepared || !prepared.ok) return false;
  var links = queryAll(document, 'a[href*="/workers/tasks"]');
  var link = null;
  for (var i = 0; i < links.length; i++) {
    if (links[i].href === project.url) {
      link = links[i];
      break;
    }
  }
  if (link) clickInNewTab(link);
  var finished = await send({ type: "claimClickFinished" });
  return !!(finished && finished.ok);
}

function findIntendButton() {
  var buttons = document.querySelectorAll("button");
  for (var i = 0; i < buttons.length; i++) {
    if (textOf(buttons[i]) === "I intend to complete this task!") return buttons[i];
  }
  return null;
}

async function runButtonFlow() {
  var deadline = Date.now() + 8000;
  var clickedEnter = false;
  var clickedIntend = false;
  while (Date.now() < deadline) {
    if (DA.isDashboardUrl(location.href)) {
      await send({ type: "claimResult", ok: false, reason: "redirected-to-dashboard" });
      return;
    }
    var enter = document.getElementById("enterWorkModeButton");
    if (enter && !clickedEnter && !enter.disabled) {
      enter.click();
      clickedEnter = true;
    }
    var intend = findIntendButton();
    if (intend && !clickedIntend && !intend.disabled) {
      intend.click();
      clickedIntend = true;
      break;
    }
    await sleep(200);
  }
  var grace = Date.now() + (clickedEnter || clickedIntend ? 2500 : 400);
  while (Date.now() < grace) {
    if (DA.isDashboardUrl(location.href)) {
      await send({ type: "claimResult", ok: false, reason: "redirected-to-dashboard" });
      return;
    }
    if (!clickedIntend) {
      var late = findIntendButton();
      if (late && !late.disabled) {
        late.click();
        clickedIntend = true;
      }
    }
    await sleep(200);
  }
  if (DA.isDashboardUrl(location.href)) {
    await send({ type: "claimResult", ok: false, reason: "redirected-to-dashboard" });
    return;
  }
  await send({ type: "claimResult", ok: true });
}

async function waitForProjectsTab() {
  var deadline = Date.now() + 15000;
  var stable = 0;
  var last = "";
  while (Date.now() < deadline) {
    var tab = findProjectsTab(document);
    if (tab && tab.getAttribute("aria-selected") === "true") return tab;
    var sig = tab ? "no" : "missing";
    stable = sig === last ? stable + 1 : 0;
    last = sig;
    if (tab && stable >= 4) return tab;
    await sleep(250);
  }
  return findProjectsTab(document);
}

async function waitForProjectRows() {
  var deadline = Date.now() + 12000;
  var stable = 0;
  var last = "";
  while (Date.now() < deadline) {
    var tab = findProjectsTab(document);
    if (tab && tab.getAttribute("aria-selected") !== "true") return false;
    var table = tableForHeading(document, "Projects");
    if (table) {
      var count = table.querySelectorAll("tbody tr").length;
      var sig = String(count);
      if (count > 0) return true;
      stable = sig === last ? stable + 1 : 0;
      last = sig;
      if (stable >= 4) return true;
    }
    await sleep(250);
  }
  return true;
}

async function onDashboard() {
  publishAccountName();
  var plan = await send({ type: "dashboardReady" });
  if (!plan || !plan.mode || plan.mode === "ignore" || plan.mode === "idle") {
    if (plan && plan.nextReloadMs) armLocal(plan.nextReloadMs);
    return;
  }

  var tab = await waitForProjectsTab();
  if (!tab || tab.getAttribute("aria-selected") !== "true") {
    if (plan.mode === "triton") {
      await send({ type: "tritonAttemptDone", outcome: "no-projects-tab" });
    } else {
      await send({ type: "note", text: "Projects tab is not active. Waiting for the next refresh." });
    }
    if (plan.nextReloadMs) {
      await send({ type: "armRefresh", delayMs: plan.nextReloadMs });
      armLocal(plan.nextReloadMs);
    }
    return;
  }

  await waitForProjectRows();
  var extracted = extractDashboard(document);

  if (plan.mode === "triton") {
    var inProgress = extracted.inProgress.some(function (project) {
      return DA.isTritonName(project.name);
    });
    if (inProgress) {
      await send({ type: "tritonAttemptDone", outcome: "in-progress" });
      if (plan.nextReloadMs) {
        await send({ type: "armRefresh", delayMs: plan.nextReloadMs });
        armLocal(plan.nextReloadMs);
      }
      return;
    }
    var triton = null;
    for (var i = 0; i < extracted.available.length; i++) {
      if (DA.isTritonName(extracted.available[i].name)) {
        triton = extracted.available[i];
        break;
      }
    }
    if (!triton) {
      await send({ type: "tritonAttemptDone", outcome: "not-found" });
      if (plan.nextReloadMs) {
        await send({ type: "armRefresh", delayMs: plan.nextReloadMs });
        armLocal(plan.nextReloadMs);
      }
      return;
    }
    var grabbed = await startClaim(triton, true, plan.notificationId);
    if (!grabbed && plan.nextReloadMs) {
      await send({ type: "armRefresh", delayMs: plan.nextReloadMs });
      armLocal(plan.nextReloadMs);
    }
    return;
  }

  var hit = DA.pickProject(extracted.available, plan.settings || {});
  if (!hit) {
    await send({ type: "note", text: "No matching project. Waiting for the next refresh." });
    if (plan.nextReloadMs) {
      await send({ type: "armRefresh", delayMs: plan.nextReloadMs });
      armLocal(plan.nextReloadMs);
    }
    return;
  }
  var claimed = await startClaim(hit, false, null);
  if (!claimed && plan.nextReloadMs) {
    await send({ type: "armRefresh", delayMs: plan.nextReloadMs });
    armLocal(plan.nextReloadMs);
  }
}

async function onTaskPage() {
  publishAccountName();
  for (var i = 0; i < 12; i++) {
    var res = await send({ type: "taskPageReady", url: location.href });
    if (res && res.ignore) return;
    if (res && res.activeClaim) {
      await runButtonFlow();
      return;
    }
    await sleep(300);
  }
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === "cancelRefresh") {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "armRefresh") {
    armLocal(msg.delayMs);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "readAccountName") {
    sendResponse({ name: readAccountName(document) });
    return;
  }
  if (msg.type === "ping") {
    sendResponse({ ok: true });
  }
});

if (globalThis.chrome && chrome.runtime && chrome.runtime.id && location.hostname === "app.dataannotation.tech") {
  if (DA.isDashboardUrl(location.href)) onDashboard();
  else if (DA.isTaskUrl(location.href)) onTaskPage();
  else publishAccountName();
}
