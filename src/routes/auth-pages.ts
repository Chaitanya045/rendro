import { Hono } from "hono";
import type { User } from "better-auth/types";
import { githubAppInstallUrl, signInMethods } from "@/config";
import { repoAccessBinding } from "@/github-hand-off";
import { homeRepositories } from "@/home-repositories";
import { renderAuthPage } from "./auth-page";

const app = new Hono<{ Variables: { user?: User } }>();

export type AuthPage =
  | "sign-in"
  | "sign-up"
  | "verify-email"
  | "forgot-password"
  | "reset-password"
  | "security"
  | "home";

export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || Array.from(value).some((character) => { const code = character.charCodeAt(0); return code < 32 || code === 127; })) return "/";
  return value;
}

function signInHref(returnTo: string): string {
  return `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

export function signInErrorMessage(code: string, email = true): string {
  switch (code.toLowerCase()) {
    case "access_denied":
      return email ? "Sign-in was canceled. Try again or sign in with your email and password." : "Sign-in was canceled. Try again when you are ready.";
    case "state_mismatch":
    case "state_security_mismatch":
    case "state_not_found":
    case "invalid_state":
      return "Your sign-in attempt expired or could not be verified. Please start again.";
    case "email_not_found":
      return "Your GitHub account has no verified email address. Verify one on GitHub, then try again.";
    case "unable_to_link_account":
    case "account_not_linked":
    case "account_already_linked_to_different_user":
    case "email_doesn't_match":
    case "email_not_verified":
      return "We couldn't connect that account. Sign in with your existing method and verify your email first.";
    default:
      return email ? "We couldn't complete sign-in. Please try again or use your email and password." : "We couldn't complete sign-in. Please try again.";
  }
}

export const authRefreshStyles = `
[hidden]{display:none!important}
/* The security card reserves its final height from first paint (#312): the live method list shares a grid cell with an
   invisible copy of every row it can end in, and the password sections stack in one cell, the inactive ones invisible
   instead of removed, so loading the methods never moves the footer below them. */
.method-slot{display:grid;margin-bottom:24px}.method-slot>.method-list{grid-area:1/1;display:flex;flex-direction:column;margin:0}.method-slot .method{flex:1 0 auto;border-bottom:0}.method-slot>.method-sizer{display:grid;visibility:hidden}.method-sizer>.method{grid-area:1/1}
.security-slot{display:grid}.security-slot>*{grid-area:1/1;min-width:0}.security-slot>[hidden]{display:block!important;visibility:hidden}
/* Reduced motion gives every property a .01ms transition, visibility included: a revealed form's fields would stay
   hidden, and unfocusable, until the next frame. */
@media(prefers-reduced-motion:reduce){.security-slot,.security-slot *{transition:none!important}}
.security-skeleton span{position:relative;display:block;overflow:hidden;height:44px;margin-top:16px;border-radius:8px;background:var(--surface-2)}.security-skeleton span:first-child{width:32%;height:16px;margin-top:0;border-radius:999px}
.github-form{margin:0}.github-button svg{flex:none}.method-divider{display:flex;align-items:center;gap:12px;margin:22px 0;color:var(--muted);font-size:12px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.method-divider:before,.method-divider:after{content:"";flex:1;border-top:1px solid var(--border)}.github-form .message{margin:12px 0 0}
.home-repos-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin-bottom:12px}.home-repos h2{margin:0;font-size:16px;letter-spacing:-.01em}.home-install{font-size:13px;font-weight:650;color:var(--text)}.home-notice{margin:0 0 12px;padding:10px 12px;border-radius:8px;background:var(--surface-2);font-size:13px;line-height:1.5}
.repo-list{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:10px;overflow:hidden}.repo-list li+li{border-top:1px solid var(--border)}.repo-link{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:12px 16px;color:var(--text);text-decoration:none;transition:background 150ms cubic-bezier(.4,0,.2,1)}@media(hover:hover){.repo-link:hover{background:var(--surface-2)}.home-install:hover{color:var(--accent)}}.repo-link:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.home-install:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.repo-name{min-width:0;overflow-wrap:anywhere;color:var(--muted)}.repo-name strong{color:var(--text);font-weight:650}.repo-meta{display:flex;align-items:center;gap:10px;flex:none;color:var(--muted);font-size:12px}.repo-badge{padding:2px 8px;border:1px solid var(--border);border-radius:999px;color:var(--text);font-weight:650}
.repo-state{padding:20px;border:1px dashed var(--border);border-radius:10px}.repo-state>p{margin:0 0 14px;color:var(--muted);line-height:1.55}.repo-state>p strong{color:var(--text)}.repo-state>.button{display:inline-flex;width:auto}
@media(max-width:520px){.repo-link{flex-direction:column;align-items:flex-start;gap:6px}}@media(prefers-reduced-motion:reduce){.repo-link{transition-duration:.01ms}}
.home-open p{margin:0;color:var(--muted);line-height:1.6}.home-open code{padding:1px 5px;border-radius:5px;background:var(--surface-2);color:var(--text);font-size:.92em}
.topbar{height:56px;padding:0 clamp(18px,4vw,44px);position:relative;z-index:2}.button:focus-visible,.reveal:focus-visible,.method-action:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.button.primary{color:var(--on-accent)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.status-icon .material-symbols-outlined,.success-icon .material-symbols-outlined{font-family:"Material Symbols Outlined";font-size:22px;font-style:normal;font-weight:400;line-height:1}.method-skeleton{display:grid;grid-template-columns:38px minmax(0,1fr) 72px;gap:12px}.method-skeleton-icon,.method-skeleton-copy span,.method-skeleton-pill{position:relative;overflow:hidden;background:var(--surface-2)}.method-skeleton-icon{width:38px;height:38px;border-radius:7px}.method-skeleton-copy{display:grid;gap:7px}.method-skeleton-copy span{height:10px;border-radius:999px}.method-skeleton-copy span:first-child{width:45%}.method-skeleton-copy span:last-child{width:70%}.method-skeleton-pill{width:72px;height:24px;border-radius:999px}.method-skeleton-icon:after,.method-skeleton-copy span:after,.method-skeleton-pill:after,.security-skeleton span:after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--surface) 75%,transparent),transparent);animation:authSkeleton 1.1s infinite}@keyframes authSkeleton{to{transform:translateX(100%)}}
.main{width:min(1080px,100%);margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(380px,440px);align-items:center;gap:clamp(44px,8vw,104px);padding:56px clamp(22px,5vw,64px)}.main.security-main{align-items:start}
.auth-context{order:-1;max-width:480px}.auth-context .eyebrow{margin:0 0 14px;color:var(--accent);font-size:11px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.auth-context h2{margin:0;color:var(--text);font-size:clamp(34px,4vw,52px);line-height:1.04;letter-spacing:-.045em}.auth-context>p{margin:18px 0 0;max-width:440px;color:var(--muted);font-size:16px;line-height:1.65}
.card{width:100%;max-width:440px;padding:32px;border:1px solid var(--border);border-radius:12px;box-shadow:0 18px 48px rgba(24,24,27,.07)}.card.wide{max-width:620px}.heading h1{letter-spacing:-.035em}.button{transition:background 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1),opacity 150ms cubic-bezier(.4,0,.2,1)}.button:active:not(:disabled):not([aria-disabled=true]){transform:scale(.98)}.button:disabled,.button[aria-disabled=true]{cursor:not-allowed;opacity:.62;transform:none}.button:hover:disabled,.button:hover[aria-disabled=true]{transform:none}.primary:hover:not(:disabled):not([aria-disabled=true]){background:var(--accent-hover);border-color:var(--accent-hover)}.primary:hover:disabled,.primary:hover[aria-disabled=true]{background:var(--accent);border-color:var(--accent)}.secondary:hover:not(:disabled):not([aria-disabled=true]){background:var(--surface-2)}.secondary:hover:disabled,.secondary:hover[aria-disabled=true]{background:var(--surface);border-color:var(--border)}.field label{display:block;font-size:12px;font-weight:650;margin-bottom:7px}.field>.input-wrap{font-size:inherit;font-weight:inherit;margin-bottom:0}.field input{transition:border-color 150ms cubic-bezier(.4,0,.2,1),box-shadow 150ms cubic-bezier(.4,0,.2,1),background 150ms cubic-bezier(.4,0,.2,1)}.field input:focus-visible{border-color:var(--accent);box-shadow:0 0 0 3px var(--focus)}.field input:disabled{cursor:not-allowed;opacity:.62;background:var(--surface-2)}.field input[aria-invalid=true]{border-color:var(--danger)}.reveal{top:0;right:0;height:44px;min-width:52px;border:1px solid transparent;border-radius:6px;transition:background 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1),opacity 150ms cubic-bezier(.4,0,.2,1)}.reveal:hover:not(:disabled){background:var(--surface-2);border-color:var(--border);color:var(--text)}.reveal:active:not(:disabled){transform:scale(.98)}.reveal:disabled{cursor:not-allowed;opacity:.62}.method-action{min-height:36px;display:inline-flex;align-items:center;justify-content:center;transition:background 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1),opacity 150ms cubic-bezier(.4,0,.2,1)}.method-action:hover:not(:disabled){border-color:var(--muted);background:var(--surface-2)}.method-action:active:not(:disabled){transform:scale(.98)}.method-action:disabled{cursor:wait;opacity:.62;transform:none}.footer{font-size:11px}
@media(max-width:820px){.main{grid-template-columns:1fr;max-width:500px;padding-top:38px}.main.security-main{place-items:start center}.auth-context{display:none}.card,.card.wide{max-width:none}}
 .brand{display:inline-flex;align-items:center;min-height:44px}.account-footer a,.switch a,.form-row>a{transition:color 150ms cubic-bezier(.4,0,.2,1)}@media(hover:hover){.account-footer a:hover,.switch a:hover,.form-row>a:hover{color:var(--accent)}}.account-footer a:focus-visible,.switch a:focus-visible,.form-row>a:focus-visible,.brand:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
 .field input:hover:not(:disabled):not(:focus):not([aria-invalid=true]){border-color:var(--muted)}
