import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { formatErrorResponse } from "../utils/errors.js";

const dashboardRoot = resolve(process.cwd(), "dashboard");

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/dashboard", { schema: { hide: true } }, async (_request, reply) => {
    const html = await readDashboardFile("index.html");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get(
    "/dashboard/:asset",
    { schema: { hide: true } },
    async (request, reply) => {
      const { asset } = request.params as { asset: string };
      const safeAsset = normalize(asset).replace(/^([/\\])+/, "");
      if (safeAsset.includes("..")) {
        return reply
          .status(404)
          .send(formatErrorResponse("NOT_FOUND", "Dashboard asset not found"));
      }

      const body = await readDashboardFile(safeAsset);
      return reply
        .type(contentTypes[extname(safeAsset)] ?? "text/plain; charset=utf-8")
        .send(body);
    },
  );
}

async function readDashboardFile(relativePath: string): Promise<Buffer> {
  return readFile(join(dashboardRoot, relativePath));
}
