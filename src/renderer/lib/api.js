// The renderer only talks to window.flowstate (preload). In a plain browser we fall back to a mock.
import { createMockApi } from './mock-api.js';

let api = null;

export function getApi() {
  if (!api) api = typeof window !== 'undefined' && window.flowstate ? window.flowstate : createMockApi();
  return api;
}

export function isMockApi() {
  return !!getApi().isMock;
}
