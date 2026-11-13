import { after } from 'node:test';

export function guardNetwork() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network disabled in tests: inject a fake fetchImpl'); };
  after(() => { globalThis.fetch = realFetch; });
}
