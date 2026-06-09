import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const root = resolve(process.cwd(), "dashboard");
const port = Number(process.env.FRONTEND_PORT ?? 5173);
const host = process.env.FRONTEND_HOST ?? "127.0.0.1";
const backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:3000";
const backendWsUrl = backendUrl.replace(/^http/, "ws");
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const asset = assetPath(url.pathname);

    if (asset) {
      const body = await readFile(join(root, asset));
      response.writeHead(200, {
        "content-type": contentTypes[extname(asset)] ?? "text/plain",
      });
      response.end(body);
      return;
    }

    await proxyHttpRequest(request, response, url.pathname + url.search);
  } catch (error) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end(
      error instanceof Error ? error.message : "Dashboard asset not found",
    );
  }
});

const wsServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (client) => {
    const upstream = new WebSocket(`${backendWsUrl}/ws`);
    upstream.on(
      "message",
      (message) => client.readyState === WebSocket.OPEN && client.send(message),
    );
    client.on(
      "message",
      (message) =>
        upstream.readyState === WebSocket.OPEN && upstream.send(message),
    );
    upstream.on("open", () => undefined);
    upstream.on("close", () => client.close());
    upstream.on("error", () => client.close());
    client.on("close", () => upstream.close());
  });
});

server.listen(port, host, () => {
  console.log(`Dashboard dev server: http://${host}:${port}/dashboard`);
  console.log(`Proxying API/WebSocket requests to ${backendUrl}`);
  console.log(
    "Run the backend separately with npm run local:backend, or use npm run demo:full.",
  );
});

function assetPath(pathname: string): string | null {
  if (pathname === "/" || pathname === "/dashboard") return "index.html";
  const withoutPrefix = pathname.startsWith("/dashboard/")
    ? pathname.slice("/dashboard/".length)
    : pathname.slice(1);
  if (!["app.js", "styles.css", "index.html"].includes(withoutPrefix))
    return null;
  const safeAsset = normalize(withoutPrefix).replace(/^([/\\])+/, "");
  if (safeAsset.includes("..")) throw new Error("Invalid asset path");
  return safeAsset;
}

async function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  path: string,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));

  const upstream = await fetch(`${backendUrl}${path}`, {
    method: request.method,
    headers: request.headers as Record<string, string>,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });

  response.writeHead(
    upstream.status,
    Object.fromEntries(upstream.headers.entries()),
  );
  response.end(Buffer.from(await upstream.arrayBuffer()));
}
