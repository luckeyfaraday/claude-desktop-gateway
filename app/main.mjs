import { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  defaultOpenRouterAuthFile,
  userConfigDir,
} from "../src/platform-paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const gatewayScript = path.join(projectRoot, "src", "openrouter-gateway.mjs");
const oauthScript = path.join(projectRoot, "src", "openrouter-oauth-login.mjs");
const configureScript = path.join(projectRoot, "scripts", "configure-openrouter.mjs");
const restoreScript = path.join(projectRoot, "scripts", "restore-claude.mjs");

const settingsPath = path.join(
  userConfigDir("claude-openrouter-gateway"),
  "app-settings.json",
);

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  routeModel: "claude-sonnet-4-5",
  upstreamModel: "anthropic/claude-sonnet-4.5",
  autostart: false,
  startGatewayOnLaunch: true,
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(next) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

let settings = loadSettings();
let tray = null;
let win = null;
let gatewayProc = null;
let lastHealth = null;
let icons = null;
const logBuffer = [];

function pushLog(text) {
  for (const raw of String(text).split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const entry = `[${new Date().toLocaleTimeString()}] ${line}`;
    logBuffer.push(entry);
    if (logBuffer.length > 500) logBuffer.shift();
    if (win && !win.isDestroyed()) win.webContents.send("log", entry);
  }
}

function nodeEnv(extra = {}) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    OPENROUTER_GATEWAY_HOST: settings.host,
    OPENROUTER_GATEWAY_PORT: String(settings.port),
    OPENROUTER_MODEL: settings.upstreamModel,
    CLAUDE_ROUTE_MODEL: settings.routeModel,
    ...extra,
  };
}

function hasAuth() {
  try {
    const auth = JSON.parse(fs.readFileSync(defaultOpenRouterAuthFile(), "utf8"));
    return typeof auth.key === "string" && auth.key.trim().length > 0;
  } catch {
    return false;
  }
}

function trayImage() {
  if (!icons) {
    const dir = path.join(here, "assets");
    icons = {
      active: nativeImage.createFromPath(path.join(dir, "tray-active.png")),
      idle: nativeImage.createFromPath(path.join(dir, "tray-idle.png")),
    };
  }
  return gatewayProc && lastHealth ? icons.active : icons.idle;
}

function startGateway() {
  if (gatewayProc) return;
  gatewayProc = spawn(process.execPath, [gatewayScript], { env: nodeEnv() });
  gatewayProc.stdout.on("data", (d) => pushLog(d.toString()));
  gatewayProc.stderr.on("data", (d) => pushLog(d.toString()));
  gatewayProc.on("error", (err) => pushLog(`gateway error: ${err.message}`));
  gatewayProc.on("exit", (code, signal) => {
    pushLog(`gateway stopped (code=${code ?? "?"} signal=${signal ?? "none"})`);
    gatewayProc = null;
    lastHealth = null;
    updateUI();
  });
  pushLog(`gateway launching on http://${settings.host}:${settings.port}`);
  updateUI();
}

function stopGateway() {
  if (gatewayProc) gatewayProc.kill("SIGTERM");
}

function runScript(scriptPath, label) {
  pushLog(`${label}…`);
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [scriptPath], { env: nodeEnv() });
    proc.stdout.on("data", (d) => pushLog(d.toString()));
    proc.stderr.on("data", (d) => pushLog(d.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`)),
    );
  });
}

async function signIn() {
  try {
    await runScript(oauthScript, "OpenRouter sign-in");
    pushLog("OpenRouter sign-in complete");
  } catch (err) {
    pushLog(`sign-in failed: ${err.message}`);
  }
  updateUI();
}

async function configureClaude() {
  try {
    await runScript(configureScript, "Writing Claude Desktop 3p config");
    pushLog("Claude Desktop configured — relaunch Claude Desktop to apply");
  } catch (err) {
    pushLog(`configure failed: ${err.message}`);
  }
  updateUI();
}

async function restoreClaude() {
  try {
    await runScript(restoreScript, "Restoring official Claude Desktop mode");
    pushLog("Claude Desktop restored to official mode — relaunch Claude Desktop to apply");
  } catch (err) {
    pushLog(`restore failed: ${err.message}`);
  }
  updateUI();
}

function linuxAutostartFile() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(cfg, "autostart", "claude-openrouter-gateway.desktop");
}

function applyAutostart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch {
    // Not all platforms support this; the Linux .desktop entry below is the fallback.
  }
  if (process.platform !== "linux") return;
  const file = linuxAutostartFile();
  try {
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    const exec = app.isPackaged
      ? `"${process.execPath}"`
      : `"${process.execPath}" "${path.join(here, "main.mjs")}"`;
    const desktop = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Claude × OpenRouter Gateway",
      `Exec=${exec}`,
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, desktop);
  } catch (err) {
    pushLog(`could not update autostart: ${err.message}`);
  }
}

async function pollHealth() {
  if (!gatewayProc) {
    if (lastHealth !== null) {
      lastHealth = null;
      updateUI();
    }
    return;
  }
  const before = lastHealth;
  try {
    const res = await fetch(`http://${settings.host}:${settings.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    lastHealth = res.ok ? await res.json() : null;
  } catch {
    lastHealth = null;
  }
  if (JSON.stringify(before) !== JSON.stringify(lastHealth)) updateUI();
}

