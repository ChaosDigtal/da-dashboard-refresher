"use strict";

var state = Object.assign({}, DA.DEFAULTS);

var storage = {
  async getAll() {
    if (globalThis.chrome && chrome.storage && chrome.storage.local) {
      return chrome.storage.local.get(null);
    }
    try { return JSON.parse(localStorage.getItem("da-refresher") || "{}"); }
    catch (err) { return {}; }
  },
  async set(patch) {
    if (globalThis.chrome && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set(patch);
      return;
    }
    var current = await this.getAll();
    localStorage.setItem("da-refresher", JSON.stringify(Object.assign({}, current, patch)));
  }
};

function $(id) { return document.getElementById(id); }

function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return String(Date.now()) + Math.random().toString(16).slice(2);
}

function fillHours(select, selected) {
  select.innerHTML = "";
  for (var hour = 0; hour < 24; hour++) {
    var option = document.createElement("option");
    option.value = String(hour);
    option.textContent = DA.pad(hour);
    if (hour === Number(selected)) option.selected = true;
    select.appendChild(option);
  }
}

function settingsPatch() {
  return {
    refreshSeconds: state.refreshSeconds,
    startHour: state.startHour,
    startMinute: state.startMinute,
    endHour: state.endHour,
    endMinute: state.endMinute,
    searchProjects: state.searchProjects,
    excludeProjects: state.excludeProjects,
    rateFilterEnabled: state.rateFilterEnabled,
    minRate: state.minRate,
    listenSeconds: state.listenSeconds,
    running: state.running
  };
}

function scheduleSave() {
  storage.set(settingsPatch());
}

function iconButton(label, className, onClick, disabled) {
  var button = document.createElement("button");
  button.type = "button";
  button.className = "icon " + (className || "");
  button.textContent = label;
  button.setAttribute("aria-label", label === "↑" ? "Move up" : label === "↓" ? "Move down" : "Delete");
  button.disabled = !!disabled;
  button.addEventListener("click", onClick);
  return button;
}

