import { mobileViewportStyles } from "./viewport";

export const sharedThemeStyles = String.raw`
${mobileViewportStyles}
.rendro-theme-control.rendro-theme-control{display:inline-flex;align-items:center;justify-content:center;transition:background-color 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1)}
.rendro-theme-control.rendro-theme-control:active{transform:scale(.98)}
.rendro-theme-icon-window{width:20px;height:20px;overflow:hidden;display:inline-flex;align-items:flex-start;justify-content:center}
.rendro-theme-icon-track{display:flex;flex-direction:column;transition:transform 300ms cubic-bezier(.4,0,.2,1);will-change:transform}
.rendro-theme-icon{width:20px;height:20px;line-height:20px;display:flex;align-items:center;justify-content:center;flex:0 0 20px;font-size:20px}
@supports (view-transition-name:root){html.rendro-theme-rippling::view-transition-old(root),html.rendro-theme-rippling::view-transition-new(root){animation:none;mix-blend-mode:normal}html.rendro-theme-rippling::view-transition-image-pair(root){isolation:isolate}html.rendro-theme-rippling::view-transition-new(root){clip-path:circle(0 at var(--rendro-theme-x,50%) var(--rendro-theme-y,50%))}}
@media (max-width:760px){.rendro-theme-control{min-width:44px;min-height:44px}}
@media (prefers-reduced-motion:reduce){.rendro-theme-control,.rendro-theme-icon-track{transition:none!important}.rendro-theme-control.rendro-theme-control:active{transform:none!important}}
`;

