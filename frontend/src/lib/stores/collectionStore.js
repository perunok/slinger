import { writable } from 'svelte/store';

export const collectionStore = writable([
  {
    id: 1,
    name: 'Sample Collection',
    requests: [
      { id: 1, method: 'GET', url: 'https://api.example.com/users' },
      { id: 2, method: 'POST', url: 'https://api.example.com/users' }
    ]
  }
]);