@media(max-width:760px){.brand{font-size:20px;line-height:28px}.method-action{min-height:44px}.account-footer a{min-height:44px;display:inline-flex;align-items:center}}
@media(max-width:520px){.main{padding:24px 12px}.card{padding:24px 20px;border-radius:10px}.topbar{height:56px}.heading h1{font-size:26px}.form-row{align-items:center;min-height:44px}.form-row .check,.form-row>a{min-height:44px;display:inline-flex;align-items:center}}
@media(prefers-reduced-motion:reduce){.button,.field input,.method-action{transition-duration:.01ms}.reveal,.account-footer a,.switch a,.form-row>a{transition-duration:.01ms}.button:active:not(:disabled),.method-action:active:not(:disabled){transform:none}.button:active:not(:disabled):not([aria-disabled=true]),.method-action:active:not(:disabled):not([aria-disabled=true]),.reveal:active:not(:disabled){transform:none!important}.method-skeleton-icon:after,.method-skeleton-copy span:after,.method-skeleton-pill:after,.security-skeleton span:after{animation:none}}
@media(prefers-reduced-motion:reduce){.button,.field input,.method-action,.reveal,.account-footer a,.switch a,.form-row>a{transition-duration:.01ms}.field input,.method-action{transition-duration:.01ms}}
`;

export const authStyles = `
:root{color-scheme:light;--page:#fafafa;--surface:#fff;--surface-2:#f4f4f5;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#c2410c;--accent-hover:#9a3412;--on-accent:#fff;--focus:rgba(194,65,12,.2);--danger:#b42318;--success:#15803d;--shadow:0 24px 60px rgba(24,24,27,.09)}
html.dark{color-scheme:dark;--page:#09090b;--surface:#09090b;--surface-2:#18181b;--text:#fafafa;--muted:#a1a1aa;--border:#27272a;--accent:#fb923c;--accent-hover:#fdba74;--on-accent:#09090b;--focus:rgba(251,146,60,.24);--danger:#fca5a5;--success:#86efac;--shadow:0 24px 70px rgba(0,0,0,.42)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--page);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}button,input{font:inherit}a{color:inherit;text-underline-offset:3px}.shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto}.topbar{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(20px,4vw,52px);border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--page) 88%,transparent)}.brand{color:var(--text);font-size:24px;font-weight:700;line-height:32px;letter-spacing:-.04em;text-decoration:none}.brand i{color:var(--accent);font-style:normal}.main{display:grid;place-items:center;padding:48px 20px}.card{width:min(100%,440px);background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:36px;box-shadow:var(--shadow)}.card.wide{width:min(100%,620px)}.heading{margin-bottom:26px}.heading h1{font-size:30px;line-height:1.15;letter-spacing:-.035em;margin:5px 0 10px}.heading>p:last-child{color:var(--muted);line-height:1.55;margin:0;font-size:14px}.heading strong{color:var(--text)}.eyebrow{text-transform:uppercase;letter-spacing:.13em;color:var(--accent)!important;font-size:11px!important;font-weight:750}.button{width:100%;min-height:44px;display:flex;align-items:center;justify-content:center;gap:10px;border-radius:8px;border:1px solid var(--border);font-weight:650;cursor:pointer;text-decoration:none;padding:10px 16px;transition:background .15s,border-color .15s,transform .15s}.button:active{transform:translateY(1px)}.button:disabled{opacity:.62;cursor:wait}.primary{background:var(--accent);border-color:var(--accent);color:#18181b}.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}.secondary{background:var(--surface);color:var(--text)}.secondary:hover{background:var(--surface-2)}.field{display:block;margin:0 0 16px}.field>span:first-child{display:block;font-size:12px;font-weight:650;margin-bottom:7px}.input-wrap{display:block;position:relative}.field input{width:100%;height:44px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:0 12px;outline:none}.field input[type=password]{padding-right:62px}.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--focus)}.reveal{position:absolute;right:5px;top:5px;height:34px;border:0;background:transparent;color:var(--muted);font-size:11px;font-weight:650;cursor:pointer;padding:0 8px}.form-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;margin:-2px 0 18px;gap:12px}.form-row a,.switch a,.account-footer a{font-weight:650}.check{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.check input{accent-color:var(--accent)}.hint{font-size:11px;color:var(--muted);line-height:1.45;margin:-7px 0 17px}.message{display:none;font-size:12px;line-height:1.5;margin:0 0 14px}.message:not(:empty){display:block}.error{color:var(--danger)}.success-message{color:var(--success)}.switch{text-align:center;color:var(--muted);font-size:13px;margin:24px 0 0}.switch a{color:var(--text)}.spinner{display:none;width:15px;height:15px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}.button[aria-busy=true] .spinner{display:block}.button[aria-busy=true] .button-label{opacity:.7}@keyframes spin{to{transform:rotate(360deg)}}.success-panel{text-align:center}.success-panel[hidden]{display:none}.success-icon,.status-icon{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--success) 14%,var(--surface));color:var(--success);font-weight:800;margin:0 auto 18px}.success-panel h2{font-size:24px;margin:0 0 8px}.success-panel p{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 22px}.status-heading{text-align:center}.status-icon.mail{background:color-mix(in srgb,var(--accent) 13%,var(--surface));color:var(--accent)}.method-list{border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:24px}.method{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;border-bottom:1px solid var(--border)}.method:last-child{border-bottom:0}.method-copy{display:flex;flex-direction:column;gap:3px}.method-copy strong{font-size:13px}.method-copy span,.method-state{font-size:11px;color:var(--muted)}.method-action{flex:none;min-width:88px;border:1px solid var(--border);border-radius:6px;padding:6px 12px;background:var(--surface);color:var(--text);font-size:13px;font-weight:650;white-space:nowrap;cursor:pointer}.method-error .method-copy span{color:var(--muted);font-size:12px;line-height:1.5}.skeleton span{height:12px;background:var(--surface-2);border-radius:5px;width:42%}.skeleton span:last-child{width:18%}.security-action{border-top:1px solid var(--border);padding-top:22px;margin-top:22px}.security-action[hidden]{display:none}.security-action h2{font-size:16px;margin:0 0 6px}.security-action>p{color:var(--muted);font-size:12px;line-height:1.5;margin:0 0 18px}.account-footer{border-top:1px solid var(--border);padding-top:20px;margin-top:24px;display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.account-footer form{margin:0}.account-footer button{appearance:none;margin:0;padding:0;border:0;background:none;color:var(--text);font:inherit;font-weight:650;cursor:pointer;transition:color 150ms cubic-bezier(.4,0,.2,1)}@media(hover:hover){.account-footer button:hover{color:var(--accent)}}.account-footer button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media(max-width:760px){.account-footer button{min-height:44px}}@media(prefers-reduced-motion:reduce){.account-footer button{transition-duration:.01ms}}.footer{padding:18px;text-align:center;font-size:11px;color:var(--muted)}
@media(max-width:520px){.main{padding:24px 12px;place-items:start center}.card{padding:26px 20px;border-radius:12px}.topbar{height:56px}.heading h1{font-size:26px}.form-row{align-items:flex-start}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

export const authRuntime = `

(function(){
  "use strict";
  var state=window.__AUTH_STATE__;
  window.RendroTheme.mount(document.getElementById("theme-toggle"));
  document.querySelectorAll("[data-return-link]").forEach(function(link){var href=link.getAttribute("href");if(href&&state.returnTo!=="/")link.setAttribute("href",href+(href.indexOf("?")<0?"?":"&")+"returnTo="+encodeURIComponent(state.returnTo));});
  document.querySelectorAll("[data-reveal]").forEach(function(button){button.addEventListener("click",function(){var input=document.getElementById(button.dataset.reveal);if(!input)return;var show=input.type==="password";input.type=show?"text":"password";button.textContent=show?"Hide":"Show";button.setAttribute("aria-label",(show?"Hide":"Show")+" password");});});
  function busy(form,on){form.dataset.inFlight=String(on);var button=form.querySelector("button[type=submit]");if(button){button.disabled=on;button.setAttribute("aria-busy",String(on));}}
  async function post(path,body){var response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(body)});var data=null;try{data=await response.json();}catch(_error){}if(!response.ok){var message=data&&(data.message||data.error);var error=new Error(typeof message==="string"?message:"Request failed. Please try again.");error.status=response.status;throw error;}return data;}
  function errorAt(id,error){var node=document.getElementById(id);if(node){node.textContent=error instanceof Error?error.message:"Request failed. Please try again.";if(id==="security-message")node.className="message error";}}
  function clearError(id){var node=document.getElementById(id);if(node){node.textContent="";if(id==="security-message")node.className="message";}}
  function validate(form,errorId){var invalid=form.querySelector(":invalid");if(!invalid)return true;invalid.focus();invalid.setAttribute("aria-invalid","true");invalid.setAttribute("aria-describedby",errorId);var message=invalid.validity.valueMissing?"Please complete this field.":invalid.validity.typeMismatch?"Enter a valid email address.":invalid.validity.tooShort?"Use at least "+invalid.minLength+" characters.":"Check this field.";errorAt(errorId,new Error(message));return false;}
  function retryable(error){return !error || !error.status || error.status>=500;}
  var autofocus=document.querySelector("[data-autofocus]");if(autofocus)autofocus.focus();
  var form=document.getElementById("auth-form");
  document.querySelectorAll("form").forEach(function(currentForm){currentForm.addEventListener("input",function(event){var input=event.target;if(!(input instanceof HTMLInputElement))return;input.removeAttribute("aria-invalid");input.removeAttribute("aria-describedby");var alert=currentForm.querySelector("[role=alert]");if(alert)alert.textContent="";});});
  if(form&&state.page==="sign-in")form.addEventListener("submit",async function(event){event.preventDefault();if(form.dataset.inFlight==="true"||!validate(form,"form-error"))return;busy(form,true);clearError("form-error");try{await post("/api/auth/sign-in/email",{email:form.email.value,password:form.password.value,rememberMe:form.rememberMe.checked,callbackURL:location.origin+state.returnTo});location.assign(state.returnTo);}catch(error){busy(form,false);errorAt("form-error",error);}});
  if(form&&state.page==="sign-up")form.addEventListener("submit",async function(event){
    event.preventDefault();if(form.dataset.inFlight==="true"||!validate(form,"form-error"))return;busy(form,true);clearError("form-error");
    try{
      var nameInput=form.elements.namedItem("name");
      await post("/api/auth/sign-up/email",{
        name:nameInput.value,
        email:form.email.value,
        password:form.password.value,
        callbackURL:location.origin+"/verify-email?verified=1"+(state.returnTo!=="/"?"&returnTo="+encodeURIComponent(state.returnTo):"")
      });
      form.hidden=true;
      document.getElementById("success-panel").hidden=false;document.getElementById("success-panel").focus();
    }catch(error){busy(form,false);errorAt("form-error",error);}
  });
  // GitHub sign-in (#338): Better Auth answers with GitHub's authorize URL and sets the OAuth state cookie.
  var github=document.getElementById("github-form");if(github){github.addEventListener("submit",async function(event){event.preventDefault();if(github.dataset.inFlight==="true")return;busy(github,true);clearError("github-error");var linking=github.dataset.action==="link";try{var data=await post(linking?"/api/auth/link-social":"/api/auth/sign-in/social",{provider:"github",callbackURL:location.origin+(github.dataset.callback||state.returnTo)});if(!data||typeof data.url!=="string")throw new Error();location.assign(data.url);}catch(_error){busy(github,false);errorAt("github-error",new Error(linking?"GitHub can't be connected right now. Please try again.":"GitHub sign-in is unavailable right now. Please try again."));}});window.addEventListener("pageshow",function(event){if(event.persisted)busy(github,false);});}
  var resend=document.getElementById("resend-form");if(resend)resend.addEventListener("submit",async function(event){event.preventDefault();if(resend.dataset.inFlight==="true"||!validate(resend,"form-message"))return;busy(resend,true);var message=document.getElementById("form-message");try{await post("/api/auth/send-verification-email",{email:resend.email.value,callbackURL:location.origin+"/verify-email?verified=1"+(state.returnTo!=="/"?"&returnTo="+encodeURIComponent(state.returnTo):"")});message.className="message";message.textContent="If the address is eligible, a new verification email is on its way.";}catch(error){message.className="message";message.textContent=retryable(error)?"We couldn't send that email. Please try again.":"If the address is eligible, a new verification email is on its way.";}busy(resend,false);});
  if(form&&state.page==="forgot-password")form.addEventListener("submit",async function(event){event.preventDefault();if(form.dataset.inFlight==="true"||!validate(form,"form-error"))return;busy(form,true);var message=document.getElementById("form-message");try{await post("/api/auth/request-password-reset",{email:form.email.value,redirectTo:location.origin+"/reset-password"+(state.returnTo!=="/"?"?returnTo="+encodeURIComponent(state.returnTo):"")});message.textContent="If an account exists for that email, a reset link is on its way.";}catch(error){message.textContent=retryable(error)?"We couldn't send that email. Please try again.":"If an account exists for that email, a reset link is on its way.";}busy(form,false);});
  if(form&&state.page==="reset-password")form.addEventListener("submit",async function(event){event.preventDefault();if(form.dataset.inFlight==="true"||!validate(form,"form-error"))return;clearError("form-error");if(!state.token){errorAt("form-error",new Error("This reset link is missing or invalid."));return;}if(form.password.value!==form.confirmPassword.value){errorAt("form-error",new Error("Passwords do not match."));return;}busy(form,true);try{await post("/api/auth/reset-password",{newPassword:form.password.value,token:state.token});form.hidden=true;document.getElementById("success-panel").hidden=false;document.getElementById("success-panel").focus();}catch(error){busy(form,false);errorAt("form-error",error);}});
  if(state.page==="security")loadSecurity();
  async function loadSecurity(){var list=document.getElementById("method-list");list.setAttribute("aria-busy","true");try{var response=await fetch("/api/auth/list-accounts",{headers:{Accept:"application/json"}});if(!response.ok)throw new Error("Unable to load sign-in methods.");var accounts=await response.json();var hasCredential=accounts.some(function(account){return account.providerId==="credential";});showMethod(hasCredential?"configured":"unconfigured",hasCredential?null:function(){var section=document.getElementById("initial-password-section");if(!section)return;section.hidden=false;section.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"nearest"});var input=section.querySelector("input");if(input)input.focus({preventScroll:true});});document.getElementById(hasCredential?"change-password-section":"initial-password-section").hidden=false;}catch(error){showMethod("error",loadSecurity);}finally{document.getElementById("security-skeleton").hidden=true;list.setAttribute("aria-busy","false");}}
  function showMethod(kind,onClick){var row=document.querySelector('#method-sizer [data-method="'+kind+'"]').cloneNode(true);var button=row.querySelector("button");if(button&&onClick)button.addEventListener("click",onClick);document.getElementById("method-list").replaceChildren(row);}
  var initial=document.getElementById("initial-password-form");if(initial)initial.addEventListener("submit",async function(event){event.preventDefault();if(initial.dataset.inFlight==="true"||!validate(initial,"initial-error"))return;clearError("initial-error");if(initial.password.value!==initial.confirmPassword.value){errorAt("initial-error",new Error("Passwords do not match."));return;}busy(initial,true);try{await post("/api/auth/set-initial-password",{newPassword:initial.password.value});location.reload();}catch(error){busy(initial,false);errorAt("initial-error",error);}});
  var change=document.getElementById("change-password-form");if(change)change.addEventListener("submit",async function(event){event.preventDefault();if(change.dataset.inFlight==="true"||!validate(change,"change-error"))return;busy(change,true);clearError("change-error");try{await post("/api/auth/change-password",{currentPassword:change.currentPassword.value,newPassword:change.newPassword.value,revokeOtherSessions:change.revokeSessions.checked});change.reset();var message=document.getElementById("security-message");message.textContent="Password changed successfully.";}catch(error){errorAt("change-error",error);}busy(change,false);});
})();
`;

app.get("/sign-in", (c) => {
  const returnTo = safeReturnTo(c.req.query("returnTo"));
  const error = c.req.query("error");
  if (c.get("user") && !error) return c.redirect(returnTo);
  return c.html(renderAuthPage("sign-in", { returnTo, error, methods: signInMethods() }));
});

app.get("/sign-up", (c) => {
  const returnTo = safeReturnTo(c.req.query("returnTo"));
  if (c.get("user")) return c.redirect(returnTo);
  const methods = signInMethods();
  // GitHub-only sign-in (AUTH_EMAIL_SIGN_IN=off): GitHub creates the account on first sign-in.
  if (!methods.email) return c.redirect(returnTo === "/" ? "/sign-in" : signInHref(returnTo));
  return c.html(renderAuthPage("sign-up", { returnTo, methods }));
});

app.get("/verify-email", (c) => c.html(renderAuthPage("verify-email", {
  returnTo: safeReturnTo(c.req.query("returnTo")),
  verified: c.req.query("verified") === "1",
  linkInvalid: c.req.query("error") !== undefined,
})));
app.get("/forgot-password", (c) => c.html(renderAuthPage("forgot-password", {
  returnTo: safeReturnTo(c.req.query("returnTo")),
})));
app.get("/reset-password", (c) => c.html(renderAuthPage("reset-password", {
  token: c.req.query("token") ?? "",
  returnTo: safeReturnTo(c.req.query("returnTo")),
})));
app.get("/home", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect(signInHref("/home"));
  // With GitHub sign-in and the permission mirror (#338), the home lists the reader's repositories from the mirror.
  const binding = signInMethods().github ? repoAccessBinding(c.env) : null;
  if (!binding) return c.html(renderAuthPage("home", { user }));
  const notice = c.req.query("github");
  return c.html(renderAuthPage("home", { user, home: {
    repositories: await homeRepositories(binding, user.id),
    installUrl: githubAppInstallUrl(),
    notice: notice === "installed" || notice === "requested" ? notice : null,
  } }));
});

app.get("/account/security", (c) => {
  const user = c.get("user");
  if (!user) return c.redirect(signInHref("/account/security"));
  return c.html(renderAuthPage("security", { user }));
});

export default app;
