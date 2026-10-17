import { MANAGEMENT_PROJECT_PLACEHOLDER, managementLoadingPages } from "./management-loading-pages";

export const MANAGEMENT_SHELL_VERSION = "27";

export interface ManagementRouteIdentity {
  organizationId: string;
  projectId?: string;
  section: "overview" | "projects" | "people" | "teams" | "settings" | "api-keys" | "project" | "deployments" | "publications" | "shares";
}

export function managementRouteIdentity(pathname: string): ManagementRouteIdentity | null {
  const match = pathname.match(/^\/organizations\/([^/]+)(?:\/(projects)(?:\/([^/]+)(?:\/(deployments|publications|shares))?)?|\/(people|teams|settings|api-keys))?\/?$/);
  if (!match) return null;
  try {
    const organizationId = decodeURIComponent(match[1]);
    const projectId = match[3] ? decodeURIComponent(match[3]) : undefined;
    const section = match[5]
      ?? (projectId ? (match[4] ?? "project") : (match[2] ?? "overview"));
    return { organizationId, projectId, section } as ManagementRouteIdentity;
  } catch {
    return null;
  }
}

function managementNavigationRuntime(loadingPagesJson: string): string {
  return String.raw`
(function(){
  "use strict";
  var documentNonce=document.currentScript&&document.currentScript.nonce;
  var SHELL_VERSION=${JSON.stringify(MANAGEMENT_SHELL_VERSION)},PROJECT_PLACEHOLDER=${JSON.stringify(MANAGEMENT_PROJECT_PLACEHOLDER)},loadingPages=${loadingPagesJson},ui=window.RendroUI;
  if(!ui||!window.fetch||!window.DOMParser||!window.AbortController)return;
  var main=document.querySelector(".cp-main[data-cp-route-envelope]"),currentScope=null,navigationController=null,pendingObserver=null,pendingExpectedMarkup=new WeakMap(),navigationVersion=0,scrollRestore=null,currentUrl=location.href,historyIndex=Number(history.state&&history.state.__rendroManagementIndex)||0,suppressPop=false;
  if(!main)return;
  var shellOrganization=main.getAttribute("data-cp-organization-id")||"",shellUser=main.getAttribute("data-cp-user-id")||"";
  if(main.getAttribute("data-cp-shell-version")!==SHELL_VERSION)return;
  var signedOut=Boolean(document.documentElement&&document.documentElement.dataset.rendroSignedOut);

  function routeIdentity(url){
    var match=url.pathname.match(/^\/organizations\/([^/]+)(?:\/(projects)(?:\/([^/]+)(?:\/(deployments|publications|shares))?)?|\/(people|teams|settings|api-keys))?\/?$/);
    if(!match)return null;
    try{return {organizationId:decodeURIComponent(match[1]),projectId:match[3]?decodeURIComponent(match[3]):"",section:match[5]||(match[3]?(match[4]||"project"):(match[2]||"overview"))};}catch(_error){return null;}
  }
  function supported(url){var route=routeIdentity(url);return url.origin===location.origin&&route&&route.organizationId===shellOrganization?route:null;}
  var queryCache=!signedOut&&supported(new URL(location.href))&&window.RendroQueryCore&&shellUser?window.RendroQueryCore.create({userId:shellUser,organizationId:shellOrganization,origin:location.origin},function(path,options){return ui.request(path,options);}):null,cacheChannel=null;
  function clearQueryCache(){if(queryCache)queryCache.clear();}
  function invalidateMutation(path,options){if(!queryCache)return;var impact=queryCache.invalidateMutation(path,options);if(cacheChannel)try{cacheChannel.postMessage(impact);}catch(_error){}}
  function offerRefresh(){var notice=document.querySelector("#cp-refresh-notice");if(notice)notice.hidden=false;}
  function hideRefresh(){var notice=document.querySelector("#cp-refresh-notice");if(notice)notice.hidden=true;}
  if(queryCache){
    if(typeof BroadcastChannel!=="undefined")try{cacheChannel=new BroadcastChannel("rendro-management-invalidation");cacheChannel.onmessage=function(event){var impact=event.data;if(impact==="invalidate"){clearQueryCache();offerRefresh();}else if(impact&&impact.organizationId===shellOrganization){queryCache.applyImpact(impact);offerRefresh();}};}catch(_error){}
    addEventListener("pagehide",function(){clearQueryCache(false);});
    // A resumed tab may have missed CLI changes, access changes or mutations in
    // another tab. Invalidate without resetting an open dialog or form draft.
    document.addEventListener("visibilitychange",function(){if(!document.hidden){queryCache.invalidate();offerRefresh();}});
    addEventListener("online",function(){queryCache.invalidate();offerRefresh();});
  }
  function composeSignals(scopeSignal,provided){
    if(!provided||provided===scopeSignal)return scopeSignal;
    if(typeof AbortSignal!=="undefined"&&typeof AbortSignal.any==="function")return AbortSignal.any([scopeSignal,provided]);
    var controller=new AbortController(),abort=function(){controller.abort();};
    if(scopeSignal.aborted||provided.aborted)controller.abort();else{scopeSignal.addEventListener("abort",abort,{once:true});provided.addEventListener("abort",abort,{once:true});}
    return controller.signal;
  }
  function createPageScope(){
    if(currentScope&&currentScope.active)currentScope.dispose();
    var controller=new AbortController(),cleanups=[],blockers=[],pendingMutations=0,inflightGets=new Map(),rosterReads=new Map(),readBatch=null,busyButtons=new Set();
    var scope={active:true,signal:controller.signal};
    function isActive(){return !signedOut&&scope.active&&currentScope===scope;}
    function onCleanup(callback){if(typeof callback!=="function")return function(){};if(!isActive()){callback();return function(){};}cleanups.push(callback);return function(){var index=cleanups.indexOf(callback);if(index>=0)cleanups.splice(index,1);};}
    function preventNavigation(check){if(typeof check!=="function")return function(){};var removed=false;function remove(){if(removed)return;removed=true;var index=blockers.indexOf(check);if(index>=0)blockers.splice(index,1);}blockers.push(check);onCleanup(remove);return remove;}
    function canLeave(detail){
      if(pendingMutations>0)return false;
      var dialog=document.querySelector(".cp-main dialog[open]");
      if(dialog)return false;
      for(var index=0;index<blockers.length;index+=1){if(blockers[index](detail)===false)return false;}
      return true;
    }
    function dispose(){if(!scope.active)return;scope.active=false;controller.abort();inflightGets.clear();rosterReads.clear();readBatch=null;busyButtons.forEach(function(button){ui.busy(button,false);});busyButtons.clear();while(cleanups.length){try{cleanups.pop()();}catch(_error){}}}
    // A controller load may contain sequential reads. Share its identity check
    // only until that explicit load finishes; mutations immediately discard it.
    function beginReadBatch(){var batch={access:null};readBatch=batch;return function(){if(readBatch===batch)readBatch=null;};}
    // A write must not be answered by a read that started before it settled: stop sharing every in-flight GET, and cancel team roster
    // reads outright when a team write lands, so the refresh that follows is always a new request.
    function teamPath(path){return String(path).split("?")[0];}
    function discardReads(path){
      var cancelRosters=/^\/api\/auth\/organization\/(?:create-team|update-team|remove-team|add-team-member|remove-team-member)$/.test(teamPath(path));
      inflightGets.clear();
      rosterReads.forEach(function(controller){if(cancelRosters)controller.abort();});
      rosterReads.clear();
    }
    async function request(path,options){
      if(!isActive())throw new DOMException("Page navigation aborted","AbortError");
      var settings=Object.assign({},options||{}),method=String(settings.method||"GET").toUpperCase(),mutation=method!=="GET"&&method!=="HEAD";
      settings.signal=composeSignals(controller.signal,settings.signal);
      if(mutation){readBatch=null;pendingMutations+=1;discardReads(path);invalidateMutation(path,settings);}
      var plainGet=method==="GET"&&(!options||Object.keys(options).every(function(key){return key==="method";}));
      var getKey=plainGet?String(path):"";
      if(getKey&&inflightGets.has(getKey))return inflightGets.get(getKey);
      var rosterAbort=getKey&&teamPath(path)==="/api/rendro/management/team-members"?new AbortController():null;
      if(rosterAbort)settings.signal=composeSignals(settings.signal,rosterAbort.signal);
      var accessRead=method==="GET"&&String(path)==="/api/rendro/management/access?organizationId="+encodeURIComponent(shellOrganization),batch=readBatch;
      if(accessRead&&batch&&batch.access)return batch.access;
      var needsAccess=Boolean(shellOrganization)&&method==="GET"&&(String(path).startsWith("/api/rendro/")||String(path).startsWith("/api/auth/organization/"))&&!String(path).startsWith("/api/rendro/management/access?");
      var access=needsAccess?request("/api/rendro/management/access?organizationId="+encodeURIComponent(shellOrganization)):Promise.resolve();
      var initial=ui.takeInitialPageData&&ui.takeInitialPageData(path,settings);
      if(initial&&queryCache&&getKey)queryCache.seed(path,initial.data);
      var dataRequest=initial?Promise.resolve(initial.data):queryCache&&getKey&&queryCache.canCache(getKey)?queryCache.request(path,settings,function(){return access;}):ui.request(path,settings);
      var pending=Promise.all([dataRequest,access]).then(function(values){if(!isActive())throw new DOMException("Page scope disposed","AbortError");var data=values[0];if(String(path).indexOf("/api/rendro/management/access?")===0&&(!data||data.id!==shellOrganization||data.userId!==shellUser||!data.member||data.member.userId!==shellUser)){clearQueryCache();var denied=new Error("Your account or organization access changed. Reload to continue.");denied.status=403;if(isActive())location.replace(location.href);throw denied;}return data;});
      if(accessRead&&batch){batch.access=pending;pending.catch(function(){if(batch.access===pending)batch.access=null;});}
      if(getKey)inflightGets.set(getKey,pending);
      if(rosterAbort)rosterReads.set(pending,rosterAbort);
      try{return await pending;}catch(error){if(error&&(error.status===401||error.status===403))clearQueryCache();throw error;}finally{if(mutation){pendingMutations=Math.max(0,pendingMutations-1);discardReads(path);invalidateMutation(path,settings);}if(getKey&&inflightGets.get(getKey)===pending)inflightGets.delete(getKey);rosterReads.delete(pending);}
    }
    function busy(button,on){if(!isActive()||!button)return;if(on)busyButtons.add(button);else busyButtons.delete(button);ui.busy(button,on);}
    function activeCall(name){return function(){if(!isActive())return name==="copyText"||name==="confirm"?Promise.resolve(false):undefined;return ui[name].apply(ui,arguments);};}
    Object.assign(scope,{beginReadBatch:beginReadBatch,request:request,isActive:isActive,guard:function(callback){return function(){if(isActive())return callback.apply(this,arguments);};},onCleanup:onCleanup,cleanup:onCleanup,preventNavigation:preventNavigation,canLeave:canLeave,dispose:dispose,busy:busy,copyText:activeCall("copyText"),toast:activeCall("toast"),openDialog:activeCall("openDialog"),applyTheme:activeCall("applyTheme"),confirm:activeCall("confirm"),setDocsLink:activeCall("setDocsLink")});
    currentScope=scope;if(signedOut)scope.dispose();return scope;
  }
  function disposePage(){if(currentScope)currentScope.dispose();currentScope=null;}
  function canLeave(detail){
    if(currentScope&&!currentScope.canLeave(detail))return false;
    return document.dispatchEvent(new CustomEvent("rendro:before-route-leave",{cancelable:true,detail:detail}));
  }
  ui.createPageScope=createPageScope;
  addEventListener("commentor-sign-out",function(){
    if(signedOut)return;signedOut=true;navigationVersion++;
    if(navigationController)navigationController.abort();
    if(pendingObserver)pendingObserver.disconnect();pendingObserver=null;scrollRestore=null;
    disposePage();clearQueryCache();
    if(ui.organizationContext)ui.organizationContext.dispose();
    if(cacheChannel){cacheChannel.close();cacheChannel=null;}
    if(ui.clearInitialPageData)ui.clearInitialPageData();
    window.__RENDRO_PAGE_STATE__=null;
  });
  // Onboarding and the organization chooser need disposal, but retain native navigation.
  if(!supported(new URL(location.href)))return;

  function materialize(value,route){return String(value||"").split(PROJECT_PLACEHOLDER).join(encodeURIComponent(route.projectId||""));}
  function hasLoadingContent(content){return Boolean(content&&content.querySelector(".loading-view,.skeleton-table-row"));}
  function normalizedServerMarkup(content){var clone=content.cloneNode(true);clone.querySelectorAll(":scope > dialog").forEach(function(node){node.remove();});return clone.innerHTML.replace(/>\s+</g,"><").trim();}
  // Back/Forward restores the offset saved with the history entry only once the destination has finished rendering: while its
  // skeleton or loading states are showing, the document is too short for the offset and the browser would clamp it. Any user
  // scroll input in the meantime wins, and a newer navigation drops the pending offset.
  function settleScroll(){var target=scrollRestore;scrollRestore=null;if(target!==null&&typeof window.scrollTo==="function")window.scrollTo(0,target);}
  function watchPendingContent(content){
    if(pendingObserver)pendingObserver.disconnect();
    function ready(){if(!content.isConnected||hasLoadingContent(content))return false;content.classList.replace("cp-navigation-pending","cp-navigation-ready");content.removeAttribute("aria-busy");content.removeAttribute("aria-label");if(pendingObserver)pendingObserver.disconnect();pendingObserver=null;settleScroll();return true;}
    if(ready())return;pendingObserver=new MutationObserver(ready);pendingObserver.observe(content,{childList:true,subtree:true});
  }
  function showDestinationSkeleton(route,mode,savedScroll){
    var page=loadingPages[route.section];if(!page)return null;var content=document.createElement("div"),actions=materialize(page.actions,route);
    content.className="cp-content cp-navigation-pending";content.setAttribute("aria-busy","true");content.setAttribute("aria-label","Loading "+page.heading);
    content.innerHTML='<header class="cp-page-head"><div class="cp-page-copy"><p class="eyebrow">'+page.eyebrow+'</p><h1 class="cp-page-heading">'+page.heading+'</h1><p class="cp-page-description">'+page.description+'</p></div>'+(actions?'<div class="cp-page-actions">'+actions+'</div>':'')+'</header>'+materialize(page.content,route);
    pendingExpectedMarkup.set(content,normalizedServerMarkup(content));
    var previous=main.querySelector(":scope > .cp-content");if(previous)previous.replaceWith(content);else main.append(content);
    watchPendingContent(content);
    var scrollTop=mode==="pop"&&Number.isFinite(savedScroll)?savedScroll:0;if(typeof window.scrollTo==="function")window.scrollTo(0,scrollTop);
    if(mode!=="pop"){var heading=content.querySelector("h1");if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
    return content;
  }
  // Documentation links are revealed by project pages only after an active
  // deployment is observed; keep them only while staying within that project.
  function syncDocsLinks(route){document.querySelectorAll("[data-cp-open-docs]").forEach(function(link){if(!route.projectId||link.getAttribute("data-cp-docs-project")!==route.projectId){link.hidden=true;link.removeAttribute("data-cp-docs-project");}});}
  function syncChrome(url){
    if(typeof ui.syncActiveNav==="function")ui.syncActiveNav();
    if(typeof ui.setNav==="function")ui.setNav(false,false);
    if(typeof ui.enhancePage==="function")ui.enhancePage();
    currentUrl=url.href;
  }
  function setHistory(url,mode,departingScroll){
    if(mode==="pop")return;
    var state=Object.assign({},history.state||{});
    if(mode==="replace"||url.href===location.href){state.__rendroManagementIndex=historyIndex;history.replaceState(state,"",url.href);}
    else{history.replaceState(Object.assign({},state,{__rendroManagementIndex:historyIndex,__rendroScrollY:departingScroll||0}),"",location.href);historyIndex+=1;state.__rendroManagementIndex=historyIndex;state.__rendroScrollY=0;history.pushState(state,"",url.href);}
  }
  var approvedUnload=false;
  function resetUnloadApproval(){approvedUnload=false;}
  function hardNavigate(url,replace){
    // The route guard already accepted this departure. Consume that decision
    // for this navigation's unload. Do not expire it with a timer: browsers may
    // dispatch beforeunload from a later navigation task.
    approvedUnload=true;
    try{if(replace)location.replace(url.href);else location.assign(url.href);}catch(error){approvedUnload=false;throw error;}
  }
  function validateDocument(doc,responseUrl){
    var nextMain=doc.querySelector(".cp-main[data-cp-route-envelope]"),stateNode=doc.querySelector("script[data-cp-page-state]"),scriptNode=doc.querySelector("script[data-cp-page-script]");
    if(!nextMain||!stateNode||!scriptNode)return null;
    if(nextMain.getAttribute("data-cp-shell-version")!==SHELL_VERSION||nextMain.getAttribute("data-cp-organization-id")!==shellOrganization||nextMain.getAttribute("data-cp-user-id")!==shellUser)return null;
    var finalRoute=supported(responseUrl),declaredProject=nextMain.getAttribute("data-cp-project-id")||"";
    if(!finalRoute||declaredProject!==(finalRoute.projectId||""))return null;
    var nextContent=nextMain.querySelector(":scope > .cp-content");if(!nextContent)return null;
    try{return {content:nextContent,state:JSON.parse(stateNode.textContent||"{}"),script:scriptNode,title:doc.title,route:finalRoute};}catch(_error){return null;}
  }
  function runPageScript(source){
    document.querySelectorAll("script[data-cp-page-script]").forEach(function(node){node.remove();});
    var script=document.createElement("script");script.setAttribute("data-cp-page-script","");
    if(documentNonce)script.nonce=documentNonce;
    script.textContent=source.textContent||"";document.body.append(script);
  }
  async function navigate(rawUrl,options){
    if(signedOut)return false;
    resetUnloadApproval();
    var url=new URL(rawUrl,location.href),route=supported(url),mode=options&&options.mode||"push";
    var leaveDetail={kind:mode==="pop"?"history":"navigation",url:url.href};
    if(!route||!loadingPages[route.section]){if(!(options&&options.checked)&&!canLeave(leaveDetail))return false;hardNavigate(url);return true;}
    if(url.pathname===location.pathname&&url.search===location.search&&url.hash!==location.hash){if(mode!=="pop")location.assign(url.href);else syncChrome(url);return true;}
    if(!(options&&options.checked)&&!canLeave(leaveDetail))return false;
    if(navigationController)navigationController.abort();navigationController=new AbortController();var version=++navigationVersion,departingScroll=window.scrollY||0;scrollRestore=mode==="pop"&&Number.isFinite(options&&options.scrollY)&&options.scrollY>0?options.scrollY:null;
    disposePage();if(typeof ui.setNav==="function")ui.setNav(false,false);syncDocsLinks(route);var pendingContent=showDestinationSkeleton(route,mode,options&&options.scrollY);setHistory(url,mode,departingScroll);syncChrome(url);
    var timedOut=false,timeoutId=setTimeout(function(){if(version!==navigationVersion)return;timedOut=true;navigationController.abort();hardNavigate(url,true);},15000);
    try{
      var bundle=window.RendroManagementPages,page=bundle&&bundle.version===SHELL_VERSION&&bundle.pages[route.section];
      if(page){
        // These are public build-time templates/controllers, never fetched user HTML.
        // Every management read still passes the fresh identity/membership gate.
        function substitute(value){return String(value).split("__RD_ORG__").join(encodeURIComponent(shellOrganization)).split("__RD_PROJECT__").join(encodeURIComponent(route.projectId||"")); }
        var state=JSON.parse(page.state,function(key,value){return typeof value==="string"?substitute(value):value;});
        state.organizationId=shellOrganization;state.projectId=route.projectId||"";state.userId=shellUser;
        pendingContent.insertAdjacentHTML("beforeend",substitute(page.dialogs));
        window.__RENDRO_PAGE_STATE__=state;document.title=page.title;
        syncChrome(url);hideRefresh();page.mount();if(typeof ui.enhancePage==="function")ui.enhancePage();
        if(!pendingObserver)settleScroll();
        return true;
      }
      var response=await fetch(url.href,{method:"GET",headers:{Accept:"text/html"},credentials:"same-origin",cache:"no-store",signal:navigationController.signal});
      if(version!==navigationVersion)return false;
      var responseUrl=new URL(response.url||url.href,location.href);
      if(!responseUrl.hash&&url.hash&&responseUrl.origin===url.origin&&responseUrl.pathname===url.pathname&&responseUrl.search===url.search)responseUrl.hash=url.hash;
      if(!response.ok){hardNavigate(responseUrl,true);return false;}
      var parsed=new DOMParser().parseFromString(await response.text(),"text/html"),validated=validateDocument(parsed,responseUrl);
      if(version!==navigationVersion)return false;
      if(!validated){hardNavigate(responseUrl,true);return false;}
      var incoming=document.importNode(validated.content,true),current=main.querySelector(":scope > .cp-content"),pendingHeading=pendingContent&&pendingContent.querySelector("h1"),restoreFocus=mode!=="pop"&&document.activeElement===pendingHeading,preservePending=current===pendingContent&&hasLoadingContent(pendingContent);
      if(preservePending&&pendingExpectedMarkup.get(pendingContent)!==normalizedServerMarkup(incoming)){hardNavigate(responseUrl,true);return false;}
      if(preservePending){Array.from(incoming.querySelectorAll(":scope > dialog")).forEach(function(dialog){pendingContent.append(dialog);});incoming=pendingContent;}else{if(pendingObserver){pendingObserver.disconnect();pendingObserver=null;}if(hasLoadingContent(incoming)){incoming.classList.add("cp-navigation-pending");incoming.setAttribute("aria-busy","true");watchPendingContent(incoming);}if(current)current.replaceWith(incoming);else main.append(incoming);}
      window.__RENDRO_PAGE_STATE__=validated.state;document.title=validated.title;
      if(responseUrl.href!==location.href){var finalState=Object.assign({},history.state||{}, {__rendroManagementIndex:historyIndex});history.replaceState(finalState,"",responseUrl.href);}
      syncChrome(responseUrl);hideRefresh();runPageScript(validated.script);if(typeof ui.enhancePage==="function")ui.enhancePage();if(restoreFocus){var heading=incoming.querySelector("h1");if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
      if(!pendingObserver)settleScroll();
      return true;
    }catch(error){if(error&&error.name==="AbortError")return false;if(version===navigationVersion&&!timedOut)hardNavigate(url,true);return false;}finally{clearTimeout(timeoutId);}
  }
  ui.navigate=function(href){return navigate(href,{mode:"push"});};
  ui.refresh=function(){if(!canLeave({kind:"refresh",url:location.href}))return Promise.resolve(false);if(queryCache)queryCache.invalidate();return navigate(location.href,{mode:"replace",checked:true});};
  var refreshButton=document.querySelector("#cp-refresh-button");if(refreshButton)refreshButton.addEventListener("click",function(){ui.refresh();});
  // The router restores offsets itself, after the destination has rendered; the browser's own restoration would apply them to a
  // still-short document and then fight the user's scrolling. Keep the current offset with the entry so a reload or a hard Back
  // to this document is restored the same way.
  if("scrollRestoration" in history)history.scrollRestoration="manual";
  addEventListener("pagehide",function(){history.replaceState(Object.assign({},history.state||{},{__rendroManagementIndex:historyIndex,__rendroScrollY:window.scrollY||0}),"",location.href);});
  var entryType=typeof performance!=="undefined"&&performance.getEntriesByType?(performance.getEntriesByType("navigation")[0]||{}).type:"",entryScroll=Number(history.state&&history.state.__rendroScrollY);
  if((entryType==="reload"||entryType==="back_forward")&&entryScroll>0){var initialContent=main.querySelector(":scope > .cp-content");if(initialContent){scrollRestore=entryScroll;watchPendingContent(initialContent);}}
  history.replaceState(Object.assign({},history.state||{}, {__rendroManagementIndex:historyIndex}),"",location.href);
  document.addEventListener("click",function(event){
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    var target=event.target instanceof Element?event.target.closest("a[href]"):null;if(!target||target.target||target.hasAttribute("download")||(target.relList&&target.relList.contains("external")))return;
    var url=new URL(target.href,location.href);if(!supported(url))return;
    if(url.pathname===location.pathname&&url.search===location.search&&url.hash!==location.hash)return;
    event.preventDefault();navigate(url.href,{mode:url.href===location.href?"replace":"push"});
  });
  addEventListener("popstate",function(event){
    if(suppressPop){suppressPop=false;historyIndex=Number(event.state&&event.state.__rendroManagementIndex)||historyIndex;currentUrl=location.href;return;}
    var url=new URL(location.href),targetIndex=Number(event.state&&event.state.__rendroManagementIndex),delta=Number.isFinite(targetIndex)?targetIndex-historyIndex:0;
    if(url.pathname===new URL(currentUrl).pathname&&url.search===new URL(currentUrl).search){historyIndex=Number.isFinite(targetIndex)?targetIndex:historyIndex;syncChrome(url);return;}
    if(!canLeave({kind:"history",url:url.href})){
      if(delta){suppressPop=true;history.go(-delta);}else{history.replaceState(Object.assign({},history.state||{}, {__rendroManagementIndex:historyIndex}),"",currentUrl);}
      return;
    }
    historyIndex=Number.isFinite(targetIndex)?targetIndex:historyIndex;navigate(url.href,{mode:"pop",checked:true,scrollY:Number(event.state&&event.state.__rendroScrollY)||0});
  });
  addEventListener("hashchange",function(){currentUrl=location.href;});
  addEventListener("pageshow",resetUnloadApproval);
  ["wheel","touchstart","keydown","pointerdown"].forEach(function(type){addEventListener(type,function(){scrollRestore=null;},{capture:true,passive:true});});
  // If the user resumes work after stopping navigation, a later close/reload
  // must protect the draft again. The initiating pointer/key event has already
  // passed the capture phase before hardNavigate grants the approval.
  ["pointerdown","keydown","input"].forEach(function(type){document.addEventListener(type,resetUnloadApproval,true);});
  if(window.navigation)window.navigation.addEventListener("navigateerror",resetUnloadApproval);
  addEventListener("beforeunload",function(event){if(approvedUnload){approvedUnload=false;return;}if(currentScope&&!currentScope.canLeave({kind:"unload",url:location.href})){event.preventDefault();event.returnValue="";}});
})();
`;
}

export function renderManagementNavigationRuntime(organizationId = ""): string {
  const pages = organizationId ? managementLoadingPages(organizationId) : {};
  const serialized = JSON.stringify(pages).replace(/</g, "\\u003c");
  return managementNavigationRuntime(serialized);
}