export const sharedThemeRuntime = String.raw`
(function(){
  "use strict";
  var STORAGE_KEY="commentor-theme";
  var ORDER=["system","dark","light"];
  var ICON_INDEX={system:0,dark:1,light:2};
  var NAMES={system:"system",dark:"dark",light:"light"};
  function valid(mode){return mode==="system"||mode==="dark"||mode==="light";}
  function savedMode(){try{var mode=localStorage.getItem(STORAGE_KEY);return valid(mode)?mode:"system";}catch(_error){return "system";}}
  function media(){return window.matchMedia("(prefers-color-scheme:dark)");}
  function reduced(){return window.matchMedia("(prefers-reduced-motion:reduce)").matches;}
  function resolved(mode){return mode==="system"?(media().matches?"dark":"light"):mode;}
  var runtimeMode=savedMode(),activeController=null;
  function applyRoot(mode,persist){runtimeMode=valid(mode)?mode:"system";var result=resolved(runtimeMode),root=document.documentElement;root.dataset.theme=runtimeMode;root.dataset.resolvedTheme=result;root.classList.toggle("dark",result==="dark");if(persist){try{localStorage.setItem(STORAGE_KEY,runtimeMode);}catch(_error){}}return result;}
  function makeIcon(name){var icon=document.createElement("span");icon.className="material-symbols-outlined rendro-theme-icon";icon.textContent=name;icon.setAttribute("aria-hidden","true");return icon;}
  function mount(button,onChange){
    if(!button)throw new Error("RendroTheme.mount requires a button");
    var root=document.documentElement;
    button.classList.add("rendro-theme-control");
    var windowEl=document.createElement("span");windowEl.className="rendro-theme-icon-window";windowEl.setAttribute("aria-hidden","true");
    var track=document.createElement("span");track.className="rendro-theme-icon-track";
    track.append(makeIcon("contrast"),makeIcon("dark_mode"),makeIcon("light_mode"),makeIcon("contrast"));windowEl.append(track);button.replaceChildren(windowEl);
    var mode=runtimeMode,intendedMode=mode,intendedPersist=false,activeTransition=null,activeAnimation=null,transitionId=0,destroyed=false,iconResetTimer=null;
    function render(animateIcon,previous){var next=ORDER[(ORDER.indexOf(mode)+1)%ORDER.length],wrap=animateIcon&&previous==="light"&&mode==="system",position=wrap?3:ICON_INDEX[mode];if(iconResetTimer!==null)clearTimeout(iconResetTimer);track.style.transition=animateIcon&&!reduced()?"":"none";track.style.transform="translateY(-"+(position*20)+"px)";if(wrap){iconResetTimer=setTimeout(function(){track.style.transition="none";track.style.transform="translateY(0)";},320);}button.setAttribute("aria-label","Switch to "+NAMES[next]+" theme");button.setAttribute("title","Theme: "+NAMES[mode]);button.dataset.themeMode=mode;}
    function commit(next,persist,animateIcon){var previous=mode;mode=valid(next)?next:"system";intendedMode=mode;var result=applyRoot(mode,persist);render(Boolean(animateIcon),previous);if(onChange)onChange(mode,result);}
    function apply(next,persist,animate){
      if(destroyed)return;
      next=valid(next)?next:"system";
      intendedMode=next;intendedPersist=Boolean(persist);
      function cancelPending(){transitionId+=1;if(activeTransition&&typeof activeTransition.skipTransition==="function"){try{activeTransition.skipTransition();}catch(_error){}}if(activeAnimation&&typeof activeAnimation.cancel==="function"){try{activeAnimation.cancel();}catch(_error){}}activeTransition=null;activeAnimation=null;root.classList.remove("rendro-theme-rippling");}
      if(!animate||reduced()||typeof document.startViewTransition!=="function"||typeof root.animate!=="function"){cancelPending();commit(next,intendedPersist,Boolean(animate));return;}
      cancelPending();var id=transitionId;
      var rect=button.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,radius=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y));
      root.style.setProperty("--rendro-theme-x",x+"px");root.style.setProperty("--rendro-theme-y",y+"px");root.classList.add("rendro-theme-rippling");
      var transition,committed=false;
      function finishCommit(){if(committed||id!==transitionId)return;committed=true;commit(next,Boolean(persist),true);}
      function release(){if(id!==transitionId)return;if(activeAnimation&&typeof activeAnimation.cancel==="function"){try{activeAnimation.cancel();}catch(_error){}}activeAnimation=null;activeTransition=null;root.classList.remove("rendro-theme-rippling");}
      function abandon(){if(id!==transitionId)return;try{if(transition&&typeof transition.skipTransition==="function")transition.skipTransition();}catch(_error){}release();finishCommit();}
      try{transition=document.startViewTransition(finishCommit);}catch(_error){root.classList.remove("rendro-theme-rippling");commit(next,Boolean(persist),true);return;}
      activeTransition=transition;
      Promise.resolve(transition.updateCallbackDone).then(finishCommit,abandon);
      Promise.resolve(transition.ready).then(function(){if(id!==transitionId)return;try{activeAnimation=root.animate({clipPath:["circle(0px at "+x+"px "+y+"px)","circle("+radius+"px at "+x+"px "+y+"px)"]},{duration:520,easing:"cubic-bezier(.4,0,.2,1)",fill:"both",pseudoElement:"::view-transition-new(root)"});}catch(_error){abandon();}},abandon);
      Promise.resolve(transition.finished).then(release,function(){release();});
    }
    function click(){apply(ORDER[(ORDER.indexOf(intendedMode)+1)%ORDER.length],true,true);}
    function systemChange(){if(intendedMode==="system")apply("system",false,false);}
    function motionChange(){if(motionMedia.matches&&activeTransition){transitionId+=1;try{if(typeof activeTransition.skipTransition==="function")activeTransition.skipTransition();}catch(_error){}if(activeAnimation&&typeof activeAnimation.cancel==="function"){try{activeAnimation.cancel();}catch(_error){}}activeTransition=null;activeAnimation=null;root.classList.remove("rendro-theme-rippling");commit(intendedMode,intendedPersist,false);}}
    function storageChange(event){if(event.key===STORAGE_KEY)apply(valid(event.newValue)?event.newValue:"system",false,false);}
    var controller={apply:apply,getMode:function(){return intendedMode;},destroy:function(){if(destroyed)return;destroyed=true;transitionId+=1;if(iconResetTimer!==null)clearTimeout(iconResetTimer);button.removeEventListener("click",click);systemMedia.removeEventListener("change",systemChange);motionMedia.removeEventListener("change",motionChange);window.removeEventListener("storage",storageChange);if(activeTransition&&typeof activeTransition.skipTransition==="function"){try{activeTransition.skipTransition();}catch(_error){}}if(activeAnimation&&typeof activeAnimation.cancel==="function"){try{activeAnimation.cancel();}catch(_error){}}activeTransition=null;activeAnimation=null;root.classList.remove("rendro-theme-rippling");if(activeController===controller)activeController=null;}};
    var systemMedia=media(),motionMedia=window.matchMedia("(prefers-reduced-motion:reduce)");button.addEventListener("click",click);systemMedia.addEventListener("change",systemChange);motionMedia.addEventListener("change",motionChange);window.addEventListener("storage",storageChange);commit(mode,false,false);activeController=controller;
    return controller;
  }
  applyRoot(runtimeMode,false);
  var initialMedia=media();initialMedia.addEventListener("change",function(){if(!activeController&&runtimeMode==="system")applyRoot("system",false);});
  window.addEventListener("storage",function(event){if(!activeController&&event.key===STORAGE_KEY)applyRoot(valid(event.newValue)?event.newValue:"system",false);});
  window.RendroTheme={mount:mount,getMode:function(){return activeController?activeController.getMode():runtimeMode;}};
  window.RendroUI=window.RendroUI||{};
  window.RendroUI.applyTheme=function(mode,persist,animate){if(activeController)activeController.apply(mode,persist,animate);else applyRoot(mode,persist);};
})();`;

export function renderThemeAssets(): string {
  return `<style data-rendro-theme>${sharedThemeStyles}</style><script data-rendro-theme>${sharedThemeRuntime}</script>`;
}
