export const OPENCODE_SERVER_STATE_KEY = 'opencode.global.dat:server';

/**
 * Runs before the OpenCode app bundle. The new web UI only considers projects
 * recorded in its persisted server state when it creates a draft. Registering
 * the directory from the legacy /:dir/session route restores the old behavior
 * for workspaces that have never been opened in OpenCode before.
 */
export const OPENCODE_PROJECT_BOOTSTRAP_SCRIPT = `<script>
(function(){
  if(window.__ocWebSidebarProjectBootstrap)return;
  window.__ocWebSidebarProjectBootstrap=true;

  function decodeRouteSegment(value){
    try{
      var base64=value.replace(/-/g,'+').replace(/_/g,'/');
      while(base64.length%4)base64+='=';
      var binary=atob(base64);
      var bytes=new Uint8Array(binary.length);
      for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }catch(e){
      return '';
    }
  }

  function pathKey(value){
    var normalized=(value.length>1&&value[1]===':')||value.indexOf('\\\\\\\\')===0
      ? value.replace(/\\\\/g,'/')
      : value;
    if(normalized==='/')return normalized;
    return normalized.replace(/\\/+$/,'');
  }

  try{
    var match=/^\\/([^/]+)\\/session\\/?$/.exec(window.location.pathname);
    if(!match)return;
    var directory=decodeRouteSegment(match[1]);
    if(!directory)return;

    var storageKey=${JSON.stringify(OPENCODE_SERVER_STATE_KEY)};
    var raw=window.localStorage.getItem(storageKey);
    var state={};
    if(raw){
      try{
        var parsed=JSON.parse(raw);
        if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))state=parsed;
      }catch(e){}
    }

    if(!state.projects||typeof state.projects!=='object'||Array.isArray(state.projects)){
      state.projects={};
    }
    var projects=Array.isArray(state.projects.local)?state.projects.local:[];
    var key=pathKey(directory);
    var exists=projects.some(function(project){
      return project&&typeof project.worktree==='string'&&pathKey(project.worktree)===key;
    });
    if(!exists){
      state.projects.local=[{worktree:directory,expanded:true}].concat(projects);
    }else{
      state.projects.local=projects;
    }

    if(!state.lastProject||typeof state.lastProject!=='object'||Array.isArray(state.lastProject)){
      state.lastProject={};
    }
    state.lastProject.local=directory;

    if(state.recentlyClosed&&typeof state.recentlyClosed==='object'&&!Array.isArray(state.recentlyClosed)){
      var closed=state.recentlyClosed.local;
      if(Array.isArray(closed)){
        state.recentlyClosed.local=closed.filter(function(worktree){
          return typeof worktree!=='string'||pathKey(worktree)!==key;
        });
      }
    }

    window.localStorage.setItem(storageKey,JSON.stringify(state));
  }catch(e){}
})();
</script>`;

/** V2.0.x web persistence contract, verified against OpenCode v2.0.31.
 * Runs before the app: register the project and a real DraftTab, then select its
 * supported route. Existing tabs and draft contents are preserved.
 */
export const OPENCODE_V2_BOOTSTRAP_SCRIPT = `<script>
(function(){
  var url=new URL(window.location.href);
  if(!url.searchParams.has('_ocWorkspace')&&!url.searchParams.has('_ocRestore'))return;
  var directory=url.searchParams.get('_ocWorkspace')||'';
  var restore=url.searchParams.get('_ocRestore')||'';
  var target='/';
  function read(key,fallback){
    var raw=localStorage.getItem(key);
    return raw?JSON.parse(raw):fallback;
  }
  function encode(value){
    var bytes=new TextEncoder().encode(value),binary='';
    for(var i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  }
  try{
    var origin=url.origin;
    var state=read('opencode.global.dat:server',{});
    if(!state||typeof state!=='object'||Array.isArray(state))throw new Error('Invalid server state');
    if(directory){
      state.projects=state.projects||{};
      var projects=state.projects.local||[];
      if(!projects.some(function(p){return p.worktree===directory})){
        state.projects.local=[{worktree:directory,expanded:true}].concat(projects);
      }
      state.lastProject=state.lastProject||{};
      state.lastProject.local=directory;
      if(state.recentlyClosed&&Array.isArray(state.recentlyClosed.local)){
        state.recentlyClosed.local=state.recentlyClosed.local.filter(function(p){return p!==directory});
      }
      localStorage.setItem('opencode.global.dat:server',JSON.stringify(state));
    }
    var tabs=read('opencode.window.browser.dat:tabs',[]);
    if(!Array.isArray(tabs))throw new Error('Invalid tabs');
    var session=/^\\/server\\/([^/]+)\\/session\\/([^/?#]+)(?:[?#].*)?$/.exec(restore);
    if(session&&session[1]===encode(origin)){
      target=restore;
      if(!tabs.some(function(t){return t.type==='session'&&t.server===origin&&(t.sessionId===session[2]||t.routeSessionId===session[2])})){
        tabs.push({type:'session',server:origin,sessionId:session[2]});
      }
    }else if(directory&&(!restore||restore.indexOf('/new-session?')===0)){
      var draftID=new URL(restore||'/new-session',origin).searchParams.get('draftId')||crypto.randomUUID();
      if(!tabs.some(function(t){return t.type==='draft'&&t.draftID===draftID})){
        tabs.push({type:'draft',draftID:draftID,server:origin,directory:directory});
      }
      target='/new-session?draftId='+encodeURIComponent(draftID);
    }else if(restore==='/'||restore==='/settings'){
      target=restore;
    }
    localStorage.setItem('opencode.window.browser.dat:tabs',JSON.stringify(tabs));
  }catch(e){
    // Storage unavailable or an unsupported state: let the official home load.
    target='/';
  }
  history.replaceState(null,'',target);
})();
</script>`;
