const $ = (id) => document.getElementById(id);
const logEl = $("log");

function appendLog(line) {
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  logEl.textContent += (logEl.textContent ? "\n" : "") + line;
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// Inputs the user may be editing; don't clobber them on every state push.
const editable = ["upstreamModel", "routeModel", "host", "port"];
let dirty = false;
for (const id of editable) {
  $(id).addEventListener("input", () => {
    dirty = true;
  });
}

function render(state) {
  const { running, healthy, signedIn, settings } = state;

  const trayDot = $("trayDot");
  trayDot.className = "dot " + (running && healthy ? "green" : running ? "amber" : "");

  $("gwDot").className = "dot " + (running && healthy ? "green" : running ? "amber" : "red");
  $("gwText").textContent = running ? (healthy ? "Gateway running" : "Gateway starting…") : "Gateway stopped";
  $("toggleBtn").textContent = running ? "Stop" : "Start";

  $("authDot").className = "dot " + (signedIn ? "green" : "red");
  $("authText").textContent = signedIn ? "Signed in to OpenRouter" : "Not signed in";

  if (!dirty) {
    $("upstreamModel").value = settings.upstreamModel;
    $("routeModel").value = settings.routeModel;
    $("host").value = settings.host;
    $("port").value = settings.port;
  }
  $("autostart").checked = !!settings.autostart;
  $("startOnLaunch").checked = !!settings.startGatewayOnLaunch;
}

async function refresh() {
  render(await window.api.getState());
}

$("toggleBtn").addEventListener("click", async () => {
  const state = await window.api.getState();
  await (state.running ? window.api.stopGateway() : window.api.startGateway());
  refresh();
});

$("signInBtn").addEventListener("click", () => window.api.signIn());
$("configureBtn").addEventListener("click", () => window.api.configure());
$("restoreBtn").addEventListener("click", () => window.api.restore());

$("saveBtn").addEventListener("click", async () => {
  const port = parseInt($("port").value, 10);
  await window.api.saveSettings({
    upstreamModel: $("upstreamModel").value.trim(),
    routeModel: $("routeModel").value.trim(),
    host: $("host").value.trim() || "127.0.0.1",
    port: Number.isFinite(port) ? port : 8787,
  });
  dirty = false;
  refresh();
});

$("autostart").addEventListener("change", (e) =>
  window.api.saveSettings({ autostart: e.target.checked }),
);
$("startOnLaunch").addEventListener("change", (e) =>
  window.api.saveSettings({ startGatewayOnLaunch: e.target.checked }),
);

window.api.onLog(appendLog);
window.api.onState(render);

(async () => {
  for (const line of await window.api.getLogs()) appendLog(line);
  refresh();
})();
