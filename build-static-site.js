"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, "static-dist");
const SOURCE_FILES = [
  "index.html",
  "index2.html",
  "style.css",
  "game.min.js",
  "pixi.min.js",
  "render-config.js"
];

function ensureCleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(relativePath) {
  const sourcePath = path.join(ROOT, relativePath);
  const destinationPath = path.join(OUTPUT_DIR, relativePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyDirectory(relativePath) {
  const sourcePath = path.join(ROOT, relativePath);
  const destinationPath = path.join(OUTPUT_DIR, relativePath);
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
}

function normalizeWsBaseUrl(value) {
  const fallback = "wss://one-v-one-render-bridge.onrender.com";
  return (value || fallback).trim().replace(/\/+$/, "");
}

function writeRenderConfig() {
  const wsBaseUrl = normalizeWsBaseUrl(process.env.WS_BRIDGE_BASE_URL);
  const content = `"use strict";\nwindow.__WS_BRIDGE_BASE_URL = ${JSON.stringify(wsBaseUrl)};\n`;
  fs.writeFileSync(path.join(OUTPUT_DIR, "render-config.js"), content, "utf8");
}

ensureCleanDir(OUTPUT_DIR);
SOURCE_FILES.forEach(copyFile);
copyDirectory("assets");
writeRenderConfig();

console.log(`Static bundle written to ${OUTPUT_DIR}`);
