import { EventEmitter } from 'events';
import type { BenchEvent } from './types.js';

export const benchEmitter = new EventEmitter();

export function emitBenchEvent(event: BenchEvent) {
  benchEmitter.emit('event', event);
}
