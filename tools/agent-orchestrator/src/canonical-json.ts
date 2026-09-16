import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item)
    ? item.map(canonical)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]))
      : item;
  return JSON.stringify(canonical(value));
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
