import type { ArgumentMetadata } from '@nestjs/common';

import { PrimitiveTransformPipe } from './primitive-transform.pipe';

function meta(type: ArgumentMetadata['type'], metatype: ArgumentMetadata['metatype']): ArgumentMetadata {
  return { type, metatype, data: undefined };
}

describe('PrimitiveTransformPipe', () => {
  const pipe = new PrimitiveTransformPipe();

  it('coerces a numeric-looking param string to a number', () => {
    expect(pipe.transform('42', meta('param', Number))).toBe(42);
  });

  it('coerces a numeric-looking query string to a number', () => {
    expect(pipe.transform('7', meta('query', Number))).toBe(7);
  });

  it('leaves a non-numeric string unchanged when it cannot be coerced', () => {
    expect(pipe.transform('not-a-number', meta('param', Number))).toBe('not-a-number');
  });

  it('coerces "true"/"false" query strings to booleans', () => {
    expect(pipe.transform('true', meta('query', Boolean))).toBe(true);
    expect(pipe.transform('false', meta('query', Boolean))).toBe(false);
  });

  it('leaves body values untouched (only param/query are coerced)', () => {
    expect(pipe.transform('42', meta('body', Number))).toBe('42');
  });

  it('passes class-shaped (non-primitive) values through unchanged', () => {
    class SomeDto {}
    const value = { anything: 'goes' };
    expect(pipe.transform(value, meta('body', SomeDto))).toBe(value);
  });

  it('passes values through when there is no metatype at all', () => {
    expect(pipe.transform('x', meta('param', undefined))).toBe('x');
  });
});
