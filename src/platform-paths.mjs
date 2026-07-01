import os from "node:os";
import path from "node:path";

function homeDir() {
  const home = os.homedir() || process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("Could not determine the current user's home directory.");
  return home;
}

function windowsLocalAppData() {
  return (
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local")
      : path.join(homeDir(), "AppData", "Local"))
  );
}

export function userConfigDir(appName) {
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support", appName);
  }

  if (process.platform === "win32") {
    return path.join(windowsLocalAppData(), appName);
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
  return path.join(configHome, appName);
}

export function defaultClaude3pDir() {
  if (process.env.CLAUDE_3P_DIR) return path.resolve(process.env.CLAUDE_3P_DIR);
  return userConfigDir("Claude-3p");
}

export function defaultOpenRouterAuthFile() {
  if (process.env.OPENROUTER_AUTH_FILE) {
    return path.resolve(process.env.OPENROUTER_AUTH_FILE);
  }

  return path.join(userConfigDir("claude-openrouter-gateway"), "openrouter.json");
}

export function defaultOpenCodeAuthFile() {
  if (process.env.OPENCODE_OAUTH_FILE) {
    return path.resolve(process.env.OPENCODE_OAUTH_FILE);
  }

  return path.join(userConfigDir("claude-openrouter-gateway"), "opencode.json");
}
