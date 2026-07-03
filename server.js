const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const APP_FILE = path.join(__dirname, "长效八缓冲液配制量计算APP-v12.html");
const LEGACY_DATA_DIR = path.join(__dirname, "data");
const DATA_DIR = path.resolve(process.env.BUFFER_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, "..", "buffer-data"));
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LEGACY_STATE_FILE = path.join(LEGACY_DATA_DIR, "state.json");
const MAX_BODY_BYTES = 1024 * 1024;

let shared = { version: 0, state: {} };
let startupBackupDone = false;
const clients = new Set();

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(payload);
}

function unauthorized(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Buffer App"',
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end("需要输入访问密码");
}

function isAuthorized(req) {
  const password = process.env.APP_PASSWORD;
  if (!password) return true;
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) return false;
  const raw = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const index = raw.indexOf(":");
  const user = index >= 0 ? raw.slice(0, index) : "";
  const pass = index >= 0 ? raw.slice(index + 1) : raw;
  const expectedUser = process.env.APP_USER || "buffer";
  const passBuffer = Buffer.from(pass);
  const expectedBuffer = Buffer.from(password);
  return user === expectedUser && passBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(passBuffer, expectedBuffer);
}

async function ensureStateLoaded() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (STATE_FILE !== LEGACY_STATE_FILE && !(await fileExists(STATE_FILE)) && await fileExists(LEGACY_STATE_FILE)) {
    await fs.copyFile(LEGACY_STATE_FILE, STATE_FILE);
    console.log(`已把旧数据迁移到仓库外：${STATE_FILE}`);
  }

  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      shared = {
        version: Number(parsed.version) || 0,
        state: parsed.state && typeof parsed.state === "object" ? parsed.state : {}
      };
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("读取共享数据失败，已使用空数据启动：", err.message);
      await backupCurrentState("corrupt");
    }
    await saveState();
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function backupCurrentState(reason = "backup") {
  if (startupBackupDone || !(await fileExists(STATE_FILE))) return;
  startupBackupDone = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(DATA_DIR, "backups");
  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(STATE_FILE, path.join(backupDir, `state-${reason}-${stamp}.json`));
}

async function saveState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await backupCurrentState("before-write");
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(shared, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
}

function broadcastState(originClientId = "") {
  const payload = `event: state\ndata: ${JSON.stringify({ ...shared, originClientId })}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求数据过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveApp(res) {
  const html = await fs.readFile(APP_FILE, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

async function handle(req, res) {
  if (!isAuthorized(req)) {
    unauthorized(res);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && (url.pathname === "/" || decodeURIComponent(url.pathname.slice(1)) === path.basename(APP_FILE))) {
    await serveApp(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    send(res, 200, shared);
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/state") {
    const body = await readBody(req);
    const data = JSON.parse(body || "{}");
    if (!data.state || typeof data.state !== "object") {
      send(res, 400, { error: "state 必须是对象" });
      return;
    }
    const originClientId = typeof data.clientId === "string" ? data.clientId : "";
    shared = {
      version: Date.now(),
      state: data.state
    };
    await saveState();
    broadcastState(originClientId);
    send(res, 200, shared);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(`event: state\ndata: ${JSON.stringify(shared)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  send(res, 404, { error: "Not found" });
}

ensureStateLoaded().then(() => {
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "服务器处理失败" });
      else res.end();
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`长效八缓冲液 APP 已启动：http://${HOST}:${PORT}`);
    console.log(`共享数据文件：${STATE_FILE}`);
  });
});
