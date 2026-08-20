/**
 * DI tokens for the two independent Redis connections.
 *
 * Two tokens, never one, because §6.2 of the Phase 1 design is explicit that
 * queue and cache are SEPARATE SERVERS in production (different
 * maxmemory-policy, different persistence). Keeping them behind distinct
 * tokens makes it structurally impossible for a provider to accidentally
 * wire the wrong connection into the wrong consumer — the injector would
 * have to be told to do the wrong thing by name.
 */
export const QUEUE_REDIS = Symbol('QUEUE_REDIS');
export const CACHE_REDIS = Symbol('CACHE_REDIS');
