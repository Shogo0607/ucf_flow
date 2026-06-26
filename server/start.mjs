import { listenBackend } from "./backend.mjs";
import { listenFrontend } from "./frontend.mjs";

const shutdownSignals = ["SIGINT", "SIGTERM"];

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function closeStartedServers(servers) {
  const results = await Promise.allSettled(servers.map(closeServer));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function main() {
  const servers = [];
  const backend = await listenBackend();
  servers.push(backend.server);

  let frontend;
  try {
    frontend = await listenFrontend();
    servers.push(frontend.server);
  } catch (err) {
    await closeStartedServers(servers);
    throw err;
  }

  console.log(`Backend:  http://${backend.host}:${backend.port}`);
  console.log(`Health:   http://${backend.host}:${backend.port}/api/health`);
  console.log(`Frontend: http://${frontend.host}:${frontend.port}`);
  console.log("");
  console.log("Press Ctrl+C to stop both servers.");

  let isShuttingDown = false;
  async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    try {
      await closeStartedServers(servers);
      process.exit(0);
    } catch (err) {
      console.error(`Failed to stop dev servers after ${signal}: ${err.message}`);
      process.exit(1);
    }
  }

  for (const signal of shutdownSignals) {
    process.once(signal, () => shutdown(signal));
  }
}

main().catch((err) => {
  console.error(`Failed to start dev servers: ${err.message}`);
  process.exit(1);
});
