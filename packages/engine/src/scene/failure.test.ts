import { expect, it } from 'vitest';
import { rendererFailureAdvice } from './failure';

it('does not confuse an unrelated HTTP 401 with an expired model login', () => {
  expect(rendererFailureAdvice('asset server returned 401 Unauthorized')).toBeNull();
  expect(rendererFailureAdvice('OAuth token revoked')?.code).toBe('authentication');
  expect(rendererFailureAdvice('login rejected: unauthorized')?.code).toBe('authentication');
});

it('classifies socket buffer exhaustion during parallel capture', () => {
  expect(rendererFailureAdvice('Page.captureScreenshot failed: net::ERR_NO_BUFFER_SPACE')?.code).toBe(
    'resource_exhaustion',
  );
  expect(rendererFailureAdvice('connect ENOBUFS 127.0.0.1')?.code).toBe('resource_exhaustion');
});
