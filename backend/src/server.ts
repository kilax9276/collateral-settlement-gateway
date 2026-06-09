import { buildApp } from "./app.js";
import { config } from "./config.js";

const { app } = await buildApp(config);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Backend is running on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
