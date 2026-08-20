import { bigintTransformer, numericTransformer } from './transformers';

describe('bigintTransformer', () => {
  it('converts a small bigint string to a number on read', () => {
    expect(bigintTransformer.from('42')).toBe(42);
  });

  it('passes null through on read', () => {
    expect(bigintTransformer.from(null)).toBeNull();
  });

  it('throws rather than silently losing precision above MAX_SAFE_INTEGER', () => {
    const tooLarge = (Number.MAX_SAFE_INTEGER + 2).toString();
    expect(() => bigintTransformer.from(tooLarge)).toThrow(RangeError);
  });

  it('accepts exactly MAX_SAFE_INTEGER', () => {
    expect(bigintTransformer.from(Number.MAX_SAFE_INTEGER.toString())).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('passes a number through unchanged on write, and null/undefined to null', () => {
    expect(bigintTransformer.to(7)).toBe(7);
    expect(bigintTransformer.to(null)).toBeNull();
    expect(bigintTransformer.to(undefined)).toBeNull();
  });
});

describe('numericTransformer', () => {
  it('converts a numeric string to a number on read', () => {
    expect(numericTransformer.from('5.230')).toBeCloseTo(5.23);
  });

  it('passes null through on read', () => {
    expect(numericTransformer.from(null)).toBeNull();
  });

  it('passes a number through unchanged on write, and null/undefined to null', () => {
    expect(numericTransformer.to(1.5)).toBe(1.5);
    expect(numericTransformer.to(null)).toBeNull();
    expect(numericTransformer.to(undefined)).toBeNull();
  });
});
