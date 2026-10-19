"use strict";

setInterval(function () {
  chrome.runtime.sendMessage({ type: "tick" }).catch(function () {});
}, 2000);
