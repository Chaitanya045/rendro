import { AsyncLocalStorage } from "node:async_hooks";
import { nonceAttribute } from "@/middleware/html-nonce";

// Request-local, authorized data only. Never shared between viewers or requests.
export const managementInitialData = new AsyncLocalStorage<{ path: string; data: unknown }>();

export function renderManagementInitialData(): string {
  const initial = managementInitialData.getStore();
  if (!initial) return "";
  const json = JSON.stringify(initial).replace(/</g, "\\u003c");
  return `<script${nonceAttribute()} data-cp-initial-data type="application/json">${json}</script>`;
}

// Consumed before the query cache: retained data must not replace the freshly
// authorized SSR result. Unused data expires after initial controller startup.
export const managementInitialDataRuntime = String.raw`
(function(ui){
  var element=document.querySelector("script[data-cp-initial-data]"),initial=null,page=location.href;
  if(element){try{initial=JSON.parse(element.textContent);}catch(_){}element.remove();}
  function clear(){initial=null;}
  ui.clearInitialPageData=clear;addEventListener("pagehide",clear);
  function key(path){var url=new URL(path,location.href);url.searchParams.sort();return url.href;}
  ui.takeInitialPageData=function(path,options){
    if(!initial||location.href!==page||options&&String(options.method||"GET").toUpperCase()!=="GET"||key(path)!==key(initial.path))return null;
    var result={data:initial.data};clear();return result;
  };
})(window.RendroUI);
`;
