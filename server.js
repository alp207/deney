"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const WebSocket = require("ws");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 10000);
const ROOT_DIR = __dirname;
const INDEX_FILE = path.join(ROOT_DIR, "index.html");

const WS_TARGETS = {
  frankfurt: (process.env.WS_TARGET_FRANKFURT || "").trim()
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const webSocketServer = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false
});

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function sendResponse(response, statusCode, headers, body) {
  response.writeHead(statusCode, headers);
  response.end(body);
}

function resolveFilePath(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const requestedPath = decodeURIComponent(url.pathname);
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const relativePath = normalizedPath === path.sep || normalizedPath === "/" ? "index.html" : normalizedPath.replace(/^[/\\]+/, "");
  const absolutePath = path.resolve(ROOT_DIR, relativePath);

  if (!absolutePath.startsWith(ROOT_DIR)) {
    return null;
  }

  if (!fs.existsSync(absolutePath)) {
    if (!path.extname(relativePath)) {
      return INDEX_FILE;
    }

    return null;
  }

  const stats = fs.statSync(absolutePath);
  if (stats.isDirectory()) {
    const nestedIndex = path.join(absolutePath, "index.html");
    return fs.existsSync(nestedIndex) ? nestedIndex : null;
  }

  return absolutePath;
}

function getTargetKey(requestUrl) {
  const pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  const match = pathname.match(/^\/ws\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}

function sanitizeCloseReason(reason) {
  if (!reason) {
    return "";
  }

  const text = String(reason);
  return Buffer.byteLength(text, "utf8") <= 123 ? text : text.slice(0, 123);
}

function sanitizeCloseCode(code) {
  if (typeof code !== "number") {
    return 1011;
  }

  const reservedCodes = new Set([1004, 1005, 1006, 1015]);
  if (code < 1000 || code > 4999 || reservedCodes.has(code)) {
    return 1011;
  }

  return code;
}

function closeSocket(socket, code, reason) {
  if (!socket || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
    return;
  }

  socket.close(sanitizeCloseCode(code), sanitizeCloseReason(reason));
}

function bridgeSockets(clientSocket, upstreamSocket) {
  const pendingMessages = [];

  clientSocket.on("message", (data, isBinary) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
      return;
    }

    if (upstreamSocket.readyState === WebSocket.CONNECTING) {
      pendingMessages.push([data, isBinary]);
    }
  });

  upstreamSocket.on("open", () => {
    while (pendingMessages.length > 0 && upstreamSocket.readyState === WebSocket.OPEN) {
      const [data, isBinary] = pendingMessages.shift();
      upstreamSocket.send(data, { binary: isBinary });
    }
  });

  upstreamSocket.on("message", (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data, { binary: isBinary });
    }
  });

  clientSocket.on("close", (code, reason) => {
    closeSocket(upstreamSocket, code, reason.toString("utf8"));
  });

  upstreamSocket.on("close", (code, reason) => {
    closeSocket(clientSocket, code, reason.toString("utf8"));
  });

  clientSocket.on("error", () => {
    closeSocket(upstreamSocket, 1011, "Client socket error");
  });

  upstreamSocket.on("error", (error) => {
    console.error("Upstream WebSocket error:", error.message);
    closeSocket(clientSocket, 1008, "Upstream connection failed");
  });
}

const server = http.createServer((request, response) => {
  if (!request.url) {
    sendResponse(response, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request");
    return;
  }

  if (request.url === "/healthz") {
    sendResponse(response, 200, { "Content-Type": "text/plain; charset=utf-8" }, "ok");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendResponse(response, 405, { "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed");
    return;
  }

  const filePath = resolveFilePath(request.url);
  if (!filePath) {
    sendResponse(response, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      console.error("Failed to read file:", filePath, error.message);
      sendResponse(response, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Internal server error");
      return;
    }

    const headers = {
      "Content-Type": getMimeType(filePath),
      "Cache-Control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=3600"
    };

    if (request.method === "HEAD") {
      response.writeHead(200, headers);
      response.end();
      return;
    }

    response.writeHead(200, headers);
    response.end(data);
  });
});

server.on("upgrade", (request, socket, head) => {
  const targetKey = request.url ? getTargetKey(request.url) : null;
  const hasTargetKey = Boolean(targetKey && Object.prototype.hasOwnProperty.call(WS_TARGETS, targetKey));
  const targetUrl = hasTargetKey ? WS_TARGETS[targetKey] : null;

  if (!hasTargetKey) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (clientSocket) => {
    if (!targetUrl) {
      closeSocket(clientSocket, 1008, "Frankfurt backend is not configured");
      return;
    }

    const upstreamSocket = new WebSocket(targetUrl, {
      perMessageDeflate: false
    });

    bridgeSockets(clientSocket, upstreamSocket);

    upstreamSocket.on("unexpected-response", (_request, upstreamResponse) => {
      console.error("Unexpected upstream response:", upstreamResponse.statusCode);
      closeSocket(clientSocket, 1008, "Unexpected upstream response");
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Render bridge listening on http://${HOST}:${PORT}`);
});
