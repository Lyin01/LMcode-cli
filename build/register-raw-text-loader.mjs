import { register } from 'node:module';

/**
 * Registers the source-execution hooks. Pass to Node via `--import` (alongside
 * tsx) so package-local imports and raw prompt files resolve without a bundle.
 */
register('./package-imports-loader.mjs', import.meta.url);
register('./raw-text-loader.mjs', import.meta.url);
