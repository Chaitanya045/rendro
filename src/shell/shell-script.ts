/*
 * The repository shell's behaviour (topbar, theme, sidebar resizer, share, reading mode, menus), as source text.
 * scripts/build-shell.ts minifies it into the versioned bundle `/shell.js`; the shell loads it as a same-origin
 * script, so it needs no inline code and no per-response bytes. Leaf module (no app imports): the build runs
 * outside the app's path aliases.
 */
export const shareLabel = "Copy link";

export const shellScript = `
(function(){
  var root=document.documentElement;
  function normalizedTheme(){return window.RendroTheme.getMode();}
  function notifyTheme(mode){var frame=document.getElementById("content-frame");if(frame&&frame.contentWindow)frame.contentWindow.postMessage({type:"rendro-theme",theme:mode},"*");}
  window.RendroTheme.mount(document.getElementById("theme-toggle"),notifyTheme);

  var MIN_WIDTH=220;
  var MAX_WIDTH=420;
  var DEFAULT_WIDTH=280;
  var STEP=24;
  var sidebar=document.getElementById("doc-sidebar");
  var resizer=document.getElementById("sidebar-resizer");
  var topbar=document.querySelector(".topbar");
  var shellToggle=document.getElementById("shell-toggle");
  var shellToggleIcon=shellToggle&&shellToggle.querySelector(".material-symbols-outlined");
  var shellToggleMobileLabel=document.getElementById("shell-mobile-label");
  var shellShortcutKeys=document.getElementById("shell-shortcut-keys");
  var mobileTreeToggle=document.getElementById("mobile-tree-toggle");
  var mobileTreeBackdrop=document.getElementById("mobile-tree-backdrop");
  var shellShortcutText="Ctrl Shift H";
  if(shellToggle&&shellShortcutKeys){
    var platform=(navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||"";
    var isMac=/mac|iphone|ipad|ipod/i.test(platform);
    shellShortcutText=isMac?"⌘ Shift H":"Ctrl Shift H";
    shellShortcutKeys.innerHTML=isMac?'<span class="shortcut-key">⌘</span><span class="shortcut-key">Shift</span><span class="shortcut-key">H</span>':'<span class="shortcut-key">Ctrl</span><span class="shortcut-key">Shift</span><span class="shortcut-key">H</span>';
  }
  var topHotzone=document.getElementById("shell-hotzone-top");
  var leftHotzone=document.getElementById("shell-hotzone-left");
  var shellSidebarHideTimer;
  var shellHeaderHideTimer;
  var storedWidth=Number(localStorage.getItem("rendro-sidebar-width"));
  var expandedWidth=Number.isFinite(storedWidth)&&storedWidth>0?storedWidth:DEFAULT_WIDTH;

  function maxForViewport(){return Math.max(MIN_WIDTH,Math.min(MAX_WIDTH,window.innerWidth-360));}
  function clampWidth(value){return Math.max(MIN_WIDTH,Math.min(maxForViewport(),Math.round(value)));}
  function mobileTreeMode(){return window.matchMedia("(max-width:760px)").matches;}
  function setMobileTree(open){
    var active=mobileTreeMode()&&open;
    root.classList.toggle("tree-mobile-open",active);
    if(mobileTreeToggle){
      mobileTreeToggle.setAttribute("aria-expanded",String(active));
      mobileTreeToggle.setAttribute("aria-label",active?"Close document tree":"Open document tree");
    }
    if(sidebar){
      sidebar.setAttribute("aria-hidden",String(mobileTreeMode()&&!active));
      if("inert" in sidebar)sidebar.inert=mobileTreeMode()&&!active;
    }
  }
  function updateSidebarAria(){
    var width=clampWidth(expandedWidth);
    if(resizer){
      resizer.setAttribute("aria-valuemin",String(MIN_WIDTH));
      resizer.setAttribute("aria-valuemax",String(maxForViewport()));
      resizer.setAttribute("aria-valuenow",String(width));
      resizer.setAttribute("aria-valuetext","Document tree "+width+" pixels wide");
      resizer.tabIndex=mobileTreeMode()?-1:0;
    }
    if(sidebar&&!mobileTreeMode()){sidebar.setAttribute("aria-hidden","false");if("inert" in sidebar)sidebar.inert=false;}
  }
  function setSidebarWidth(value,persist){
    expandedWidth=clampWidth(value);
    root.style.setProperty("--sidebar-expanded-width",expandedWidth+"px");
    if(persist)localStorage.setItem("rendro-sidebar-width",String(expandedWidth));
    updateSidebarAria();
    notifyShellLayout();
  }
  function notifyShellLayout(){
    document.dispatchEvent(new CustomEvent("rendro:shell-layout"));
    requestAnimationFrame(function(){document.dispatchEvent(new CustomEvent("rendro:shell-layout"));});
  }
  function setShellHidden(hidden,persist){
    root.classList.toggle("shell-hidden",hidden);
    if(persist!==false)localStorage.setItem("rendro-shell-hidden",hidden?"1":"0");
    if(!hidden){
      root.classList.remove("shell-header-revealed");
      root.classList.remove("shell-sidebar-revealed");
    }
    if(shellToggle){
      shellToggle.setAttribute("aria-pressed",String(hidden));
      shellToggle.setAttribute("aria-label",(mobileTreeMode()?(hidden?"Exit reading mode":"Enter reading mode"):(hidden?"Show app shell":"Hide app shell"))+", keyboard shortcut "+shellShortcutText);
    }
    if(shellToggleMobileLabel)shellToggleMobileLabel.textContent=hidden?"Exit reading mode":"Enter reading mode";
    if(shellToggleIcon)shellToggleIcon.textContent=hidden?"fullscreen_exit":"fullscreen";
    if(hidden&&shellToggle)shellToggle.blur();
    notifyShellLayout();
  }
  function focusShellControl(){if(mobileTreeMode()&&mobileMoreButton)mobileMoreButton.focus();else if(shellToggle)shellToggle.focus();}
  function updateShellAutoReveal(e){
    if(!root.classList.contains("shell-hidden"))return;
    var wasHeader=root.classList.contains("shell-header-revealed");
    var wasSidebar=root.classList.contains("shell-sidebar-revealed");
    var headerLimit=wasHeader?72:12;
    var headerHovered=topbar&&topbar.matches(":hover");
    root.classList.toggle("shell-header-revealed",e.clientY<=headerLimit||!!headerHovered);
    var sidebarLimit=wasSidebar?clampWidth(expandedWidth)+24:12;
    var sidebarHovered=sidebar&&sidebar.matches(":hover");
    var resizerHovered=resizer&&resizer.matches(":hover");
    var revealSidebar=e.clientX<=sidebarLimit||!!sidebarHovered||!!resizerHovered;
    root.classList.toggle("shell-sidebar-revealed",revealSidebar);
    if(wasHeader!==root.classList.contains("shell-header-revealed")||wasSidebar!==root.classList.contains("shell-sidebar-revealed"))notifyShellLayout();
  }
  function scheduleHideShellHeader(){
    if(!root.classList.contains("shell-hidden"))return;
    if(shellHeaderHideTimer!==undefined)window.clearTimeout(shellHeaderHideTimer);
    shellHeaderHideTimer=window.setTimeout(function(){
      var headerHovered=topbar&&topbar.matches(":hover");
      var hotzoneHovered=topHotzone&&topHotzone.matches(":hover");
      if(!headerHovered&&!hotzoneHovered&&root.classList.contains("shell-header-revealed")){
        root.classList.remove("shell-header-revealed");
        notifyShellLayout();
      }
    },80);
  }
  function revealShellHeader(){
    if(root.classList.contains("shell-hidden")&&!root.classList.contains("shell-header-revealed")){root.classList.add("shell-header-revealed");notifyShellLayout();}
  }
  function hideShellHeader(){
    if(root.classList.contains("shell-hidden")&&root.classList.contains("shell-header-revealed")){root.classList.remove("shell-header-revealed");notifyShellLayout();}
  }
  function revealShellSidebar(){
    if(root.classList.contains("shell-hidden")&&!root.classList.contains("shell-sidebar-revealed")){root.classList.add("shell-sidebar-revealed");notifyShellLayout();}
  }
  function scheduleHideShellSidebar(){
    if(!root.classList.contains("shell-hidden"))return;
    if(shellSidebarHideTimer!==undefined)window.clearTimeout(shellSidebarHideTimer);
    shellSidebarHideTimer=window.setTimeout(function(){
      var sidebarHovered=sidebar&&sidebar.matches(":hover");
      var resizerHovered=resizer&&resizer.matches(":hover");
      if(!sidebarHovered&&!resizerHovered&&root.classList.contains("shell-sidebar-revealed")){
        root.classList.remove("shell-sidebar-revealed");
        notifyShellLayout();
      }
    },80);
  }

  setSidebarWidth(expandedWidth,false);
  setMobileTree(false);
  root.getBoundingClientRect();
  root.classList.add("sidebar-ready");
  setShellHidden(localStorage.getItem("rendro-shell-hidden")==="1",false);

  if(resizer){
    var dragging=false;
    var impactSparkTimer;
    var moveSparkTimer;
    function updateResizerOrigin(e){
      var rect=resizer.getBoundingClientRect();
      var y=Math.max(0,Math.min(rect.height,e.clientY-rect.top));
      resizer.style.setProperty("--resizer-origin-y",y+"px");
    }
    function triggerImpactSparks(){
      if(dragging)return;
      resizer.classList.remove("resizer-impact-sparks");
      resizer.offsetWidth;
      resizer.classList.add("resizer-impact-sparks");
      if(impactSparkTimer!==undefined)window.clearTimeout(impactSparkTimer);
      impactSparkTimer=window.setTimeout(function(){resizer.classList.remove("resizer-impact-sparks");},1000);
    }
    var lastResizeX=0;
    function stopResizeMoving(){
      root.classList.remove("sidebar-resizing-moving");
      root.classList.remove("sidebar-resizing-trail-left");
      root.classList.remove("sidebar-resizing-trail-right");
    }
    function markResizeMoving(deltaX){
      if(Math.abs(deltaX)<1)return;
      root.classList.add("sidebar-resizing-moving");
      root.classList.toggle("sidebar-resizing-trail-left",deltaX>0);
      root.classList.toggle("sidebar-resizing-trail-right",deltaX<0);
      if(moveSparkTimer!==undefined)window.clearTimeout(moveSparkTimer);
      moveSparkTimer=window.setTimeout(stopResizeMoving,120);
    }
    resizer.addEventListener("pointerenter",function(e){updateResizerOrigin(e);triggerImpactSparks();});
    resizer.addEventListener("pointermove",function(e){
      updateResizerOrigin(e);
      if(dragging){
        var deltaX=e.clientX-lastResizeX;
        setSidebarWidth(e.clientX,false);
        markResizeMoving(deltaX);
        lastResizeX=e.clientX;
      }
    });
    resizer.addEventListener("pointerdown",function(e){
      updateResizerOrigin(e);
      resizer.classList.remove("resizer-impact-sparks");
      lastResizeX=e.clientX;
      stopResizeMoving();
      dragging=true;
      root.classList.add("sidebar-resizing");
      resizer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    function finishResize(e){
      if(!dragging)return;
      dragging=false;
      root.classList.remove("sidebar-resizing");
      stopResizeMoving();
      if(moveSparkTimer!==undefined)window.clearTimeout(moveSparkTimer);
      setSidebarWidth(expandedWidth,true);
      try{resizer.releasePointerCapture(e.pointerId)}catch(_){}
    }
    resizer.addEventListener("pointerup",finishResize);
    resizer.addEventListener("pointercancel",finishResize);
    resizer.addEventListener("keydown",function(e){
      if(e.key==="ArrowLeft"){e.preventDefault();setSidebarWidth(expandedWidth-STEP,true);}
      else if(e.key==="ArrowRight"){e.preventDefault();setSidebarWidth(expandedWidth+STEP,true);}
      else if(e.key==="Home"){e.preventDefault();setSidebarWidth(MIN_WIDTH,true);}
      else if(e.key==="End"){e.preventDefault();setSidebarWidth(maxForViewport(),true);}
    });
  }
  window.addEventListener("resize",function(){setSidebarWidth(expandedWidth,false);setMobileTree(root.classList.contains("tree-mobile-open"));});
  if(shellToggle)shellToggle.addEventListener("click",function(){setShellHidden(!root.classList.contains("shell-hidden"));});
  if(mobileTreeToggle)mobileTreeToggle.addEventListener("click",function(){setMobileTree(!root.classList.contains("tree-mobile-open"));});
  if(mobileTreeBackdrop)mobileTreeBackdrop.addEventListener("click",function(){setMobileTree(false);});
  if(sidebar)sidebar.addEventListener("click",function(e){if(e.target instanceof Element&&e.target.closest(".tree-item[data-path]"))setMobileTree(false);});
  document.addEventListener("pointermove",updateShellAutoReveal,{passive:true});
  if(topHotzone){topHotzone.addEventListener("pointerenter",revealShellHeader);topHotzone.addEventListener("pointerleave",scheduleHideShellHeader);}
  if(leftHotzone){leftHotzone.addEventListener("pointerenter",revealShellSidebar);leftHotzone.addEventListener("pointerleave",scheduleHideShellSidebar);}
  if(topbar)topbar.addEventListener("mouseleave",scheduleHideShellHeader);
  if(sidebar)sidebar.addEventListener("mouseleave",scheduleHideShellSidebar);
  if(resizer)resizer.addEventListener("mouseleave",scheduleHideShellSidebar);
  document.addEventListener("keydown",function(e){
    var key=(e.key||"").toLowerCase();
    var shellShortcut=(key==="h"||e.code==="KeyH")&&(e.ctrlKey||e.metaKey)&&e.shiftKey&&!e.altKey&&!e.repeat&&!(e.getModifierState&&e.getModifierState("AltGraph"));
    if(shellShortcut&&!(e.target instanceof Element&&e.target.closest("input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable='']"))){
      e.preventDefault();
      setShellHidden(!root.classList.contains("shell-hidden"));
      if(!root.classList.contains("shell-hidden"))focusShellControl();
      return;
    }
    if(e.key==="Escape"&&root.classList.contains("tree-mobile-open")){
      e.preventDefault();
      setMobileTree(false);
      if(mobileTreeToggle)mobileTreeToggle.focus();
      return;
    }
    if(e.key==="Escape"&&root.classList.contains("shell-hidden")){
      e.preventDefault();
      setShellHidden(false);
      focusShellControl();
    }
  });
  var lastThemeReady=-Infinity;
  window.addEventListener("message",function(e){
    var allowedOrigin=e.origin===window.location.origin||(window.RENDRO_DOCUMENT_BASE&&e.origin==="null");
    if(!allowedOrigin||!e.data||e.data.type!=="commentor-theme-ready")return;
    var themeFrame=document.getElementById("content-frame");
    if(!themeFrame||e.source!==themeFrame.contentWindow)return;
    if(performance.now()-lastThemeReady<100)return;
    lastThemeReady=performance.now();
    notifyTheme(root.dataset.theme||normalizedTheme());
  });

  var mobileMoreButton=document.getElementById("mobile-more-btn"),mobileMoreMenu=document.getElementById("mobile-more-menu");
  var mobileMoreMedia=window.matchMedia("(max-width:760px)");
  var mobileMoreItems=[document.querySelector(".shortcut-tooltip-wrap"),document.getElementById("theme-toggle")];
  var mobileMoreSlots=mobileMoreItems.map(function(item){var slot=document.createComment("mobile-more-slot");item.parentNode.insertBefore(slot,item);return {item:item,slot:slot};});
  var mobileMoreSyncedMode=null;
  function setMobileMore(open,restoreFocus){
    if(!mobileMoreButton||!mobileMoreMenu)return;
    var active=mobileMoreMedia.matches&&open;
    mobileMoreMenu.hidden=!active;
    mobileMoreButton.setAttribute("aria-expanded",String(active));
    if(active){var first=mobileMoreMenu.querySelector("a,button");if(first)first.focus();}
    if(!active&&restoreFocus)mobileMoreButton.focus();
  }
  function syncMobileMore(){
    var mobileMode=mobileMoreMedia.matches;
    if(mobileMoreSyncedMode===mobileMode)return;
    mobileMoreSyncedMode=mobileMode;
    if(!mobileMoreMenu)return;
    setMobileMore(false,false);
    mobileMoreSlots.forEach(function(entry){
      if(mobileMode)mobileMoreMenu.appendChild(entry.item);
      else entry.slot.parentNode.insertBefore(entry.item,entry.slot.nextSibling);
    });
    setShellHidden(root.classList.contains("shell-hidden"),false);
  }
  syncMobileMore();
  if(mobileMoreMedia.addEventListener)mobileMoreMedia.addEventListener("change",syncMobileMore);
  else mobileMoreMedia.addListener(syncMobileMore);
  window.addEventListener("resize",function(){if(mobileMoreMedia.matches!==mobileMoreSyncedMode)syncMobileMore();});
  if(mobileMoreButton)mobileMoreButton.addEventListener("click",function(e){e.stopPropagation();setMobileMore(mobileMoreMenu.hidden,false);});
  mobileMoreItems.forEach(function(item){item.addEventListener("click",function(){setMobileMore(false,false);});});

  document.addEventListener("keydown",function(e){if(e.key==="Escape"){var restore=Boolean(mobileMoreMenu&&!mobileMoreMenu.hidden);setMobileMore(false,restore);}});
  var shareBtn=document.getElementById("share-btn");
  var shareFeedbackLabel=document.getElementById("share-feedback-label");
  var shareFeedbackIcon=document.getElementById("share-feedback-icon");
  var shareFeedbackTimer,shareAnnouncements=0;
  var shareError=document.getElementById("share-error"),shareErrorText=document.getElementById("share-error-text"),shareLive=document.getElementById("share-live"),shareRetry=document.getElementById("share-retry"),shareDismiss=document.getElementById("share-dismiss");
  // The live region exists, empty, from page load. It is written only when a notice appears.
  function announceShare(text){shareLive.textContent=text+(shareAnnouncements++%2?"\u00a0":"");}
  function clearShareError(){shareError.hidden=true;shareErrorText.textContent="";shareLive.textContent="";}
  function resetShareButton(){clearTimeout(shareFeedbackTimer);shareBtn.classList.remove("is-loading","is-feedback");shareBtn.removeAttribute("aria-busy");shareBtn.setAttribute("aria-label",${JSON.stringify(shareLabel)});}
  function showShareError(message,retry){
    if(signedOut)return;
    // A failure for a document the reader has already left must not label the new one.
    if(shareDoc!==(window.RENDRO_CURRENT_DOC||"")){resetShareButton();return;}
    clearShareError();resetShareButton();
    shareError.hidden=false;shareRetry.hidden=!retry;
    shareErrorText.textContent=message;announceShare(message);
  }
  function dismissShareError(){shareError.hidden=true;shareBtn.focus();}
  shareDismiss.addEventListener("click",dismissShareError);
  shareRetry.addEventListener("click",function(){shareBtn.focus();shareBtn.click();});
  document.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&!shareError.hidden&&(shareError.contains(document.activeElement)||document.activeElement===shareBtn))dismissShareError();
  });
  // The lazy tree assigns the current document on every navigation; assignment announces the change.
  var currentDocument=window.RENDRO_CURRENT_DOC;
  Object.defineProperty(window,"RENDRO_CURRENT_DOC",{configurable:true,enumerable:true,get:function(){return currentDocument;},set:function(value){var changed=value!==currentDocument;currentDocument=value;if(changed)window.dispatchEvent(new Event("rendro:document-change"));}});
  // Every notice describes one document.
  addEventListener("rendro:document-change",clearShareError);
  var sharePending=false,signedOut=false,shareDoc="";
  addEventListener("commentor-sign-out",function(){signedOut=true;clearShareError();clearTimeout(shareFeedbackTimer);setMobileMore(false,false);});
  function setShareLoading(){clearTimeout(shareFeedbackTimer);shareBtn.classList.remove("is-feedback");shareBtn.classList.add("is-loading");shareBtn.setAttribute("aria-busy","true");shareBtn.setAttribute("aria-label","Copying link…");}
  function setShareFeedback(message){if(signedOut)return;shareBtn.classList.remove("is-loading");shareBtn.removeAttribute("aria-busy");shareFeedbackLabel.textContent=message;shareFeedbackIcon.textContent="check";shareBtn.classList.add("is-feedback");shareBtn.setAttribute("aria-label",message);clearTimeout(shareFeedbackTimer);shareFeedbackTimer=window.setTimeout(function(){shareBtn.classList.remove("is-feedback");shareBtn.setAttribute("aria-label",${JSON.stringify(shareLabel)});},1800);}
  async function copyText(text){if(signedOut)return;try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}}catch(_){}if(signedOut)return;var ta=document.createElement("textarea");ta.value=text;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.top="-999px";ta.style.left="-999px";document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,text.length);try{if(!document.execCommand("copy"))throw new Error("copy failed");}finally{ta.remove();}}
  // Copies the reader's URL for the current document: the branch view for a branch, never a ticket or the pinned frame.
  shareBtn.addEventListener("click",async function(e){
    e.stopPropagation();if(signedOut||sharePending)return;
    var doc=window.RENDRO_CURRENT_DOC||"";
    shareDoc=doc;
    if(!doc){showShareError("Select a document first.",false);return;}
    clearShareError();sharePending=true;setShareLoading();
    try{
      var relativeDoc=doc.indexOf(window.RENDRO_ORG+"/")===0?doc.slice(window.RENDRO_ORG.length+1):doc;
      var url=new URL(window.RENDRO_DOCUMENT_BASE,window.location.origin);url.searchParams.set("doc",relativeDoc);
      await copyText(url.href);setShareFeedback("Link copied!");
    }catch(_){showShareError("The link could not be copied. Please try again.",true);}
    finally{sharePending=false;}
  });
  document.addEventListener("click",function(){setMobileMore(false,false);});
  // The document is another frame: a click inside it never reaches this page's click handler, but it moves focus into the
  // frame and blurs this window. Keyboard use of the menus keeps focus in this page, so nothing closes then.
  window.addEventListener("blur",function(){if(document.activeElement===document.getElementById("content-frame"))setMobileMore(false,false);});
  // Engines that do not report that blur are told by the document itself: it posts a bare message on a press inside it.
  window.addEventListener("message",function(e){var frame=document.getElementById("content-frame");if(frame&&e.source===frame.contentWindow&&e.data&&e.data.type==="doc-pointer")setMobileMore(false,false);});
  // The document's "Try again" page (a 503 while a backend was unreachable) cannot reload itself with the session cookie from
  // inside the sandbox, so it asks this page to: src is the document the shell chose, and replace keeps the history entry.
  // The retry is the shell's own navigation, recorded as src/viewer/content-frame.ts records one (#296).
  window.addEventListener("message",function(e){var frame=document.getElementById("content-frame");if(frame&&frame.contentWindow&&e.source===frame.contentWindow&&e.data&&e.data.type==="doc-retry"){if(frame.dataset.navigation)frame.dataset.loading=frame.dataset.navigation=String(Number(frame.dataset.navigation)+1);frame.contentWindow.location.replace(frame.src);}});
})();
`;
