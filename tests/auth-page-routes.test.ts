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

  it('renders the signed-in home with escaped identity and sends an anonymous one to sign-in', async () => {
    const anonymous = await authPages.request('/home');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('Location')).toBe('/sign-in?returnTo=%2Fhome');
    const response = await signedIn({ id: 'user-a', name: '<Ada> & co', email: '<ada>@example.test' }).request('/home');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>Home — Rendro</title>');
    expect(html).toContain('<h1>Welcome, &lt;Ada&gt; &amp; co</h1>');
    expect(html).toContain('<strong>&lt;ada&gt;@example.test</strong>');
    expect(html).not.toContain('<Ada>');
    expect(html).toContain('<code>/r/{owner}/{repo}</code>');
    expect(html).toContain('<a href="/account/security">Account security</a>');
    expect(html).toContain('<form method="post" action="/api/auth/sign-out"><button type="submit">Sign out</button></form>');
    // A partial identity renders empty fields, never "undefined".
    const partial = await (await signedIn({ id: 'user-b' }).request('/home')).text();
    expect(partial).toContain('<h1>Welcome, </h1>');
    expect(partial).toContain('<strong></strong>');
    expect(partial).not.toContain('undefined');
  });

  it.each(['https://outside.invalid', '//outside.invalid', '/\\outside.invalid', '/\u0001invalid', '/\u007finvalid'])('rejects unsafe returnTo %j', async destination => {
    const response = await signedIn().request(`/sign-in?returnTo=${encodeURIComponent(destination)}`);
    expect(response.headers.get('Location')).toBe('/');
  });

  // The query value is decoded once by the router, so an encoded variant arrives here as its decoded form; anything
  // that is not a rooted, single-slash, control-free path falls back to the home page.
  it.each([
    '//outside.invalid/path', '///outside.invalid', '/\\/outside.invalid', '\\\\outside.invalid', 'http://outside.invalid', 'HTTPS://outside.invalid',
    'javascript:alert(1)', 'data:text/html,x', 'outside.invalid/path', ' //outside.invalid', '/\t/outside.invalid', '/\n/outside.invalid', '/\r/outside.invalid',
    '%2F%2Foutside.invalid', '%252F%252Foutside.invalid', 'https:%2F%2Foutside.invalid', '', '?x=/',
  ])('falls back to the home page for returnTo %j, raw and encoded', async destination => {
    for (const query of [`returnTo=${encodeURIComponent(destination)}`, `returnTo=${encodeURIComponent(destination).replace(/%2F/g, '/')}`]) {
      for (const path of ['/sign-in', '/sign-up']) {
        const response = await signedIn().request(`${path}?${query}`);
        expect(response.headers.get('Location'), `${path}?${query}`).toBe('/');
      }
    }
  });

  it.each(['/organizations/o/projects/p/docs?doc=guide%2Fintro.html', '/organizations/o/projects/p/docs?doc=a.html&docQuery=%3Fv%3D1', '/%2F%2Foutside.invalid'])('keeps the rooted path %j, query included', async destination => {
    const response = await signedIn().request(`/sign-in?returnTo=${encodeURIComponent(destination)}`);
    expect(response.headers.get('Location')).toBe(destination);
  });

  it.each(['INVALID_TOKEN', 'token_expired', 'something_new', ''])('never reports success for a verification link that arrives with error=%j', async (error) => {
    for (const query of [`error=${error}`, `verified=1&error=${error}&returnTo=%2Faccount%2Fsecurity`]) {
      const html = await (await authPages.request(`/verify-email?${query}`)).text();
      expect(html).not.toContain('Email verified');
      expect(html).not.toContain('Continue to sign in');
      expect(html).toContain('<h1 tabindex="-1" data-autofocus>Verification link unavailable</h1>');
      expect(html).toContain('<p role="alert" class="message error reset-invalid">This verification link is invalid or has expired.');
      expect(html).toContain('id="resend-form"');
      expect(html).not.toContain(error ? `>${error}<` : 'undefined');
    }
    expect(await (await authPages.request('/verify-email?error=INVALID_TOKEN&returnTo=%2Faccount%2Fsecurity')).text()).toContain('"returnTo":"/account/security"');
  });

  it('keeps the plain verification page free of the invalid-link state', async () => {
    const html = await (await authPages.request('/verify-email')).text();
    expect(html).toContain('Verify your email');
    expect(html).not.toContain(' data-autofocus>');
    expect(html).not.toContain('invalid or has expired');
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
