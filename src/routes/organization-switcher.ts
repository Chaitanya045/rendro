/** One-use navigation display hint, not a persisted query/permission cache. */
export function renderOrganizationLabelBootstrap(userId: string, organizationId?: string): string {
  const identity = JSON.stringify({ userId, organizationId: organizationId || "" }).replace(/</g, "\\u003c");
  return String.raw`(function(){
    try{
      var key="rendro-org-navigation-label",raw=sessionStorage.getItem(key);sessionStorage.removeItem(key);
      if(!raw)return;
      var hint=JSON.parse(raw),identity=${identity},age=Date.now()-hint.createdAt;
      if(hint.userId!==identity.userId||hint.organizationId!==identity.organizationId||!identity.organizationId||!Number.isFinite(age)||age<0||age>60000||typeof hint.name!=="string"||!hint.name.trim()||hint.name.length>256)return;
      var label=document.querySelector("#cp-org-switcher [data-org-name]"),mark=document.querySelector("#cp-org-switcher [data-org-mark]");
      if(label)label.textContent=hint.name;if(mark)mark.textContent=hint.name.charAt(0).toUpperCase();
    }catch(_error){}
  })();`;
}

/** Navigation menu, not a form select. Shares popup tokens with the select and account menus. */
export const organizationSwitcherStyles = String.raw`
.cp-org-switcher{cursor:pointer}
.cp-org-switcher[aria-expanded=true]{background:var(--cp-container);border-color:var(--cp-border-strong)}
.cp-org-mark,.cp-org-caret{flex:none}
.cp-org-menu{position:fixed;inset:auto;margin:0;z-index:10000;width:320px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 72px);overflow:auto;overscroll-behavior:contain;color:var(--cp-strong);animation:rdSelectIn 150ms var(--cp-ease);transform-origin:top left}
.cp-org-menu::backdrop{background:transparent}
.cp-org-menu-heading,.cp-org-menu-status{margin:0;padding:8px;color:var(--cp-muted);font-size:12px}
.cp-org-menu-status:empty{display:none}
.cp-org-menu a,.cp-org-menu button{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:8px;border:0;border-radius:4px;background:transparent;color:var(--cp-strong);text-align:left;text-decoration:none;cursor:pointer;transition:background-color 150ms var(--cp-ease),transform 150ms var(--cp-ease)}
.cp-org-menu a:hover,.cp-org-menu a:focus-visible,.cp-org-menu button:hover,.cp-org-menu button:focus-visible{background:var(--cp-container)}
.cp-org-menu a:active,.cp-org-menu button:active{transform:scale(.98)}
.cp-org-menu-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-org-menu-check{width:20px;flex:none;color:var(--cp-accent)}
.cp-org-menu-footer{margin-top:4px;padding-top:4px;border-top:1px solid var(--cp-border)}
@media(max-width:760px){.cp-org-menu a,.cp-org-menu button{min-height:44px}}
@media(prefers-reduced-motion:reduce){.cp-org-menu{animation:none}.cp-org-menu a,.cp-org-menu button{transition:none;transform:none!important}}
`;

