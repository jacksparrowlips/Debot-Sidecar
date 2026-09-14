import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import Fastify from "fastify";
import { broadcast, registerWs, setExtMessageHandler, uiConnectionCount } from "../src/gateway/ws.js";

test("extension uplink and extension/UI broadcasts survive the WS handshake", { timeout: 5000 }, async () => {
  const app = Fastify();
  await registerWs(app);
  await app.ready();
  const ext = await app.injectWS("/ext");
  const ui = await app.injectWS("/ui");
  try {
    assert.equal(uiConnectionCount(), 1);
    const uplink = new Promise((resolve) => setExtMessageHandler(resolve));
    const health = { type: "tab.health", tabId: 1, url: "https://debot.ai/", signalSilenceMs: 0, loginState: "ok" };
    ext.send(JSON.stringify(health));
    assert.deepEqual(await uplink, health);
    const received = [once(ext, "message"), once(ui, "message")];
    const alert = { type: "alert", level: "warn", message: "WS regression check" } as const;
    broadcast(alert);
    for (const [data] of await Promise.all(received)) {
      assert.deepEqual(JSON.parse(String(data)), alert);
    }
  } finally {
    ext.terminate();
    ui.terminate();
    await app.close();
  }
});