function renderSearch() {
  var list = $("searchList");
  list.innerHTML = "";
  state.searchProjects.forEach(function (row, index) {
    var wrap = document.createElement("div");
    wrap.className = "row" + (row.preset === "Other" ? " other" : "");

    wrap.appendChild(iconButton("↑", "", function () {
      if (index === 0) return;
      var prev = state.searchProjects[index - 1];
      state.searchProjects[index - 1] = row;
      state.searchProjects[index] = prev;
      renderSearch();
      scheduleSave();
    }, index === 0));
    wrap.appendChild(iconButton("↓", "", function () {
      if (index === state.searchProjects.length - 1) return;
      var next = state.searchProjects[index + 1];
      state.searchProjects[index + 1] = row;
      state.searchProjects[index] = next;
      renderSearch();
      scheduleSave();
    }, index === state.searchProjects.length - 1));

    var select = document.createElement("select");
    select.setAttribute("aria-label", "Project " + (index + 1));
    DA.PRESETS.forEach(function (preset) {
      var option = document.createElement("option");
      option.value = preset;
      option.textContent = preset;
      if (preset === row.preset) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener("change", function () {
      row.preset = select.value;
      renderSearch();
      scheduleSave();
      if (row.preset === "Other") {
        var input = list.querySelector('[data-id="' + row.id + '"]');
        if (input) input.focus();
      }
    });
    wrap.appendChild(select);
    wrap.appendChild(iconButton("×", "danger delete", function () {
      state.searchProjects = state.searchProjects.filter(function (item) { return item.id !== row.id; });
      renderSearch();
      scheduleSave();
    }));

    if (row.preset === "Other") {
      var input = document.createElement("input");
      input.className = "term";
      input.dataset.id = row.id;
      input.type = "text";
      input.placeholder = "Search term";
      input.value = row.term || "";
      input.addEventListener("input", function () {
        row.term = input.value;
        scheduleSave();
      });
      wrap.appendChild(input);
    }
    list.appendChild(wrap);
  });
}

function renderExclude() {
  var list = $("excludeList");
  list.innerHTML = "";
  state.excludeProjects.forEach(function (row) {
    var wrap = document.createElement("div");
    wrap.className = "row exclude";
    var input = document.createElement("input");
    input.className = "term";
    input.type = "text";
    input.placeholder = "Search term";
    input.value = row.term || "";
    input.setAttribute("aria-label", "Excluded project");
    input.addEventListener("input", function () {
      row.term = input.value;
      scheduleSave();
    });
    wrap.appendChild(input);
    wrap.appendChild(iconButton("×", "danger delete", function () {
      state.excludeProjects = state.excludeProjects.filter(function (item) { return item.id !== row.id; });
      renderExclude();
      scheduleSave();
    }));
    list.appendChild(wrap);
  });
}

function renderStatus() {
  var active = DA.active(state);
  var line = "Paused.";
  if (state.running && active) line = "Running. Refreshing " + DA.windowLabel(state.startHour, state.startMinute, state.endHour, state.endMinute) + ".";
  else if (state.running) line = "Running. Waiting until " + DA.pad(state.startHour) + ":" + DA.pad(DA.clampMinute(state.startMinute)) + " JST.";
  if (state.lastEvent && state.lastEvent !== line) line = state.lastEvent;
  $("statusLine").textContent = line;
  $("accountLine").textContent = state.accountName || "";
  var toggle = $("toggle");
  toggle.textContent = state.running ? "Pause" : "Start";
  toggle.dataset.state = state.running ? "running" : "paused";
  var log = $("log");
  log.innerHTML = "";
  (state.log || []).slice(-4).reverse().forEach(function (entry) {
    var item = document.createElement("li");
    item.textContent = entry.text;
    log.appendChild(item);
  });
}

function render() {
  $("refreshSeconds").value = state.refreshSeconds;
  $("listenSeconds").value = state.listenSeconds;
  $("rateEnabled").checked = !!state.rateFilterEnabled;
  $("minRate").value = state.minRate;
  $("minRate").disabled = !state.rateFilterEnabled;
  fillHours($("startHour"), state.startHour);
  fillHours($("endHour"), state.endHour);
  $("startMinute").value = DA.clampMinute(state.startMinute);
  $("endMinute").value = DA.clampMinute(state.endMinute);
  renderSearch();
  renderExclude();
  renderStatus();
}

async function load() {
  var stored = await storage.getAll();
  state = Object.assign({}, DA.DEFAULTS, stored);
  if (!Array.isArray(state.searchProjects)) state.searchProjects = [];
  if (!Array.isArray(state.excludeProjects)) state.excludeProjects = [];
  var cleaned = (state.log || []).filter(function (entry) {
    return String(entry && entry.text || "").indexOf("Server check failed") !== 0;
  });
  var lastWasServerError = String(state.lastEvent || "").indexOf("Server check failed") === 0;
  if (cleaned.length !== (state.log || []).length || lastWasServerError) {
    state.log = cleaned;
    if (lastWasServerError) state.lastEvent = state.running ? "Running. Waiting for the JST window." : "Paused.";
    await storage.set({ log: state.log, lastEvent: state.lastEvent });
  }
  render();
}

$("refreshSeconds").addEventListener("input", function (event) {
  var value = Number(event.target.value);
  if (isFinite(value) && value >= 1) {
    state.refreshSeconds = value;
    scheduleSave();
  }
});

$("listenSeconds").addEventListener("input", function (event) {
  var value = Number(event.target.value);
  if (isFinite(value) && value >= 1) {
    state.listenSeconds = value;
    scheduleSave();
  }
});

$("minRate").addEventListener("input", function (event) {
  state.minRate = event.target.value;
  scheduleSave();
});

$("rateEnabled").addEventListener("change", function (event) {
  state.rateFilterEnabled = event.target.checked;
  $("minRate").disabled = !state.rateFilterEnabled;
  if (state.rateFilterEnabled) $("minRate").focus();
  scheduleSave();
});

$("startHour").addEventListener("change", function (event) {
  state.startHour = Number(event.target.value);
  scheduleSave();
  renderStatus();
});

$("endHour").addEventListener("change", function (event) {
  state.endHour = Number(event.target.value);
  scheduleSave();
  renderStatus();
});

function bindMinute(id, key) {
  $(id).addEventListener("input", function (event) {
    var value = Number(event.target.value);
    if (!isFinite(value)) return;
    state[key] = DA.clampMinute(value);
    if (value !== state[key]) event.target.value = String(state[key]);
    scheduleSave();
    renderStatus();
  });
}

bindMinute("startMinute", "startMinute");
bindMinute("endMinute", "endMinute");

$("addSearch").addEventListener("click", function () {
  state.searchProjects.push({ id: uid(), preset: "Triton", term: "" });
  renderSearch();
  scheduleSave();
});

$("addExclude").addEventListener("click", function () {
  var row = { id: uid(), term: "" };
  state.excludeProjects.push(row);
  renderExclude();
  scheduleSave();
  var inputs = $("excludeList").querySelectorAll("input");
  if (inputs.length) inputs[inputs.length - 1].focus();
});

$("toggle").addEventListener("click", async function () {
  state.running = !state.running;
  state.lastEvent = state.running ? "Running. Waiting for the JST window." : "Paused.";
  await storage.set(settingsPatch());
  renderStatus();
  if (globalThis.chrome && chrome.runtime && chrome.runtime.id) {
    chrome.runtime.sendMessage({ type: state.running ? "start" : "pause" });
  }
});

if (globalThis.chrome && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    ["running", "lastEvent", "log", "accountName", "startHour", "startMinute", "endHour", "endMinute"].forEach(function (key) {
      if (changes[key]) state[key] = changes[key].newValue;
    });
    if (changes.startHour && document.activeElement !== $("startHour")) $("startHour").value = String(state.startHour);
    if (changes.endHour && document.activeElement !== $("endHour")) $("endHour").value = String(state.endHour);
    if (changes.startMinute && document.activeElement !== $("startMinute")) $("startMinute").value = String(DA.clampMinute(state.startMinute));
    if (changes.endMinute && document.activeElement !== $("endMinute")) $("endMinute").value = String(DA.clampMinute(state.endMinute));
    renderStatus();
  });
}

load();
