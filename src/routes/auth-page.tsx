import type { User } from "better-auth/types";
import type { SignInMethods } from "@/config";
import { authRefreshStyles, authRuntime, authStyles, safeReturnTo, signInErrorMessage, type AuthPage } from "./auth-pages";
import { CommentRecovery, FaviconLinks, FontHead, ThemeAssets, ThemeButton } from "./head";
import { InlineScript, InlineStyle, renderHtml, scriptJson } from "./trusted-html";

interface AuthPageOptions {
  returnTo?: string;
  token?: string;
  user?: User;
  verified?: boolean;
  error?: string;
  linkInvalid?: boolean;
  /** Sign-in and sign-up (#338): which methods to offer; email alone by default. */
  methods?: SignInMethods;
}

const EMAIL_ONLY: SignInMethods = { github: false, email: true };

// GitHub's mark (Octicons `mark-github`, MIT).
const GITHUB_MARK = "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z";

/** GitHub sign-in (#338): the runtime asks Better Auth for GitHub's authorize URL and follows it. */
function GitHubSignIn({ label, primary, error }: { label: string; primary: boolean; error: string }) {
  return (
    <form id="github-form" class="github-form" novalidate>
      <button class={`button ${primary ? "primary" : "secondary"} github-button`} type="submit">
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d={GITHUB_MARK} /></svg>
        <span class="button-label">{label}</span><span class="spinner" aria-hidden="true"></span>
      </button>
      <p class="message error" id="github-error" role="alert">{error}</p>
    </form>
  );
}

function MethodDivider() {
  return <p class="method-divider"><span>or</span></p>;
}

function Field({ id, label, type, autocomplete, minlength }: {
  id: string; label: string; type: "email" | "password" | "text"; autocomplete: string; minlength?: number;
}) {
  return (
    <div class="field">
      <label for={id}><span>{label}</span></label>
      <span class="input-wrap">
        <input id={id} name={id} type={type} autocomplete={autocomplete} required minlength={minlength} />
        {type === "password" && <button class="reveal" type="button" data-reveal={id} aria-label="Show password">Show</button>}
      </span>
    </div>
  );
}

function SubmitButton({ label, kind = "primary" }: { label: string; kind?: "primary" | "secondary" }) {
  return <button class={`button ${kind}`} type="submit"><span class="button-label">{label}</span><span class="spinner" aria-hidden="true"></span></button>;
}

function StatusHeading({ icon, eyebrow, title }: { icon: string; eyebrow: string; title: string }) {
  return <><span class="status-icon mail"><span class="material-symbols-outlined" aria-hidden="true">{icon}</span></span><p class="eyebrow">{eyebrow}</p><h1>{title}</h1></>;
}

// The loading row and every row the method lookup can end in (#312). They render, invisible, in the same grid cell as the live list, so the
// list is already as tall as its tallest outcome at first paint; the controller clones the matching row into the list.
function MethodSkeleton() {
  return <div class="method method-skeleton" aria-hidden="true"><span class="method-skeleton-icon"></span><span class="method-skeleton-copy"><span></span><span></span></span><span class="method-skeleton-pill"></span></div>;
}

function MethodSizer() {
  return (
    <div class="method-list method-sizer" id="method-sizer" aria-hidden="true" inert>
      <MethodSkeleton />
      <div class="method" data-method="configured"><span class="method-copy"><strong>Password</strong><span>Configured</span></span><span class="method-state">Active</span></div>
      <div class="method" data-method="unconfigured"><span class="method-copy"><strong>Password</strong><span>Not configured</span></span><button class="method-action" type="button">Add below</button></div>
      <div class="method method-error" role="alert" data-method="error"><span class="method-copy"><strong>Couldn&#39;t load your sign-in methods</strong><span>Check your connection, then try again.</span></span><button class="method-action" type="button">Try again</button></div>
    </div>
  );
}

function AccountFooter({ href, label }: { href: string; label: string }) {
  return <div class="account-footer"><a href={href}>{label}</a><form method="post" action="/api/auth/sign-out"><button type="submit">Sign out</button></form></div>;
}

