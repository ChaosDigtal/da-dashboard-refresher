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

async function startClaim(project, fromNotification, notificationId) {
  var prepared = await send({
    type: "prepareClaim",
    project: project,
    fromNotification: !!fromNotification,
    notificationId: notificationId || null
  });
  if (!prepared || !prepared.ok) return false;
  var opened = await send({ type: "openProjectTab", url: project.url });
  return !!(opened && opened.ok);
}

function findIntendButton() {
  var buttons = document.querySelectorAll("button");
  for (var i = 0; i < buttons.length; i++) {
    if (textOf(buttons[i]) === "I intend to complete this task!") return buttons[i];
  }
  return null;
}

function findExpireLink() {
  var links = document.querySelectorAll("a");
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute("href") || "";
    if (textOf(links[i]) === "Expire it and start this task" || href.indexOf("confirm_expire_in_progress") !== -1) {
      return links[i];
    }
  }
  return null;
}

async function runButtonFlow() {
  var deadline = Date.now() + 10000;
  var clickedEnter = false;
  var clickedIntend = false;
  var clickedExpire = false;
  while (Date.now() < deadline) {
    if (DA.isDashboardUrl(location.href)) {
      await send({ type: "claimResult", ok: false, reason: "redirected-to-dashboard" });
      return;
    }
    if (!clickedExpire) {
      var expire = findExpireLink();
      if (expire) {
        expire.click();
        clickedExpire = true;
        deadline = Math.max(deadline, Date.now() + 10000);
        await sleep(200);
        continue;
      }
    }
    var enter = document.getElementById("enterWorkModeButton");
    if (enter && !clickedEnter && !enter.disabled) {
      enter.click();
      clickedEnter = true;
      deadline = Math.max(deadline, Date.now() + 10000);
    }
    var intend = findIntendButton();
    if (intend && !clickedIntend && !intend.disabled) {
      intend.click();
      clickedIntend = true;
      break;
    }
    await sleep(200);
  }
  var grace = Date.now() + (clickedEnter || clickedIntend || clickedExpire ? 2500 : 400);
  while (Date.now() < grace) {
    if (DA.isDashboardUrl(location.href)) {
      await send({ type: "claimResult", ok: false, reason: "redirected-to-dashboard" });
      return;
    }
    if (!clickedExpire) {
      var lateExpire = findExpireLink();
      if (lateExpire) {
        lateExpire.click();
        clickedExpire = true;
        await sleep(200);
        continue;
      }
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

function projectChoice(plan, extracted) {
  if (plan.mode === "triton") {
    var inProgress = extracted.inProgress.some(function (project) {
      return DA.isTritonName(project.name);
    });
    if (inProgress) return { kind: "triton-in-progress" };
    for (var i = 0; i < extracted.available.length; i++) {
      if (DA.isTritonName(extracted.available[i].name)) return { kind: "project", project: extracted.available[i] };
    }
    return null;
  }
  var hit = DA.pickProject(extracted.available, plan.settings || {});
  if (hit) return { kind: "project", project: hit };
  return null;
}

function rateNotifyPayload(plan, choice) {
  var raw = plan.settings ? plan.settings.notifyMinRate : "";
  var extracted = choice.extracted;
  if (!extracted || !extracted.projectsTabSelected) return null;
  if (raw === "" || raw == null || !isFinite(Number(raw))) {
    return { enabled: false, projects: [] };
  }
  var min = Number(raw);
  var projects = [];
  var available = extracted.available || [];
  for (var i = 0; i < available.length; i++) {
    var project = available[i];
    if (project.rate == null || !(project.rate >= min)) continue;
    projects.push({
      name: project.name,
      url: project.url,
      rateLabel: project.rateLabel || "none"
    });
  }
  return { enabled: true, projects: projects };
}

async function watchDashboard(plan) {
  var deadline = Date.now() + 6000;
  var unselected = 0;
  var lastCount = -1;
  var stableRows = 0;
  var extracted = null;
  while (Date.now() < deadline) {
    var tab = findProjectsTab(document);
    if (!tab) {
      await sleep(100);
      continue;
    }
    if (tab.getAttribute("aria-selected") !== "true") {
      unselected += 1;
      if (unselected >= 3) return { kind: "unselected" };
      await sleep(100);
      continue;
    }
    unselected = 0;
    extracted = extractDashboard(document);
    var choice = projectChoice(plan, extracted);
    if (choice) {
      choice.extracted = extracted;
      return choice;
    }
    var table = tableForHeading(document, "Projects");
    var count = table ? table.querySelectorAll("tbody tr").length : 0;
    if (count > 0) {
      stableRows = count === lastCount ? stableRows + 1 : 0;
      lastCount = count;
      if (stableRows >= 2) {
        return { kind: plan.mode === "triton" ? "triton-not-found" : "no-match", extracted: extracted };
      }
    }
    await sleep(100);
  }
  return { kind: plan.mode === "triton" ? "triton-not-found" : "no-match", extracted: extracted };
}

function findStayButton() {
  var buttons = queryAll(document, "button");
  for (var i = 0; i < buttons.length; i++) {
    if (textOf(buttons[i]) === "Click here to stay logged in") return buttons[i];
  }
  return null;
}

async function clickStayLoggedIn() {
  var deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    var button = findStayButton();
    if (button && !button.disabled) {
      button.click();
      await send({ type: "note", text: "Clicked stay logged in." });
      return;
    }
    await sleep(200);
  }
}

async function onDashboard() {
  publishAccountName();
  var plan = await send({ type: "dashboardReady" });
  if (plan && plan.stayLogin) {
    await clickStayLoggedIn();
    await send({ type: "stayLoginDone" });
  }
  if (!plan || !plan.mode || plan.mode === "ignore" || plan.mode === "idle") {
    if (plan && plan.nextReloadMs) armLocal(plan.nextReloadMs);
    return;
  }

  var choice = await watchDashboard(plan);
  if (choice.kind === "unselected") {
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

  var payload = rateNotifyPayload(plan, choice);
  var notifyPromise = payload ? send(Object.assign({ type: "notifyRateProjects" }, payload)) : null;

  var claimedOk = false;
  if (choice.kind === "project") {
    claimedOk = !!(await startClaim(choice.project, plan.mode === "triton", plan.notificationId));
  }

  if (choice.kind === "triton-in-progress") {
    await send({ type: "tritonAttemptDone", outcome: "in-progress" });
  } else if (choice.kind === "triton-not-found") {
    await send({ type: "tritonAttemptDone", outcome: "not-found" });
  } else if (choice.kind !== "project") {
    await send({ type: "note", text: "No matching project. Waiting for the next refresh." });
  }

  if (notifyPromise) await notifyPromise;

  if (choice.kind !== "project" || !claimedOk) {
    if (plan.nextReloadMs) {
      await send({ type: "armRefresh", delayMs: plan.nextReloadMs });
      armLocal(plan.nextReloadMs);
    }
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
