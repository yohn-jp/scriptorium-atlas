import type { GraphWorkerRequest } from './protocol.js';
import { createGraphWorkerMessageHandler } from './engine.js';

const workerScope = globalThis as unknown as DedicatedWorkerGlobalScope;
const handleGraphWorkerMessage = createGraphWorkerMessageHandler((response) => workerScope.postMessage(response));

workerScope.addEventListener('message', (event: MessageEvent<GraphWorkerRequest>) => {
  handleGraphWorkerMessage(event.data);
});
