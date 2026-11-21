// Replay persisted chat history through the pure reducer (no DOM).
import { createChatState, reduceEvent, addUserMessage } from './events.js';

/**
 * records: HistoryRecord[] = { ts, t:'user', text } | { ts, t:'event', event }.
 * Returns a chat state with the replayed messages; nothing is running afterwards.
 */
export function replayHistory(records, base) {
  let state = base || createChatState();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== 'object') continue;
    if (r.t === 'user' && typeof r.text === 'string') state = addUserMessage(state, r.text);
    else if (r.t === 'event' && r.event) state = reduceEvent(state, r.event);
  }
  return { ...state, running: false };
}

const DEDUPE_TYPES = new Set(['session', 'tool-use', 'tool-result', 'result', 'error', 'text', 'permission-request', 'permission-denied']);

/**
 * Drop buffered live events that are already present among the last records (history was read after the
 * backend persisted them). Only whole-event types are compared; text-delta is never persisted.
 */
export function dedupeLive(records, events, window = 30) {
  const tail = new Set();
  const list = Array.isArray(records) ? records : [];
  for (let i = Math.max(0, list.length - window); i < list.length; i++) {
    if (list[i] && list[i].t === 'event' && list[i].event) tail.add(JSON.stringify(list[i].event));
  }
  return (events || []).filter((ev) => !(ev && DEDUPE_TYPES.has(ev.type) && tail.has(JSON.stringify(ev))));
}