function PageBody({ page, user, verified = false, token = "", error = "", linkInvalid = false, methods = EMAIL_ONLY }: AuthPageOptions & { page: AuthPage }) {
  if (page === "sign-in") {
    // An OAuth failure (?error=) is GitHub's, so it shows beside the GitHub button once there is one.
    const message = error ? signInErrorMessage(error, methods.email) : "";
    return (
      <>
        <div class="heading"><p class="eyebrow">Welcome back</p><h1>Sign in to Rendro</h1><p>Open your team documentation and continue where you left off.</p></div>
        {methods.github && <GitHubSignIn label="Sign in with GitHub" primary={!methods.email} error={message} />}
        {methods.github && methods.email && <MethodDivider />}
        {methods.email && (
          <form id="auth-form" novalidate>
            <Field id="email" label="Work email" type="email" autocomplete="email" />
            <Field id="password" label="Password" type="password" autocomplete="current-password" />
            <div class="form-row"><label class="check"><input id="rememberMe" type="checkbox" checked /> Keep me signed in</label><a data-return-link="" href="/forgot-password">Forgot password?</a></div>
            <p class="message error" id="form-error" role="alert">{methods.github ? "" : message}</p>
            <SubmitButton label="Sign in" />
          </form>
        )}
        {methods.email && <p class="switch">New to Rendro? <a data-return-link="" href="/sign-up">Create an account</a></p>}
      </>
    );
  }
  if (page === "sign-up") {
    return (
      <>
        <div class="heading"><p class="eyebrow">Create your account</p><h1>Start shipping docs</h1><p>Use your verified work email to create your account.</p></div>
        {methods.github && <><GitHubSignIn label="Sign up with GitHub" primary={false} error="" /><MethodDivider /></>}
        <form id="auth-form" novalidate>
          <Field id="name" label="Full name" type="text" autocomplete="name" />
          <Field id="email" label="Work email" type="email" autocomplete="email" />
          <Field id="password" label="Password" type="password" autocomplete="new-password" minlength={15} />
          <p class="hint">Use at least 15 characters. Password-manager generated values work best.</p>
          <p class="message error" id="form-error" role="alert"></p>
          <SubmitButton label="Create account" />
        </form>
        <section class="success-panel" id="success-panel" tabindex={-1} aria-labelledby="success-title" hidden><span class="success-icon" aria-hidden="true"><span class="material-symbols-outlined">check</span></span><h2 id="success-title">Check your email</h2><p>If the address can be registered, we sent a verification link. Verify it before signing in.</p><a class="button primary" data-return-link="" href="/sign-in">Back to sign in</a></section>
        <p class="switch">Already have an account? <a data-return-link="" href="/sign-in">Sign in</a></p>
      </>
    );
  }
  if (page === "verify-email") {
    const confirmed = verified && !linkInvalid;
    return (
      <>
        <div class="heading status-heading">
          <span class={`status-icon ${confirmed ? "success" : "mail"}`}><span class="material-symbols-outlined" aria-hidden="true">{confirmed ? "mark_email_read" : linkInvalid ? "error" : "mail"}</span></span>
          <p class="eyebrow">Email verification</p>
          <h1 tabindex={linkInvalid ? -1 : undefined} data-autofocus={linkInvalid ? "" : undefined}>{confirmed ? "Email verified" : linkInvalid ? "Verification link unavailable" : "Verify your email"}</h1>
          {linkInvalid
            ? <p role="alert" class="message error reset-invalid">This verification link is invalid or has expired. Request a new one below.</p>
            : <p>{confirmed ? "Your account is ready. Sign in to continue." : "Open the verification link we sent to your work email. The link expires after one hour."}</p>}
        </div>
        {confirmed ? <a class="button primary" data-return-link="" href="/sign-in">Continue to sign in</a> : (
          <>
            <form id="resend-form" novalidate><Field id="email" label="Work email" type="email" autocomplete="email" /><p class="message" id="form-message" role="status"></p><SubmitButton label="Resend verification email" kind="secondary" /></form>
            <p class="switch"><a data-return-link="" href="/sign-in">Back to sign in</a></p>
          </>
        )}
      </>
    );
  }
  if (page === "forgot-password") {
    return (
      <>
        <div class="heading status-heading"><StatusHeading icon="key" eyebrow="Account recovery" title="Reset your password" /><p>Enter your work email. If an account exists, we will send a secure reset link.</p></div>
        <form id="auth-form" novalidate><Field id="email" label="Work email" type="email" autocomplete="email" /><p class="message" id="form-message" role="status"></p><p class="message error" id="form-error" role="alert"></p><SubmitButton label="Send reset link" /></form>
        <p class="switch"><a data-return-link="" href="/sign-in">Back to sign in</a></p>
      </>
    );
  }
  if (page === "reset-password") {
    if (!token) {
      return (
        <>
          <div class="heading status-heading"><StatusHeading icon="password" eyebrow="Account recovery" title="Reset link unavailable" /><p role="alert" class="message error reset-invalid">This reset link is missing or invalid. Request a new link to continue.</p></div>
          <a class="button primary" data-return-link="" href="/forgot-password">Request a new reset link</a>
        </>
      );
    }
    return (
      <>
        <div class="heading status-heading"><StatusHeading icon="password" eyebrow="Choose a new password" title="Set a secure password" /><p>This link can be used once. Signing in again will require your new password.</p></div>
        <form id="auth-form" novalidate>
          <Field id="password" label="New password" type="password" autocomplete="new-password" minlength={15} />
          <Field id="confirmPassword" label="Confirm password" type="password" autocomplete="new-password" minlength={15} />
          <p class="hint">Use at least 15 characters.</p><p class="message error" id="form-error" role="alert"></p><SubmitButton label="Update password" />
        </form>
        <section class="success-panel" id="success-panel" tabindex={-1} aria-labelledby="success-title" hidden><span class="success-icon"><span class="material-symbols-outlined" aria-hidden="true">check</span></span><h2 id="success-title">Password updated</h2><p>Your password was reset. Previous sessions were revoked.</p><a class="button primary" data-return-link="" href="/sign-in">Sign in</a></section>
      </>
    );
  }
  if (page === "home") {
    // The signed-in home (#286): until GitHub sign-in lists the reader's repositories, it says how to open one.
    return (
      <>
        <div class="heading"><p class="eyebrow">Signed in</p><h1>Welcome, {user?.name ?? ""}</h1><p>You are signed in as <strong>{user?.email ?? ""}</strong>.</p></div>
        <section class="security-action home-open" aria-labelledby="home-open-title"><h2 id="home-open-title">Open a repository's documentation</h2><p>Rendro shows the Markdown of a GitHub repository at its own address: <code>{"/r/{owner}/{repo}"}</code>. For example, <code>/r/acme/handbook</code> opens the handbook repository of the acme account.</p></section>
        <AccountFooter href="/account/security" label="Account security" />
      </>
    );
  }
  return (
    <>
      <div class="heading"><p class="eyebrow">Account security</p><h1>Sign-in methods</h1><p>Manage the ways you sign in as <strong>{user?.email ?? ""}</strong>.</p></div>
      <div class="method-slot"><div class="method-list" id="method-list" aria-live="polite" aria-busy="true"><MethodSkeleton /><span class="sr-only">Loading sign-in methods</span></div><MethodSizer /></div>
      <div class="security-slot">
        <div class="security-action security-skeleton" id="security-skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <section class="security-action" id="initial-password-section" hidden>
          <h2>Add a password</h2><p>Create a credential for this verified email without changing your account.</p>
          <form id="initial-password-form">
            <Field id="password" label="New password" type="password" autocomplete="new-password" minlength={15} />
            <Field id="confirmPassword" label="Confirm password" type="password" autocomplete="new-password" minlength={15} />
            <p class="message error" id="initial-error" role="alert"></p><SubmitButton label="Set password" />
          </form>
        </section>
        <section class="security-action" id="change-password-section" hidden>
          <h2>Change password</h2>
          <form id="change-password-form">
            <Field id="currentPassword" label="Current password" type="password" autocomplete="current-password" />
            <Field id="newPassword" label="New password" type="password" autocomplete="new-password" minlength={15} />
            <label class="check"><input id="revokeSessions" type="checkbox" checked /> Sign out other sessions</label>
            <p class="message error" id="change-error" role="alert"></p><SubmitButton label="Change password" kind="secondary" />
          </form>
        </section>
      </div>
      <p class="message" id="security-message" role="status"></p><AccountFooter href="/home" label="Back to home" />
    </>
  );
}

