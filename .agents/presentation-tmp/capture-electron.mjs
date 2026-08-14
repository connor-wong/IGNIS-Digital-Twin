import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const projectDir = "C:/Users/wongz/OneDrive/Documents/Gripper Digital Twin";
const electronExe = `${projectDir}/node_modules/electron/dist/electron.exe`;
const captureTheme = process.env.CAPTURE_THEME;
const outPath = `${projectDir}/artifacts/digital-twin-${captureTheme || 'current-interface'}.png`;
const debugPort = 9338;
const rendererPort = 5179;
const rendererDir = `${projectDir}/out/renderer`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html";
  if (ext === ".js") return "text/javascript";
  if (ext === ".css") return "text/css";
  if (ext === ".png") return "image/png";
  if (ext === ".glb") return "model/gltf-binary";
  return "application/octet-stream";
}

function startRendererServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${rendererPort}`);
      const cleanPath = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
      const target = path.normalize(path.join(rendererDir, cleanPath));
      if (!target.startsWith(path.normalize(rendererDir))) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const bytes = await fs.readFile(target);
      res.writeHead(200, { "content-type": contentType(target) });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(rendererPort, "127.0.0.1", () => resolve(server));
  });
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const callId = ++id;
          socket.send(JSON.stringify({ id: callId, method, params }));
          return new Promise((callResolve, callReject) => {
            pending.set(callId, { resolve: callResolve, reject: callReject });
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("error", reject);
  });
}

async function main() {
  await fs.mkdir(`${projectDir}/artifacts`, { recursive: true });
  const server = await startRendererServer();

  const child = spawn(electronExe, [`--remote-debugging-port=${debugPort}`, projectDir], {
    cwd: projectDir,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: `http://127.0.0.1:${rendererPort}/index.html`,
    },
  });

  try {
    let target;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
        target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (target) break;
      } catch {
        // Keep polling until Electron opens the renderer target.
      }
      await sleep(250);
    }

    if (!target) throw new Error("Could not find Electron renderer target.");

    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    if (captureTheme === "light" || captureTheme === "dark") {
      await cdp.send("Runtime.evaluate", {
        expression: `localStorage.setItem("ignis-theme", "${captureTheme}"); location.reload();`,
      });
      await sleep(1000);
    }
    await cdp.send("Runtime.evaluate", {
      expression: "document.fonts ? document.fonts.ready.then(() => true) : true",
      awaitPromise: true,
    });
    await sleep(2500);
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await fs.writeFile(outPath, Buffer.from(screenshot.data, "base64"));
    cdp.close();
    console.log(outPath);
  } finally {
    child.kill();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
