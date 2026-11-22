// The renderer only talks to window.flowstate (preload). In a plain browser we fall back to a mock.
import { createMockApi } from './mock-api.js';

let api = null;

export function getApi() {
  // ?mock=1 forces the mock even inside Electron (visual checks); production never sets it.
  const forceMock = typeof location !== 'undefined' && /[?&]mock=1/.test(location.search);
  if (!api) api = typeof window !== 'undefined' && window.flowstate && !forceMock ? window.flowstate : createMockApi();
  return api;
}

export function isMockApi() {
  return !!getApi().isMock;
}
