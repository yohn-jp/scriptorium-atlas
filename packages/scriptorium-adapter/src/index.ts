import { AtlasHostError } from '@scriptorium-atlas/contracts/errors';

export interface ScriptoriumAdapter {
  readonly status: 'unavailable';
  connect(): Promise<never>;
}

/** The public Scriptorium SDK is not available in this repository yet. */
export function createScriptoriumAdapter(): ScriptoriumAdapter {
  return {
    status: 'unavailable',
    async connect(): Promise<never> {
      throw new AtlasHostError(
        'SCRIPTORIUM_HOST_UNAVAILABLE',
        'The public Scriptorium Plugin SDK is not available in this environment.',
      );
    },
  };
}
