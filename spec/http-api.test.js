"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function getUnusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const outgoing = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            statusCode: incoming.statusCode,
            headers: incoming.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.once("error", reject);
  });
}

async function startServer(cwd, httpPort) {
  const entrypoint = path.resolve(__dirname, "../ygopro-server.js");
  const child = spawn(process.execPath, [entrypoint], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited before becoming ready:\n${output}`);
    }
    try {
      await request(httpPort, "/api/getroomscount?username=arena&pass=secret");
      return child;
    } catch (error) {
      if (error.code !== "ECONNREFUSED") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  child.kill();
  throw new Error(`server did not become ready:\n${output}`);
}

function stopServer(child) {
  if (child.exitCode != null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
}

test("HTTP APIs expose a stable server instance ID that changes after restart", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "srvpro-http-api-"));
  const tcpPort = await getUnusedPort();
  const httpPort = await getUnusedPort();
  fs.cpSync(path.resolve(__dirname, "../data"), path.join(cwd, "data"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(cwd, "config"));
  fs.writeFileSync(
    path.join(cwd, "config", "config.json"),
    JSON.stringify({
      port: tcpPort,
      modules: {
        http: {
          port: httpPort,
          public_roomlist: false,
          ssl: { enabled: false },
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(cwd, "config", "admin_user.json"),
    JSON.stringify({ users: { arena: "secret" } }),
  );

  let child;
  t.after(async () => {
    if (child) {
      await stopServer(child);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  child = await startServer(cwd, httpPort);
  const countResponse = await request(
    httpPort,
    "/api/getroomscount?username=arena&pass=secret",
  );
  const countBody = JSON.parse(countResponse.text);
  assert.equal(countResponse.statusCode, 200);
  assert.equal(countBody.count, 0);
  assert.match(
    countBody.serverInstanceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    countResponse.headers["x-server-instance-id"],
    countBody.serverInstanceId,
  );

  const messageResponse = await request(
    httpPort,
    "/api/message?kick=missing&username=arena&pass=secret",
  );
  assert.equal(
    messageResponse.headers["x-server-instance-id"],
    countBody.serverInstanceId,
  );

  const unauthorizedResponse = await request(httpPort, "/api/getroomscount");
  assert.equal(unauthorizedResponse.statusCode, 403);
  assert.equal(
    JSON.parse(unauthorizedResponse.text).serverInstanceId,
    countBody.serverInstanceId,
  );

  await stopServer(child);
  child = null;
  child = await startServer(cwd, httpPort);
  const restartedResponse = await request(
    httpPort,
    "/api/getroomscount?username=arena&pass=secret",
  );
  const restartedBody = JSON.parse(restartedResponse.text);
  assert.notEqual(restartedBody.serverInstanceId, countBody.serverInstanceId);
  assert.equal(
    restartedResponse.headers["x-server-instance-id"],
    restartedBody.serverInstanceId,
  );
});
