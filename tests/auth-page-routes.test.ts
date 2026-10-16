import type { User } from 'better-auth/types';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import authPages from '@/routes/auth-pages';

function signedIn(user: Partial<User> = { id: 'user-a', email: '<person>@example.test' }) {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use('*', async (c, next) => { c.set('user', user as User); await next(); });
  return app.route('/', authPages);
}

describe('auth route rendering boundaries', () => {
  it.each(['access_denied', 'state_mismatch', 'state_security_mismatch', 'state_not_found', 'invalid_state', 'unable_to_link_account', 'account_not_linked', 'account_already_linked_to_different_user', "email_doesn't_match", 'email_not_verified', '<unknown>'])('renders safe recovery for %s even with an existing session', async error => {
    const response = await signedIn().request(`/sign-in?error=${encodeURIComponent(error)}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="form-error" role="alert">');
    expect(html).not.toContain('<unknown>');
    expect(html).toContain('id="google-auth"');
  });

  it('redirects signed-in forms and denies anonymous account access', async () => {
    for (const path of ['/sign-in', '/sign-up']) {
      const response = await signedIn().request(`${path}?returnTo=%2Faccount%2Fsecurity`);
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/account/security');
    }
    const response = await authPages.request('/account/security');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/sign-in?returnTo=%2Faccount%2Fsecurity');
  });

  it.each(['https://outside.invalid', '//outside.invalid', '/\\outside.invalid', '/\u0001invalid', '/\u007finvalid'])('rejects unsafe returnTo %j', async destination => {
    const response = await signedIn().request(`/sign-in?returnTo=${encodeURIComponent(destination)}`);
    expect(response.headers.get('Location')).toBe('/');
  });

  it('renders verification completion and safely handles missing profile email', async () => {
    const verified = await (await authPages.request('/verify-email?verified=1')).text();
    expect(verified).toContain('Email verified');
    expect(verified).not.toContain('id="resend-form"');
    const security = await (await signedIn({ id: 'user-a' }).request('/account/security')).text();
    expect(security).toContain('sign in as <strong></strong>');
    expect(await (await signedIn().request('/account/security')).text()).toContain('&lt;person&gt;@example.test');
  });
});
