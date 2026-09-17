import type { Plugin } from 'vitest/config';

/**
 * Bundler plugin that inlines `.md` / `.yaml` sources as raw strings so prompt
 * and profile files can be imported directly:
 *
 *   import description from './grep.md';
 *
 * Shared by tsdown (build) and vitest (test) so both resolve these imports
 * identically. Declared here so a `vitest.config.ts` that imports the plugin
 * can be type-checked.
 */
export declare function rawTextPlugin(): Plugin;
