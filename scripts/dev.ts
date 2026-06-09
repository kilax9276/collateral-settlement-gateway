process.env.ENABLE_DEMO_ROUTES = process.env.ENABLE_DEMO_ROUTES ?? "true";
process.env.HOST = process.env.HOST ?? "0.0.0.0";

await import("../backend/src/server.js");
