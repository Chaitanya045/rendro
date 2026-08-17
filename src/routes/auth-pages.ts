import { Hono } from "hono";
import type { User } from "better-auth/types";

const app = new Hono<{ Variables: { user?: User } }>();

type AuthPage =
  | "sign-in"
  | "sign-up"
  | "verify-email"
  | "forgot-password"
  | "reset-password"
  | "security";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function signInHref(returnTo: string): string {
  return `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

function field(
  id: string,
  label: string,
  type: "email" | "password" | "text",
  autocomplete: string,
  options: { minlength?: number; value?: string } = {},
): string {
  const minlength = options.minlength ? ` minlength="${options.minlength}"` : "";
  const value = options.value ? ` value="${escapeHtml(options.value)}"` : "";
  return `<label class="field" for="${id}">
    <span>${label}</span>
    <span class="input-wrap">
      <input id="${id}" name="${id}" type="${type}" autocomplete="${autocomplete}" required${minlength}${value}>
      ${type === "password" ? `<button class="reveal" type="button" data-reveal="${id}" aria-label="Show password">Show</button>` : ""}
    </span>
  </label>`;
}

function pageBody(page: AuthPage, user?: User, verified = false): string {
  if (page === "sign-in") {
    return `<div class="heading"><p class="eyebrow">Welcome back</p><h1>Sign in to Rendro</h1><p>Open your team documentation and continue where you left off.</p></div>
      <button class="button google" id="google-auth" type="button"><span class="google-mark">G</span><span>Continue with Google</span></button>
      <div class="divider"><span>or use your work email</span></div>
      <form id="auth-form" novalidate>
        ${field("email", "Work email", "email", "email")}
        ${field("password", "Password", "password", "current-password")}
        <div class="form-row"><label class="check"><input id="rememberMe" type="checkbox" checked> Keep me signed in</label><a href="/forgot-password">Forgot password?</a></div>
        <p class="message error" id="form-error" role="alert"></p>
        <button class="button primary" type="submit"><span class="button-label">Sign in</span><span class="spinner" aria-hidden="true"></span></button>
      </form>
      <p class="switch">New to Rendro? <a data-return-link href="/sign-up">Create an account</a></p>`;
  }
  if (page === "sign-up") {
    return `<div class="heading"><p class="eyebrow">Create your account</p><h1>Start shipping docs</h1><p>Use your verified work email to create or join your organization.</p></div>
      <button class="button google" id="google-auth" type="button"><span class="google-mark">G</span><span>Continue with Google</span></button>
      <div class="divider"><span>or create credentials</span></div>
      <form id="auth-form" novalidate>
        ${field("name", "Full name", "text", "name")}
        ${field("email", "Work email", "email", "email")}
        ${field("password", "Password", "password", "new-password", { minlength: 15 })}
        <p class="hint">Use at least 15 characters. Password-manager generated values work best.</p>
        <p class="message error" id="form-error" role="alert"></p>
        <button class="button primary" type="submit"><span class="button-label">Create account</span><span class="spinner" aria-hidden="true"></span></button>
      </form>
      <section class="success-panel" id="success-panel" hidden><span class="success-icon">✓</span><h2>Check your email</h2><p>If the address can be registered, we sent a verification link. Verify it before signing in.</p><a class="button primary" href="/sign-in">Back to sign in</a></section>
      <p class="switch">Already have an account? <a data-return-link href="/sign-in">Sign in</a></p>`;
  }
  if (page === "verify-email") {
    return `<div class="heading status-heading"><span class="status-icon ${verified ? "success" : "mail"}">${verified ? "✓" : "@"}</span><p class="eyebrow">Email verification</p><h1>${verified ? "Email verified" : "Verify your email"}</h1><p>${verified ? "Your account is ready. Sign in to continue." : "Open the verification link we sent to your work email. The link expires after one hour."}</p></div>
      ${verified ? `<a class="button primary" data-return-link href="/sign-in">Continue to sign in</a>` : `<form id="resend-form" novalidate>${field("email", "Work email", "email", "email")}<p class="message" id="form-message" role="status"></p><button class="button secondary" type="submit"><span class="button-label">Resend verification email</span><span class="spinner" aria-hidden="true"></span></button></form><p class="switch"><a data-return-link href="/sign-in">Back to sign in</a></p>`}`;
  }
  if (page === "forgot-password") {
    return `<div class="heading status-heading"><span class="status-icon mail">↗</span><p class="eyebrow">Account recovery</p><h1>Reset your password</h1><p>Enter your work email. If an account exists, we will send a secure reset link.</p></div>
      <form id="auth-form" novalidate>${field("email", "Work email", "email", "email")}<p class="message" id="form-message" role="status"></p><p class="message error" id="form-error" role="alert"></p><button class="button primary" type="submit"><span class="button-label">Send reset link</span><span class="spinner" aria-hidden="true"></span></button></form>
      <p class="switch"><a data-return-link href="/sign-in">Back to sign in</a></p>`;
  }
  if (page === "reset-password") {
    return `<div class="heading status-heading"><span class="status-icon mail">••</span><p class="eyebrow">Choose a new password</p><h1>Set a secure password</h1><p>This link can be used once. Signing in again will require your new password.</p></div>
      <form id="auth-form" novalidate>${field("password", "New password", "password", "new-password", { minlength: 15 })}${field("confirmPassword", "Confirm password", "password", "new-password", { minlength: 15 })}<p class="hint">Use at least 15 characters.</p><p class="message error" id="form-error" role="alert"></p><button class="button primary" type="submit"><span class="button-label">Update password</span><span class="spinner" aria-hidden="true"></span></button></form>
      <section class="success-panel" id="success-panel" hidden><span class="success-icon">✓</span><h2>Password updated</h2><p>Your password was reset. Previous sessions were revoked.</p><a class="button primary" data-return-link href="/sign-in">Sign in</a></section>`;
  }
  return `<div class="heading"><p class="eyebrow">Account security</p><h1>Sign-in methods</h1><p>Manage the ways you sign in as <strong>${escapeHtml(user?.email ?? "")}</strong>.</p></div>
    <div class="method-list" id="method-list" aria-live="polite"><div class="method skeleton"><span></span><span></span></div></div>
    <section class="security-action" id="initial-password-section" hidden><h2>Add a password</h2><p>Create a credential for this verified email without changing your account or organization access.</p><form id="initial-password-form">${field("password", "New password", "password", "new-password", { minlength: 15 })}${field("confirmPassword", "Confirm password", "password", "new-password", { minlength: 15 })}<p class="message error" id="initial-error" role="alert"></p><button class="button primary" type="submit"><span class="button-label">Set password</span><span class="spinner" aria-hidden="true"></span></button></form></section>
    <section class="security-action" id="change-password-section" hidden><h2>Change password</h2><form id="change-password-form">${field("currentPassword", "Current password", "password", "current-password")}${field("newPassword", "New password", "password", "new-password", { minlength: 15 })}<label class="check"><input id="revokeSessions" type="checkbox" checked> Sign out other sessions</label><p class="message error" id="change-error" role="alert"></p><button class="button secondary" type="submit"><span class="button-label">Change password</span><span class="spinner" aria-hidden="true"></span></button></form></section>
    <p class="message success-message" id="security-message" role="status"></p><div class="account-footer"><a href="/">Back to workspace</a><a href="/api/auth/sign-out">Sign out</a></div>`;
}

function renderAuthPage(
  page: AuthPage,
  options: { returnTo?: string; token?: string; user?: User; verified?: boolean } = {},
): string {
  const returnTo = safeReturnTo(options.returnTo);
  const state = JSON.stringify({
    page,
    returnTo,
    token: options.token ?? "",
  }).replace(/</g, "\\u003c");
  const wide = page === "security" ? " wide" : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${page === "security" ? "Account security" : "Authentication"} — Rendro</title>
<style>
:root{color-scheme:light;--page:#fafafa;--surface:#fff;--surface-2:#f4f4f5;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#f97316;--accent-hover:#fdba74;--focus:rgba(249,115,22,.22);--danger:#b91c1c;--success:#15803d;--shadow:0 24px 60px rgba(24,24,27,.09)}
html.dark{color-scheme:dark;--page:#09090b;--surface:#18181b;--surface-2:#27272a;--text:#fafafa;--muted:#a1a1aa;--border:#3f3f46;--accent:#fb923c;--accent-hover:#fdba74;--focus:rgba(251,146,60,.24);--danger:#fca5a5;--success:#86efac;--shadow:0 24px 70px rgba(0,0,0,.42)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--page);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}button,input{font:inherit}a{color:inherit;text-underline-offset:3px}.shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto}.topbar{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(20px,4vw,52px);border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--page) 88%,transparent)}.brand{font-weight:750;letter-spacing:-.04em;text-decoration:none;font-size:20px}.brand i{color:var(--accent);font-style:normal}.theme{border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:999px;width:36px;height:36px;cursor:pointer}.main{display:grid;place-items:center;padding:48px 20px}.card{width:min(100%,440px);background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:36px;box-shadow:var(--shadow)}.card.wide{width:min(100%,620px)}.heading{margin-bottom:26px}.heading h1{font-size:30px;line-height:1.15;letter-spacing:-.035em;margin:5px 0 10px}.heading>p:last-child{color:var(--muted);line-height:1.55;margin:0;font-size:14px}.heading strong{color:var(--text)}.eyebrow{text-transform:uppercase;letter-spacing:.13em;color:var(--accent)!important;font-size:11px!important;font-weight:750}.button{width:100%;min-height:44px;display:flex;align-items:center;justify-content:center;gap:10px;border-radius:8px;border:1px solid var(--border);font-weight:650;cursor:pointer;text-decoration:none;padding:10px 16px;transition:background .15s,border-color .15s,transform .15s}.button:active{transform:translateY(1px)}.button:disabled{opacity:.62;cursor:wait}.primary{background:var(--accent);border-color:var(--accent);color:#18181b}.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}.secondary,.google{background:var(--surface);color:var(--text)}.secondary:hover,.google:hover{background:var(--surface-2)}.google-mark{font-family:Arial;font-size:17px;font-weight:700}.divider{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:11px;margin:22px 0}.divider:before,.divider:after{content:"";height:1px;background:var(--border);flex:1}.field{display:block;margin:0 0 16px}.field>span:first-child{display:block;font-size:12px;font-weight:650;margin-bottom:7px}.input-wrap{display:block;position:relative}.field input{width:100%;height:44px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:0 12px;outline:none}.field input[type=password]{padding-right:62px}.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--focus)}.reveal{position:absolute;right:5px;top:5px;height:34px;border:0;background:transparent;color:var(--muted);font-size:11px;font-weight:650;cursor:pointer;padding:0 8px}.form-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;margin:-2px 0 18px;gap:12px}.form-row a,.switch a,.account-footer a{font-weight:650}.check{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.check input{accent-color:var(--accent)}.hint{font-size:11px;color:var(--muted);line-height:1.45;margin:-7px 0 17px}.message{display:none;font-size:12px;line-height:1.5;margin:0 0 14px}.message:not(:empty){display:block}.error{color:var(--danger)}.success-message{color:var(--success)}.switch{text-align:center;color:var(--muted);font-size:13px;margin:24px 0 0}.switch a{color:var(--text)}.spinner{display:none;width:15px;height:15px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}.button[aria-busy=true] .spinner{display:block}.button[aria-busy=true] .button-label{opacity:.7}@keyframes spin{to{transform:rotate(360deg)}}.success-panel{text-align:center}.success-panel[hidden]{display:none}.success-icon,.status-icon{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--success) 14%,var(--surface));color:var(--success);font-weight:800;margin:0 auto 18px}.success-panel h2{font-size:24px;margin:0 0 8px}.success-panel p{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 22px}.status-heading{text-align:center}.status-icon.mail{background:color-mix(in srgb,var(--accent) 13%,var(--surface));color:var(--accent)}.method-list{border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:24px}.method{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;border-bottom:1px solid var(--border)}.method:last-child{border-bottom:0}.method-copy{display:flex;flex-direction:column;gap:3px}.method-copy strong{font-size:13px}.method-copy span,.method-state{font-size:11px;color:var(--muted)}.method-action{border:1px solid var(--border);border-radius:6px;padding:6px 9px;background:var(--surface);color:var(--text);font-size:11px;font-weight:650;cursor:pointer}.skeleton span{height:12px;background:var(--surface-2);border-radius:5px;width:42%}.skeleton span:last-child{width:18%}.security-action{border-top:1px solid var(--border);padding-top:22px;margin-top:22px}.security-action[hidden]{display:none}.security-action h2{font-size:16px;margin:0 0 6px}.security-action>p{color:var(--muted);font-size:12px;line-height:1.5;margin:0 0 18px}.account-footer{border-top:1px solid var(--border);padding-top:20px;margin-top:24px;display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.footer{padding:18px;text-align:center;font-size:11px;color:var(--muted)}
@media(max-width:520px){.main{padding:24px 12px;place-items:start center}.card{padding:26px 20px;border-radius:12px}.topbar{height:56px}.heading h1{font-size:26px}.form-row{align-items:flex-start}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}
</style></head>
<body><div class="shell"><header class="topbar"><a class="brand" href="/">Rendro<i>.</i></a><button class="theme" id="theme-toggle" type="button" aria-label="Switch color theme">◐</button></header><main class="main"><section class="card${wide}" data-page="${page}">${pageBody(page, options.user, options.verified ?? false)}</section></main><footer class="footer">Rendro · Documentation that ships with your code</footer></div>
<script>window.__AUTH_STATE__=${state};</script>
<script>
(function(){
  "use strict";
  var state=window.__AUTH_STATE__;
  var root=document.documentElement;
  var media=matchMedia("(prefers-color-scheme: dark)");
  function theme(){var saved=localStorage.getItem("commentor-theme");return saved==="dark"||saved==="light"?saved:(media.matches?"dark":"light");}
  function apply(){root.classList.toggle("dark",theme()==="dark");}
  apply();media.addEventListener("change",apply);
  document.getElementById("theme-toggle").addEventListener("click",function(){var next=theme()==="dark"?"light":"dark";localStorage.setItem("commentor-theme",next);apply();});
  document.querySelectorAll("[data-return-link]").forEach(function(link){var href=link.getAttribute("href");if(href&&state.returnTo!=="/")link.setAttribute("href",href+(href.indexOf("?")<0?"?":"&")+"returnTo="+encodeURIComponent(state.returnTo));});
  document.querySelectorAll("[data-reveal]").forEach(function(button){button.addEventListener("click",function(){var input=document.getElementById(button.dataset.reveal);if(!input)return;var show=input.type==="password";input.type=show?"text":"password";button.textContent=show?"Hide":"Show";button.setAttribute("aria-label",(show?"Hide":"Show")+" password");});});
  function busy(form,on){var button=form.querySelector("button[type=submit]");if(button){button.disabled=on;button.setAttribute("aria-busy",String(on));}}
  async function post(path,body){var response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(body)});var data=null;try{data=await response.json();}catch(_error){}if(!response.ok){var message=data&&(data.message||data.error);throw new Error(typeof message==="string"?message:"Request failed. Please try again.");}return data;}
  function errorAt(id,error){var node=document.getElementById(id);if(node)node.textContent=error instanceof Error?error.message:"Request failed. Please try again.";}
  async function google(){var button=document.getElementById("google-auth");if(!button)return;button.disabled=true;button.setAttribute("aria-busy","true");try{var data=await post("/api/auth/sign-in/social",{provider:"google",callbackURL:location.origin+state.returnTo});if(!data||typeof data.url!=="string")throw new Error("Google sign-in is unavailable.");location.assign(data.url);}catch(error){button.disabled=false;button.setAttribute("aria-busy","false");errorAt("form-error",error);}}
  var googleButton=document.getElementById("google-auth");if(googleButton)googleButton.addEventListener("click",google);
  var form=document.getElementById("auth-form");
  if(form&&state.page==="sign-in")form.addEventListener("submit",async function(event){event.preventDefault();busy(form,true);errorAt("form-error",new Error(""));try{await post("/api/auth/sign-in/email",{email:form.email.value,password:form.password.value,rememberMe:form.rememberMe.checked,callbackURL:location.origin+state.returnTo});location.assign(state.returnTo);}catch(error){busy(form,false);errorAt("form-error",error);}});
  if(form&&state.page==="sign-up")form.addEventListener("submit",async function(event){
    event.preventDefault();busy(form,true);errorAt("form-error",new Error(""));
    try{
      var nameInput=form.elements.namedItem("name");
      await post("/api/auth/sign-up/email",{
        name:nameInput.value,
        email:form.email.value,
        password:form.password.value,
        callbackURL:location.origin+"/verify-email?verified=1"
      });
      form.hidden=true;
      document.getElementById("google-auth").hidden=true;
      document.querySelector(".divider").hidden=true;
      document.getElementById("success-panel").hidden=false;
    }catch(error){busy(form,false);errorAt("form-error",error);}
  });
  var resend=document.getElementById("resend-form");if(resend)resend.addEventListener("submit",async function(event){event.preventDefault();busy(resend,true);var message=document.getElementById("form-message");try{await post("/api/auth/send-verification-email",{email:resend.email.value,callbackURL:location.origin+"/verify-email?verified=1"});message.textContent="If the address is eligible, a new verification email is on its way.";}catch(_error){message.textContent="If the address is eligible, a new verification email is on its way.";}busy(resend,false);});
  if(form&&state.page==="forgot-password")form.addEventListener("submit",async function(event){event.preventDefault();busy(form,true);var message=document.getElementById("form-message");try{await post("/api/auth/request-password-reset",{email:form.email.value,redirectTo:location.origin+"/reset-password"});}catch(_error){}message.textContent="If an account exists for that email, a reset link is on its way.";busy(form,false);});
  if(form&&state.page==="reset-password")form.addEventListener("submit",async function(event){event.preventDefault();errorAt("form-error",new Error(""));if(!state.token){errorAt("form-error",new Error("This reset link is missing or invalid."));return;}if(form.password.value!==form.confirmPassword.value){errorAt("form-error",new Error("Passwords do not match."));return;}busy(form,true);try{await post("/api/auth/reset-password",{newPassword:form.password.value,token:state.token});form.hidden=true;document.getElementById("success-panel").hidden=false;}catch(error){busy(form,false);errorAt("form-error",error);}});
  if(state.page==="security")loadSecurity();
  async function loadSecurity(){var list=document.getElementById("method-list");try{var response=await fetch("/api/auth/list-accounts",{headers:{Accept:"application/json"}});if(!response.ok)throw new Error("Unable to load sign-in methods.");var accounts=await response.json();var hasCredential=accounts.some(function(account){return account.providerId==="credential";});var hasGoogle=accounts.some(function(account){return account.providerId==="google";});list.innerHTML="";list.appendChild(methodRow("Password",hasCredential?"Configured":"Not configured",hasCredential?null:"Add below"));list.appendChild(methodRow("Google",hasGoogle?"Connected":"Not connected",hasGoogle?null:"Connect",linkGoogle));document.getElementById(hasCredential?"change-password-section":"initial-password-section").hidden=false;}catch(error){list.innerHTML="<div class='method'><span class='error'>Unable to load sign-in methods.</span></div>";}}
  function methodRow(name,status,action,onClick){var row=document.createElement("div");row.className="method";var copy=document.createElement("span");copy.className="method-copy";var strong=document.createElement("strong");strong.textContent=name;var detail=document.createElement("span");detail.textContent=status;copy.append(strong,detail);row.append(copy);if(action){var button=document.createElement("button");button.type="button";button.className="method-action";button.textContent=action;if(onClick)button.addEventListener("click",onClick);row.append(button);}else{var stateNode=document.createElement("span");stateNode.className="method-state";stateNode.textContent="Active";row.append(stateNode);}return row;}
  async function linkGoogle(event){var button=event.currentTarget;button.disabled=true;try{var data=await post("/api/auth/link-social",{provider:"google",callbackURL:location.href});if(!data||typeof data.url!=="string")throw new Error("Google connection is unavailable.");location.assign(data.url);}catch(error){button.disabled=false;errorAt("security-message",error);}}
  var initial=document.getElementById("initial-password-form");if(initial)initial.addEventListener("submit",async function(event){event.preventDefault();errorAt("initial-error",new Error(""));if(initial.password.value!==initial.confirmPassword.value){errorAt("initial-error",new Error("Passwords do not match."));return;}busy(initial,true);try{await post("/api/auth/set-initial-password",{newPassword:initial.password.value});location.reload();}catch(error){busy(initial,false);errorAt("initial-error",error);}});
  var change=document.getElementById("change-password-form");if(change)change.addEventListener("submit",async function(event){event.preventDefault();busy(change,true);errorAt("change-error",new Error(""));try{await post("/api/auth/change-password",{currentPassword:change.currentPassword.value,newPassword:change.newPassword.value,revokeOtherSessions:change.revokeSessions.checked});change.reset();var message=document.getElementById("security-message");message.textContent="Password changed successfully.";}catch(error){errorAt("change-error",error);}busy(change,false);});
})();
</script></body></html>`;
}

app.get("/sign-in", (c) => {
  const returnTo = safeReturnTo(c.req.query("returnTo"));
  if (c.get("user")) return c.redirect(returnTo);
  return c.html(renderAuthPage("sign-in", { returnTo }));
});

app.get("/sign-up", (c) => {
  const returnTo = safeReturnTo(c.req.query("returnTo"));
  if (c.get("user")) return c.redirect(returnTo);
  return c.html(renderAuthPage("sign-up", { returnTo }));
});

app.get("/verify-email", (c) => c.html(renderAuthPage("verify-email", {
  returnTo: safeReturnTo(c.req.query("returnTo")),
  verified: c.req.query("verified") === "1",
})));
app.get("/forgot-password", (c) => c.html(renderAuthPage("forgot-password")));
app.get("/reset-password", (c) => c.html(renderAuthPage("reset-password", {
  token: c.req.query("token") ?? "",
  returnTo: safeReturnTo(c.req.query("returnTo")),
})));
app.get("/account/security", (c) => {
  const user = c.get("user");
  if (!user) return c.redirect(signInHref("/account/security"));
  return c.html(renderAuthPage("security", { user }));
});

export default app;
