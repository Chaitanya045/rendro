import { RETRY_AFTER_SOURCE } from "../../shared/retry-after";

/** Shared transport for management pages and the org switcher. Only safe GETs retry. */
export const managementRequestScript = String.raw`
  ${RETRY_AFTER_SOURCE}
  async function waitForReadRetry(milliseconds,signal){
    if(signal&&signal.aborted)throw new DOMException("Page navigation aborted","AbortError");
    await new Promise(function(resolve,reject){
      function abort(){clearTimeout(timer);reject(new DOMException("Page navigation aborted","AbortError"));}
      var timer=setTimeout(function(){if(signal)signal.removeEventListener("abort",abort);resolve();},milliseconds);
      if(signal)signal.addEventListener("abort",abort,{once:true});
    });
  }
  async function request(path,options){
    var initial=window.RendroUI.takeInitialPageData&&window.RendroUI.takeInitialPageData(path,options);if(initial)return initial.data;
    var settings=Object.assign({headers:{Accept:"application/json","Content-Type":"application/json"}},options||{}),method=String(settings.method||"GET").toUpperCase();
    var orgRead=method==="GET"&&String(path).indexOf("/api/auth/organization/")===0;
    if(orgRead)settings.cache="no-store";
    for(var attempt=0;;attempt++){
      var response=await fetch(path,settings),data=null;try{data=await response.json();}catch(_error){}
      if(response.ok)return data;
      var retryable=orgRead&&(response.status===429||response.status===503);
      var header=response.headers&&response.headers.get("Retry-After")||response.headers&&response.headers.get("X-Retry-After");
      var delay=parseRetryAfterMs(header,Date.now()),seconds=delay?Math.ceil(delay/1000):1;
      // Two short retries at most. Long server delays belong in the styled
      // page retry state, not a blocked navigation or an early retry.
      if(retryable&&attempt<2&&seconds<=2){await waitForReadRetry(seconds*1000,settings.signal);continue;}
      var message=data&&(data.message||data.error),error=new Error(retryable?"Organization information is temporarily unavailable. Please try again in "+seconds+" second"+(seconds===1?"":"s")+".":typeof message==="string"?message:"Request failed. Please try again.");
      error.status=response.status;if(retryable)error.retryAfter=seconds;throw error;
    }
  }
`;