function AuthDocument({ page, ...options }: AuthPageOptions & { page: AuthPage }) {
  const state = { page, returnTo: safeReturnTo(options.returnTo), token: options.token ?? "" };
  const security = page === "security";
  return (
    <html lang="en">
      <head>
        <FaviconLinks />
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{security ? "Account security" : page === "home" ? "Home" : "Authentication"} — Rendro</title>
        <FontHead icons />
        <ThemeAssets />
        <InlineStyle code={authStyles} />
        <InlineStyle code={authRefreshStyles} />
      </head>
      <body>
        <div class="shell">
          <header class="topbar"><a class="brand" href="/">Rendro<i>.</i></a><ThemeButton /></header>
          <main class={security ? "main security-main" : "main"}>
            <section class={security ? "card wide" : "card"} data-page={page}><PageBody page={page} {...options} /></section>
            {security
              ? <aside class="auth-context"><p class="eyebrow">Account security</p><h2>Keep access deliberate.</h2><p>Manage the verified sign-in methods of this account.</p></aside>
              : <aside class="auth-context"><p class="eyebrow">Documentation</p><h2>Read the docs in your repositories.</h2><p>Rendro renders the Markdown in your GitHub repositories, with comments, for the people who can read them.</p></aside>}
          </main>
          <footer class="footer">Rendro · Documentation that ships with your code</footer>
        </div>
        <InlineScript code={`window.__AUTH_STATE__=${scriptJson(state)};`} />
        <InlineScript id="auth-runtime" code={authRuntime} />
        <CommentRecovery userId={options.user?.id ?? null} />
      </body>
    </html>
  );
}

export function renderAuthPage(page: AuthPage, options: AuthPageOptions = {}): string {
  return renderHtml(<AuthDocument page={page} {...options} />, "<!DOCTYPE html>\n");
}
