import { describe, expect, it } from 'vitest';

describe('web test environment', () => {
  it('has a DOM and DOMParser (happy-dom)', () => {
    const doc = new DOMParser().parseFromString('<p>x</p>', 'text/html');
    expect(doc.body.textContent).toBe('x');
  });
});
