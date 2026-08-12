#!/usr/bin/env node
// Send a rebuild + restart request to the root codex-web-reloader service.
import { readFile } from "node:fs/promises";

const url = process.env.CODEX_WEB_RELOADER_URL ?? "http://127.0.0.1:37822";
const tokenFile = process.env.CODEX_WEB_RELOADER_TOKEN_FILE ?? "/etc/codex-web-reloader/token";

let token;
try {
  token = (await readFile(tokenFile, "utf8")).trim();
} catch {
  console.error(`cannot read ${tokenFile}; install codex-web-reloader as root once with:`);
  console.error("  sudo ./deploy/install-codex-web-reloader.sh");
  process.exit(2);
}

const response = await fetch(`${url}/restart`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ command: "restart" }),
});

const text = await response.text();
if (!response.ok) {
  let body = null;
  try { body = JSON.parse(text); } catch { /* Non-JSON error body. */ }
  if (body?.state === "busy") {
    console.error("Codex Web 仍有任务正在运行，本次未重启。任务完成后请重新运行 npm run reload。");
  } else {
    console.error(text || `HTTP ${response.status}`);
  }
  process.exit(1);
}
let body = null;
try { body = JSON.parse(text); } catch { /* Non-JSON success body. */ }
if (body?.state === "waiting") {
  console.log(body.message || "Codex Web 仍有任务运行，已排队等待自动重启。");
} else {
  console.log(text);
}