export const organizationSwitcherRuntime = String.raw`
(function(){
  "use strict";
  var fallback=document.getElementById("cp-org-switcher"),menu=document.getElementById("cp-org-menu");
  if(!fallback||!menu)return;
  var trigger=document.createElement("button");
  trigger.type="button";trigger.id=fallback.id;trigger.className=fallback.className;
  trigger.setAttribute("aria-label","Switch organization");trigger.setAttribute("aria-haspopup","menu");
  trigger.setAttribute("aria-controls",menu.id);trigger.setAttribute("aria-expanded","false");
  while(fallback.firstChild)trigger.append(fallback.firstChild);
  fallback.replaceWith(trigger);
  var list=menu.querySelector("[data-org-options]"),status=menu.querySelector("[role=status]"),controller=null,version=0,open=false,switching=false,focusWhenReady="",typeBuffer="",lastType=0;
  function items(){return Array.from(menu.querySelectorAll('[role="menuitem"]'));}
  function destination(organizationId){
    var match=location.pathname.match(/^\/organizations\/[^/]+(?:\/(projects)(?:\/[^/]+(?:\/(?:publications|shares))?)?|\/(people|teams|settings|api-keys))?\/?$/),section=match&&(match[2]||match[1]);
    return "/organizations/"+encodeURIComponent(organizationId)+(section?"/"+section:"");
  }
  function position(){
    if(!open)return;
    var rect=trigger.getBoundingClientRect(),viewport=window.visualViewport,left=viewport?viewport.offsetLeft:0,top=viewport?viewport.offsetTop:0,width=viewport?viewport.width:innerWidth,height=viewport?viewport.height:innerHeight;
    var menuWidth=Math.min(320,width-16),menuTop=Math.max(top+8,rect.bottom+4);
    menu.style.width=menuWidth+"px";menu.style.left=Math.max(left+8,Math.min(rect.left,left+width-menuWidth-8))+"px";
    menu.style.top=menuTop+"px";menu.style.maxHeight=Math.max(0,top+height-menuTop-8)+"px";
  }
  function close(restoreFocus){
    open=false;version++;if(controller)controller.abort();controller=null;focusWhenReady="";
    if(typeof menu.hidePopover==="function"&&menu.matches(":popover-open"))menu.hidePopover();
    menu.hidden=true;menu.removeAttribute("aria-busy");trigger.setAttribute("aria-expanded","false");list.replaceChildren();
    if(restoreFocus)trigger.focus();
  }
  function focusItem(which){
    var choices=items(),selected=list.querySelector('[aria-current="true"]');
    var target=which==="last"?choices[choices.length-1]:selected||choices[0];
    if(target)target.focus();
  }
  async function load(){
    var requestVersion=++version;if(controller)controller.abort();controller=new AbortController();
    list.replaceChildren();status.textContent="Loading organizations…";menu.setAttribute("aria-busy","true");
    try{
      var organizations=await window.RendroUI.request("/api/auth/organization/list",{signal:controller.signal});
      if(!open||requestVersion!==version)return;
      if(!Array.isArray(organizations)||organizations.some(function(org){return !org||typeof org.id!=="string"||typeof org.name!=="string";}))throw new Error("Invalid organization list");
      var current=document.querySelector(".cp-main").getAttribute("data-cp-organization-id");
      organizations.forEach(function(org){
        var link=document.createElement("a"),mark=document.createElement("span"),name=document.createElement("span"),check=document.createElement("span");
        link.href=destination(org.id);link.dataset.organizationId=org.id;link.setAttribute("role","menuitem");
        mark.className="cp-org-mark";mark.setAttribute("aria-hidden","true");mark.textContent=org.name.charAt(0).toUpperCase();
        name.className="cp-org-menu-name";name.textContent=org.name;link.title=org.name;
        check.className="material-symbols-outlined cp-org-menu-check";check.setAttribute("aria-hidden","true");
        if(org.id===current){link.setAttribute("aria-current","true");check.textContent="check";}
        link.append(mark,name,check);list.append(link);
      });
      status.textContent=organizations.length?"":"No organizations yet.";menu.removeAttribute("aria-busy");position();
      if(focusWhenReady){focusItem(focusWhenReady);focusWhenReady="";}
    }catch(error){
      if(!open||requestVersion!==version||error.name==="AbortError")return;
      menu.removeAttribute("aria-busy");status.textContent="Unable to load organizations.";
      var retry=document.createElement("button");retry.type="button";retry.textContent="Try again";retry.setAttribute("role","menuitem");retry.onclick=function(){focusWhenReady="first";load();};list.append(retry);
      if(focusWhenReady){retry.focus();focusWhenReady="";}
    }
  }
  function show(focus){
    open=true;focusWhenReady=focus||"";menu.hidden=false;
    var account=document.getElementById("cp-account"),avatar=document.getElementById("cp-avatar"),accountMenu=document.getElementById("cp-account-menu");
    if(account)account.classList.remove("open");if(avatar)avatar.setAttribute("aria-expanded","false");if(accountMenu){accountMenu.inert=true;accountMenu.setAttribute("aria-hidden","true");}
    if(typeof menu.showPopover==="function")menu.showPopover();trigger.setAttribute("aria-expanded","true");position();load();
  }
  trigger.addEventListener("click",function(){if(switching)return;if(open)close(false);else show("first");});
  trigger.addEventListener("keydown",function(event){
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();if(open)focusItem(event.key==="ArrowUp"?"last":"first");else show(event.key==="ArrowUp"?"last":"first");}
  });
  menu.addEventListener("keydown",function(event){
    var choices=items(),index=choices.indexOf(document.activeElement),target;
    if(event.key==="ArrowDown")target=choices[(index+1)%choices.length];
    else if(event.key==="ArrowUp")target=choices[(index-1+choices.length)%choices.length];
    else if(event.key==="Home")target=choices[0];
    else if(event.key==="End")target=choices[choices.length-1];
    else if(event.key===" "&&document.activeElement.matches('a[role="menuitem"]')){event.preventDefault();document.activeElement.click();return;}
    else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){var now=Date.now();typeBuffer=now-lastType<700?typeBuffer+event.key.toLowerCase():event.key.toLowerCase();lastType=now;target=choices.find(function(item){return (item.title||item.textContent).toLowerCase().startsWith(typeBuffer);});}
    if(target){event.preventDefault();focusWhenReady="";target.focus();}
  });
  menu.addEventListener("click",function(event){
    var link=event.target.closest("a[href]");if(!link)return;
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    var href=link.href,current=link.getAttribute("aria-current")==="true";event.preventDefault();
    if(current){close(true);return;}
    var label=trigger.querySelector("[data-org-name]"),mark=trigger.querySelector("[data-org-mark]"),previousName=label&&label.textContent,previousMark=mark&&mark.textContent;
    close(false);switching=true;trigger.setAttribute("aria-busy","true");trigger.setAttribute("aria-disabled","true");
    if(label)label.textContent=link.title;if(mark)mark.textContent=link.title.charAt(0).toUpperCase();
    // Carry the selected display name across the full document navigation. The
    // destination consumes it inline, before external scripts or API responses.
    try{
      sessionStorage.removeItem("rendro-org-navigation-label");
      if(link.dataset.organizationId)sessionStorage.setItem("rendro-org-navigation-label",JSON.stringify({userId:document.querySelector(".cp-main").getAttribute("data-cp-user-id"),organizationId:link.dataset.organizationId,name:link.title,createdAt:Date.now()}));
    }catch(_error){}
    function rollback(){switching=false;trigger.removeAttribute("aria-busy");trigger.removeAttribute("aria-disabled");if(label)label.textContent=previousName;if(mark)mark.textContent=previousMark;try{sessionStorage.removeItem("rendro-org-navigation-label");}catch(_error){}trigger.focus();}
    function failed(){rollback();if(window.RendroUI.toast)window.RendroUI.toast("Unable to switch organization. Please try again.","error");}
    try{if(window.RendroUI.navigate)Promise.resolve(window.RendroUI.navigate(href)).then(function(navigated){if(navigated===false)rollback();},failed);else location.assign(href);}catch(_error){failed();}
  });
  document.addEventListener("keydown",function(event){if(open&&event.key==="Escape"){event.preventDefault();close(true);}});
  document.addEventListener("pointerdown",function(event){if(open&&!menu.contains(event.target)&&!trigger.contains(event.target))close(false);},true);
  document.addEventListener("focusin",function(event){if(open&&!menu.contains(event.target)&&!trigger.contains(event.target))close(false);});
  document.addEventListener("rendro:before-route-leave",function(){close(false);});
  addEventListener("pagehide",function(){close(false);});addEventListener("resize",position);
  if(window.visualViewport){visualViewport.addEventListener("resize",position);visualViewport.addEventListener("scroll",position);}
})();
`;