function statusLabel() {
  if (!gatewayProc) return "Gateway: stopped";
  return lastHealth ? "Gateway: running" : "Gateway: starting…";
}

function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat().format(number);
}

function usageLabel() {
  const usage = lastHealth?.usage;
  if (!usage?.requests) return "Session tokens: none yet";
  const total = usage.total || {};
  const requestLabel = usage.requests === 1 ? "request" : "requests";
  return `Session tokens: ${formatCount(total.total_tokens)} (${formatCount(usage.requests)} ${requestLabel})`;
}

function getState() {
  return {
    settings,
    running: !!gatewayProc,
    healthy: !!lastHealth,
    signedIn: hasAuth(),
    health: lastHealth,
    authFile: defaultOpenRouterAuthFile(),
  };
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    { label: hasAuth() ? "✓ Signed in to OpenRouter" : "✗ Not signed in", enabled: false },
    { label: usageLabel(), enabled: false },
    { type: "separator" },
    gatewayProc
      ? { label: "Stop gateway", click: stopGateway }
      : { label: "Start gateway", click: startGateway },
    { label: "Sign in to OpenRouter…", click: signIn },
    { label: "Configure Claude Desktop", click: configureClaude },
    { label: "Restore official Claude Desktop", click: restoreClaude },
    { type: "separator" },
    { label: `Model: ${settings.upstreamModel}`, enabled: false },
    { label: "Settings…", click: showWindow },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        stopGateway();
        app.quit();
      },
    },
  ]);
}

function updateUI() {
  if (tray) {
    tray.setContextMenu(buildMenu());
    tray.setToolTip(`Claude × OpenRouter — ${statusLabel()}`);
    tray.setImage(trayImage());
  }
  if (win && !win.isDestroyed()) win.webContents.send("state", getState());
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 540,
    height: 760,
    resizable: true,
    title: "Claude × OpenRouter",
    icon: path.join(here, "assets", "icon.png"),
    webPreferences: { preload: path.join(here, "preload.cjs") },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(here, "settings.html"));
  win.on("closed", () => {
    win = null;
  });
}

ipcMain.handle("get-state", () => getState());
ipcMain.handle("get-logs", () => logBuffer.slice());
ipcMain.handle("sign-in", () => signIn());
ipcMain.handle("configure", () => configureClaude());
ipcMain.handle("restore", () => restoreClaude());
ipcMain.handle("start-gateway", () => startGateway());
ipcMain.handle("stop-gateway", () => stopGateway());
ipcMain.handle("save-settings", (_event, patch) => {
  const restartNeeded =
    gatewayProc &&
    ["host", "port", "upstreamModel", "routeModel"].some(
      (key) => key in patch && patch[key] !== settings[key],
    );
  settings = { ...settings, ...patch };
  saveSettings(settings);
  if ("autostart" in patch) applyAutostart(settings.autostart);
  if (restartNeeded) {
    pushLog("settings changed — restarting gateway");
    // The "exit" handler set in startGateway() clears gatewayProc, so relaunch after it fires.
    gatewayProc.once("exit", () => startGateway());
    stopGateway();
  }
  updateUI();
  return getState();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(() => {
    if (process.platform === "darwin") app.dock?.hide();
    tray = new Tray(trayImage());
    tray.on("click", showWindow);
    updateUI();
    if (settings.startGatewayOnLaunch && hasAuth()) startGateway();
    pollHealth();
    setInterval(pollHealth, 4000);
  });
  // Keep running in the tray after the settings window is closed.
  app.on("window-all-closed", () => {});
  app.on("before-quit", stopGateway);
}
