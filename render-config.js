"use strict";

window.__WS_BRIDGE_BASE_URL =
  window.location.protocol === "https:"
    ? "wss://" + window.location.host
    : "ws://" + window.location.host;
