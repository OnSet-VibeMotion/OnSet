import { expect, it } from 'vitest';
import { rendererFailureAdvice } from './failure';

it('does not confuse an unrelated HTTP 401 with an expired model login', () => {
  expect(rendererFailureAdvice('asset server returned 401 Unauthorized')).toBeNull();
  expect(rendererFailureAdvice('OAuth token revoked')?.code).toBe('authentication');
  expect(rendererFailureAdvice('login rejected: unauthorized')?.code).toBe('authentication');
});
