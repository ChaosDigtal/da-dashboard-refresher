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
    scheduleSlots: state.scheduleSlots,
    startHour: state.scheduleSlots[0] ? state.scheduleSlots[0].startHour : state.startHour,
    startMinute: state.scheduleSlots[0] ? state.scheduleSlots[0].startMinute : state.startMinute,
    endHour: state.scheduleSlots[0] ? state.scheduleSlots[0].endHour : state.endHour,
    endMinute: state.scheduleSlots[0] ? state.scheduleSlots[0].endMinute : state.endMinute,
    searchProjects: state.searchProjects,
    excludeProjects: state.excludeProjects,
    rateFilterEnabled: state.rateFilterEnabled,
    minRate: state.minRate,
    notifyMinRate: state.notifyMinRate,
    listenSeconds: state.listenSeconds,
    notifyEmail: state.notifyEmail,
    running: state.running
  };
}

var saveChain = Promise.resolve();

function scheduleSave() {
  var patch = settingsPatch();
  saveChain = saveChain.then(function () {
    return storage.set(patch);
  }, function () {
    return storage.set(patch);
  });
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

var DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function daySummary(days) {
  if (!days.length) return "None";
  if (days.length === 7) return "All";
  if (days.length === 1) return DAY_LABELS[days[0] - 1];
  return String(days.length) + " days";
}

function renderSchedule() {
  var list = $("scheduleList");
  list.innerHTML = "";
  state.scheduleSlots.forEach(function (slot, index) {
    if (!Array.isArray(slot.weekdays)) slot.weekdays = [1, 2, 3, 4, 5, 6, 7];
    var wrap = document.createElement("div");
    wrap.className = "slot";

    var drop = document.createElement("div");
    drop.className = "day-drop";
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "day-toggle";
    toggle.textContent = daySummary(slot.weekdays);
    toggle.title = slot.weekdays.map(function (day) { return DAY_LABELS[day - 1]; }).join(", ");
    toggle.setAttribute("aria-label", "Days for time " + (index + 1));
    toggle.setAttribute("aria-expanded", "false");
    var menu = document.createElement("div");
    menu.className = "day-menu";
    DAY_LABELS.forEach(function (label, dayIndex) {
      var value = dayIndex + 1;
      var choice = document.createElement("label");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = slot.weekdays.indexOf(value) !== -1;
      box.addEventListener("change", function () {
        var next = slot.weekdays.slice();
        var at = next.indexOf(value);
        if (box.checked && at === -1) next.push(value);
        if (!box.checked && at !== -1) next.splice(at, 1);
        next.sort(function (a, b) { return a - b; });
        slot.weekdays = next;
        toggle.textContent = daySummary(next);
        toggle.title = next.map(function (day) { return DAY_LABELS[day - 1]; }).join(", ");
        scheduleSave();
        renderStatus();
      });
      choice.appendChild(box);
      choice.appendChild(document.createTextNode(label));
      menu.appendChild(choice);
    });
    menu.addEventListener("click", function (event) {
      event.stopPropagation();
    });
    toggle.addEventListener("click", function (event) {
      event.stopPropagation();
      var open = !drop.classList.contains("open");
      var menus = document.querySelectorAll(".day-drop.open");
      for (var i = 0; i < menus.length; i++) {
        menus[i].classList.remove("open");
        var other = menus[i].querySelector(".day-toggle");
        if (other) other.setAttribute("aria-expanded", "false");
      }
      if (open) {
        drop.classList.add("open");
        toggle.setAttribute("aria-expanded", "true");
      }
    });
    drop.appendChild(toggle);
    drop.appendChild(menu);
    wrap.appendChild(drop);

    var startHour = document.createElement("select");
    startHour.setAttribute("aria-label", "Start hour " + (index + 1));
    fillHours(startHour, slot.startHour);
    startHour.addEventListener("change", function () {
      slot.startHour = Number(startHour.value);
      scheduleSave();
      renderStatus();
    });

    var startMinute = document.createElement("input");
    startMinute.type = "number";
    startMinute.min = "0";
    startMinute.max = "59";
    startMinute.step = "1";
    startMinute.value = String(slot.startMinute);
    startMinute.setAttribute("aria-label", "Start minute " + (index + 1));
    startMinute.addEventListener("input", function () {
      var value = Number(startMinute.value);
      if (!isFinite(value)) return;
      slot.startMinute = DA.clampMinute(value);
      if (value !== slot.startMinute) startMinute.value = String(slot.startMinute);
      scheduleSave();
      renderStatus();
    });

    var endHour = document.createElement("select");
    endHour.setAttribute("aria-label", "End hour " + (index + 1));
    fillHours(endHour, slot.endHour);
    endHour.addEventListener("change", function () {
      slot.endHour = Number(endHour.value);
      scheduleSave();
      renderStatus();
    });

    var endMinute = document.createElement("input");
    endMinute.type = "number";
    endMinute.min = "0";
    endMinute.max = "59";
    endMinute.step = "1";
    endMinute.value = String(slot.endMinute);
    endMinute.setAttribute("aria-label", "End minute " + (index + 1));
    endMinute.addEventListener("input", function () {
      var value = Number(endMinute.value);
      if (!isFinite(value)) return;
      slot.endMinute = DA.clampMinute(value);
      if (value !== slot.endMinute) endMinute.value = String(slot.endMinute);
      scheduleSave();
      renderStatus();
    });

    wrap.appendChild(startHour);
    wrap.appendChild(document.createTextNode(":"));
    wrap.appendChild(startMinute);
    wrap.appendChild(document.createTextNode("~"));
    wrap.appendChild(endHour);
    wrap.appendChild(document.createTextNode(":"));
    wrap.appendChild(endMinute);
    wrap.appendChild(iconButton("×", "danger delete", function () {
      state.scheduleSlots = state.scheduleSlots.filter(function (item) { return item.id !== slot.id; });
      renderSchedule();
      scheduleSave();
      renderStatus();
    }));
    list.appendChild(wrap);
  });
}

document.addEventListener("click", function () {
  var menus = document.querySelectorAll(".day-drop.open");
  for (var i = 0; i < menus.length; i++) {
    menus[i].classList.remove("open");
    var toggle = menus[i].querySelector(".day-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }
});

function renderStatus() {
  var line = DA.runStatus(state);
  if (state.lastEvent && state.lastEvent !== line) line = state.lastEvent;
  $("statusLine").textContent = line;
  $("accountLine").textContent = state.accountName || "";
  var toggle = $("toggle");
  toggle.textContent = state.running ? "Pause" : "Start";
  toggle.dataset.state = state.running ? "running" : "paused";
}

function render() {
  $("refreshSeconds").value = state.refreshSeconds;
  $("listenSeconds").value = state.listenSeconds;
  $("notifyEmail").value = state.notifyEmail || "";
  $("rateEnabled").checked = !!state.rateFilterEnabled;
  $("minRate").value = state.minRate;
  $("notifyMinRate").value = state.notifyMinRate;
  $("minRate").disabled = !state.rateFilterEnabled;
  renderSchedule();
  renderSearch();
  renderExclude();
  renderStatus();
}

async function load() {
  var stored = await storage.getAll();
  state = Object.assign({}, DA.DEFAULTS, stored);
  if (!Array.isArray(state.searchProjects)) state.searchProjects = [];
  if (!Array.isArray(state.excludeProjects)) state.excludeProjects = [];
  state.scheduleSlots = DA.slotsOf(state).map(function (slot) {
    if (!slot.id) slot.id = uid();
    return slot;
  });
  var patch = {};
  if (!Array.isArray(stored.scheduleSlots)) patch.scheduleSlots = state.scheduleSlots;
  if (Array.isArray(state.log) && state.log.length) {
    state.log = [];
    patch.log = [];
  }
  if (String(state.lastEvent || "").indexOf("Server check failed") === 0) {
    state.lastEvent = state.running ? "Running. Waiting for the JST window." : "Paused.";
    patch.lastEvent = state.lastEvent;
  }
  if (patch.scheduleSlots || patch.log || patch.lastEvent) await storage.set(patch);
  render();
}

$("refreshSeconds").addEventListener("input", function (event) {
  var value = Number(event.target.value);
  if (isFinite(value) && value >= 1) {
    state.refreshSeconds = value;
    scheduleSave();
  }
});

$("notifyEmail").addEventListener("input", function (event) {
  state.notifyEmail = event.target.value.trim();
  scheduleSave();
});

$("listenSeconds").addEventListener("input", function (event) {
  var value = Number(event.target.value);
  if (isFinite(value) && value >= 1) {
    state.listenSeconds = value;
    scheduleSave();
  }
});

$("notifyMinRate").addEventListener("input", function (event) {
  state.notifyMinRate = event.target.value;
  scheduleSave();
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

$("addSlot").addEventListener("click", function () {
  var last = state.scheduleSlots[state.scheduleSlots.length - 1];
  var startHour = last ? Number(last.endHour) % 24 : 9;
  var startMinute = last ? DA.clampMinute(last.endMinute) : 0;
  var endHour = (startHour + 1) % 24;
  var endMinute = startMinute;
  state.scheduleSlots.push({
    id: uid(),
    startHour: startHour,
    startMinute: startMinute,
    endHour: endHour,
    endMinute: endMinute,
    weekdays: last && Array.isArray(last.weekdays) ? last.weekdays.slice() : [1, 2, 3, 4, 5, 6, 7]
  });
  renderSchedule();
  scheduleSave();
  renderStatus();
});

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
    ["running", "lastEvent", "accountName"].forEach(function (key) {
      if (changes[key]) state[key] = changes[key].newValue;
    });
    renderStatus();
  });
}

load();
