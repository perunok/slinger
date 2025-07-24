import { writable } from 'svelte/store';

export const historyStore = writable([]);

export function addToHistory(request) {
  historyStore.update(history => [
    { ...request, id: Date.now() },
    ...history.slice(0, 9) 
  ]);
}