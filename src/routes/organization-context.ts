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
  async function completeMembers(ui,key,organization){
    if(!organization||!organization.members||organization.members.length<100)return organization;
    // Better Auth's full-organization join silently caps the roster at 100.
    // Page the supported member API rather than increasing that join's limit
    // (its user join has a separate limit). Never retain permission snapshots.
    var members=[],seen=new Set(),cursors=new Set(),cursor=null;
    do{
      if(!active(ui))return organization;
      var page=await ui.request("/api/rendro/management/members?organizationId="+encodeURIComponent(key)+(cursor?"&cursor="+encodeURIComponent(cursor):""));
      if(!page||!Array.isArray(page.members)||(page.nextCursor!==null&&typeof page.nextCursor!=="string"))throw new Error("Unable to load the complete member list. Please retry.");
      if(page.nextCursor!==null&&cursors.has(page.nextCursor))throw new Error("The member list changed while loading. Please retry.");
      page.members.forEach(function(member){if(seen.has(member.id))throw new Error("The member list changed while loading. Please retry.");seen.add(member.id);members.push(member);});
      cursor=page.nextCursor;cursors.add(cursor);
    }while(cursor!==null);
    organization.members=members;return organization;
  }
  root.organizationContext={
    access:function(ui,organizationId){return Promise.resolve(ui.request("/api/rendro/management/access?organizationId="+encodeURIComponent(organizationId))).then(function(organization){if(active(ui))remember(organization);return organization;});},
    request:function(ui,organizationId){
      var key=String(organizationId),existing=inFlight.get(key);
      if(existing&&existing.active())return existing.promise;
      var entry={active:function(){return active(ui);},promise:null};
      entry.promise=Promise.resolve(ui.request("/api/auth/organization/get-full-organization?organizationId="+encodeURIComponent(key))).then(function(organization){return completeMembers(ui,key,organization);}).then(function(organization){if(active(ui))remember(organization);return organization;}).finally(function(){if(inFlight.get(key)===entry)inFlight.delete(key);});
      inFlight.set(key,entry);
      return entry.promise;
    },
    display:function(organizationId){return displayNames.get(String(organizationId))||null;},
    remember:remember
  };
})(window.RendroUI);
`;
