import { listenBackend } from "./backend.mjs";
import { listenFrontend } from "./frontend.mjs";

const shutdownSignals = ["SIGINT", "SIGTERM"];

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function main() {
  const backend = await listenBackend();
  const frontend = await listenFrontend();

  console.log(`Backend:  http://${backend.host}:${backend.port}`);
  console.log(`Health:   http://${backend.host}:${backend.port}/api/health`);
  console.log(`Frontend: http://${frontend.host}:${frontend.port}`);
  console.log("");
  console.log("Press Ctrl+C to stop both servers.");

  async function shutdown() {
    await Promise.all([
      closeServer(backend.server),
      closeServer(frontend.server)
    ]);
    process.exit(0);
  }

  for (const signal of shutdownSignals) {
    process.once(signal, shutdown);
  }
}

main().catch((err) => {
  console.error(`Failed to start dev servers: ${err.message}`);
  process.exit(1);
});
