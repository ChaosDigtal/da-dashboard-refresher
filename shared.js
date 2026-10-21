var DA = (function () {
  var DEFAULTS = {
    refreshSeconds: 10,
    startHour: 9,
    startMinute: 0,
    endHour: 18,
    endMinute: 0,
    scheduleSlots: null,
    searchProjects: [],
    excludeProjects: [],
    rateFilterEnabled: false,
    minRate: "",
    notifyMinRate: "",
    listenSeconds: 10,
    notifyEmail: "pierre420375@gmail.com",
    running: false,
    accountName: "",
    pendingHandoff: null,
    pendingMode: null,
    pendingNotificationId: null,
    nextReloadAt: 0,
    lastPollAt: 0,
    lastEvent: "Paused.",
    log: []
  };

  var PRESETS = ["Triton", "Boxing", "Étalon", "Corsair", "Ummon", "Other"];
  var DASHBOARD = "https://app.dataannotation.tech/workers/projects";

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function jstParts(date) {
    var fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    var bag = {};
    var parts = fmt.formatToParts(date);
    for (var i = 0; i < parts.length; i++) bag[parts[i].type] = parts[i].value;
    if (bag.hour === "24") bag.hour = "00";
    return bag;
  }

  function jstHour(date) {
    return Number(jstParts(date || new Date()).hour);
  }

  function jstStamp(date) {
    var p = jstParts(date || new Date());
    return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute + ":" + p.second + "+09:00";
  }

  function clampMinute(value) {
    var minute = Math.round(Number(value));
    if (!isFinite(minute) || minute < 0) return 0;
    if (minute > 59) return 59;
    return minute;
  }

  function clockSeconds(hour, minute) {
    return Number(hour) * 3600 + clampMinute(minute) * 60;
  }

  function jstSeconds(date) {
    var parts = jstParts(date || new Date());
    return Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  }

  function inWindow(now, startHour, startMinute, endHour, endMinute) {
    var current = jstSeconds(now || new Date());
    var start = clockSeconds(startHour, startMinute);
    var end = clockSeconds(endHour, endMinute);
    if (start === end) return false;
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
  }

  function nextWindow(startHour, startMinute, endHour, endMinute, now) {
    startHour = Number(startHour);
    endHour = Number(endHour);
    startMinute = clampMinute(startMinute);
    endMinute = clampMinute(endMinute);
    now = now || new Date();
    var startClock = startHour * 60 + startMinute;
    var endClock = endHour * 60 + endMinute;
    var today = jstParts(now);
    var noon = new Date(today.year + "-" + today.month + "-" + today.day + "T12:00:00+09:00");
    for (var add = 0; add < 4; add++) {
      var day = jstParts(new Date(noon.getTime() + add * 86400000));
      var startIso = day.year + "-" + day.month + "-" + day.day + "T" + pad(startHour) + ":" + pad(startMinute) + ":00+09:00";
      if (new Date(startIso).getTime() <= now.getTime()) continue;
      var endIso;
      if (startClock < endClock) {
        endIso = day.year + "-" + day.month + "-" + day.day + "T" + pad(endHour) + ":" + pad(endMinute) + ":00+09:00";
      } else {
        var next = jstParts(new Date(new Date(startIso).getTime() + 24 * 3600000));
        endIso = next.year + "-" + next.month + "-" + next.day + "T" + pad(endHour) + ":" + pad(endMinute) + ":00+09:00";
      }
      return { start: startIso, end: endIso };
    }
    return { start: "", end: "" };
  }

  function randomDelayMs(seconds) {
    var base = Number(seconds);
    if (!isFinite(base) || base <= 0) base = 10;
    var factor = 0.5 + Math.random();
    return Math.max(500, Math.round(base * factor * 1000));
  }

  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase();
  }

  function contains(name, term) {
    var needle = fold(term).trim();
    if (!needle) return false;
    return fold(name).includes(needle);
  }

  function searchTerm(row) {
    if (!row) return "";
    if (row.preset === "Other") return String(row.term || "").trim();
    return String(row.preset || "").trim();
  }

  function isTritonName(name) {
    return contains(name, "triton");
  }

  function pickProject(available, settings) {
    var projects = Array.isArray(available) ? available : [];
    var searches = settings && Array.isArray(settings.searchProjects) ? settings.searchProjects : [];
    for (var i = 0; i < searches.length; i++) {
      var term = searchTerm(searches[i]);
      if (!term) continue;
      for (var j = 0; j < projects.length; j++) {
        if (contains(projects[j].name, term)) return projects[j];
      }
    }
    if (!settings || !settings.rateFilterEnabled) return null;
    var min = Number(settings.minRate);
    if (!isFinite(min)) return null;
    var excludes = Array.isArray(settings.excludeProjects) ? settings.excludeProjects : [];
    var best = null;
    for (var k = 0; k < projects.length; k++) {
      var project = projects[k];
      if (project.rate == null || !(project.rate >= min)) continue;
      var skip = false;
      for (var n = 0; n < excludes.length; n++) {
        if (contains(project.name, excludes[n].term)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      if (!best || project.rate > best.rate) best = project;
    }
    return best;
  }

  function isDashboardUrl(url) {
    try {
      var parsed = new URL(url);
      return parsed.hostname === "app.dataannotation.tech" &&
        parsed.pathname.replace(/\/+$/, "") === "/workers/projects";
    } catch (err) {
      return false;
    }
  }

  function isTaskUrl(url) {
    try {
      var parsed = new URL(url);
      return parsed.hostname === "app.dataannotation.tech" &&
        parsed.pathname.indexOf("/workers/tasks") === 0;
    } catch (err) {
      return false;
    }
  }

  function clampHour(value, fallback) {
    var hour = Math.round(Number(value));
    if (!isFinite(hour) || hour < 0 || hour > 23) return fallback;
    return hour;
  }

  function normalizeSlot(slot) {
    return {
      id: slot && slot.id ? String(slot.id) : "",
      startHour: clampHour(slot && slot.startHour, 9),
      startMinute: clampMinute(slot && slot.startMinute),
      endHour: clampHour(slot && slot.endHour, 18),
      endMinute: clampMinute(slot && slot.endMinute)
    };
  }

  function slotsOf(state) {
    if (state && Array.isArray(state.scheduleSlots)) return state.scheduleSlots.map(normalizeSlot);
    var source = state || {};
    return [normalizeSlot({
      startHour: source.startHour != null ? source.startHour : 9,
      startMinute: source.startMinute != null ? source.startMinute : 0,
      endHour: source.endHour != null ? source.endHour : 18,
      endMinute: source.endMinute != null ? source.endMinute : 0
    })];
  }

  function slotActive(slot, now) {
    return inWindow(now, slot.startHour, slot.startMinute, slot.endHour, slot.endMinute);
  }

  function nextSlotWindow(slots, now) {
    var list = Array.isArray(slots) ? slots : [];
    var best = null;
    var bestTime = Infinity;
    now = now || new Date();
    for (var i = 0; i < list.length; i++) {
      var slot = list[i];
      if (clockSeconds(slot.startHour, slot.startMinute) === clockSeconds(slot.endHour, slot.endMinute)) continue;
      var window = nextWindow(slot.startHour, slot.startMinute, slot.endHour, slot.endMinute, now);
      var time = window.start ? new Date(window.start).getTime() : Infinity;
      if (time < bestTime) {
        bestTime = time;
        best = window;
      }
    }
    return best || { start: "", end: "" };
  }

  function active(state, now) {
    if (!state || !state.running) return false;
    var time = now || new Date();
    var slots = slotsOf(state);
    for (var i = 0; i < slots.length; i++) {
      if (slotActive(slots[i], time)) return true;
    }
    return false;
  }

  function windowLabel(startHour, startMinute, endHour, endMinute) {
    return pad(startHour) + ":" + pad(clampMinute(startMinute)) + "–" + pad(endHour) + ":" + pad(clampMinute(endMinute)) + " JST";
  }

  function runStatus(state, now) {
    if (!state || !state.running) return "Paused.";
    now = now || new Date();
    var slots = slotsOf(state);
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (slotActive(slot, now)) return "Running. Refreshing " + windowLabel(slot.startHour, slot.startMinute, slot.endHour, slot.endMinute) + ".";
    }
    var upcoming = nextSlotWindow(slots, now);
    if (!upcoming.start) return "Running. No schedule is set.";
    return "Running. Waiting until " + upcoming.start.slice(11, 16) + " JST.";
  }

  return {
    DEFAULTS: DEFAULTS,
    PRESETS: PRESETS,
    DASHBOARD: DASHBOARD,
    pad: pad,
    jstParts: jstParts,
    jstHour: jstHour,
    jstStamp: jstStamp,
    clampMinute: clampMinute,
    inWindow: inWindow,
    nextWindow: nextWindow,
    slotsOf: slotsOf,
    nextSlotWindow: nextSlotWindow,
    runStatus: runStatus,
    randomDelayMs: randomDelayMs,
    fold: fold,
    contains: contains,
    searchTerm: searchTerm,
    isTritonName: isTritonName,
    pickProject: pickProject,
    isDashboardUrl: isDashboardUrl,
    isTaskUrl: isTaskUrl,
    active: active,
    windowLabel: windowLabel
  };
})();
