/**
 * Installs the small client-side organization context shared by management routes.
 * Full organization responses contain authorization state, so they are reused only
 * while an active request is in flight. Only display identity survives completion.
 */
export const organizationContextScript = String.raw`
(function(root){
  "use strict";
  if(root.organizationContext)return;
  var inFlight=new Map(),displayNames=new Map();
  function active(ui){return !ui.isActive||ui.isActive();}
  function remember(organization){if(organization&&organization.id)displayNames.set(String(organization.id),{name:organization.name||"Organization",mark:(organization.name||"R").charAt(0).toUpperCase()});return organization;}
  root.organizationContext={
    request:function(ui,organizationId){
      var key=String(organizationId),existing=inFlight.get(key);
      if(existing&&existing.active())return existing.promise;
      var entry={active:function(){return active(ui);},promise:null};
      entry.promise=Promise.resolve(ui.request("/api/auth/organization/get-full-organization?organizationId="+encodeURIComponent(key))).then(function(organization){if(active(ui))remember(organization);return organization;}).finally(function(){if(inFlight.get(key)===entry)inFlight.delete(key);});
      inFlight.set(key,entry);
      return entry.promise;
    },
    display:function(organizationId){return displayNames.get(String(organizationId))||null;},
    remember:remember
  };
})(window.RendroUI);
`;
