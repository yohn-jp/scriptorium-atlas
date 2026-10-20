import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("Story worker harness requires a parent port.");

Object.defineProperty(globalThis, "postMessage", {
  configurable: true,
  value: (message) => parentPort.postMessage(message),
});
Object.defineProperty(globalThis, "onmessage", {
  configurable: true,
  set(handler) {
    if (typeof handler !== "function") throw new TypeError("Story worker requires an onmessage handler.");
    parentPort.on("message", (data) => handler({ data }));
  },
});

await import("../src/domain/index.worker.ts");
