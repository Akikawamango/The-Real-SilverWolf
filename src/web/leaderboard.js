import crypto from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const KEY = 'roblox:leaderboard';
const MAX_ENTRIES = 200;
const MAX_POSTED = 30;

let queue = Promise.resolve();
const serialize = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

// The stored array order is the ranking. Older entries had a numeric score:
// sort those once by score so existing rankings carry over, then drop the field.
const load = async (db) => {
  const list = await db.get(KEY, []);
  if (!Array.isArray(list)) return [];
  if (list.some(e => 'score' in e)) {
    list.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    for (const e of list) delete e.score;
  }
  return list;
};

const publicEntry = ({ id, username, displayName, robloxId, avatarUrl }) =>
  ({ id, username, displayName, robloxId, avatarUrl });

export async function getLeaderboard(db) {
  return (await load(db)).map(publicEntry);
}

async function lookupRobloxUser(username) {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('Roblox lookup failed, try again');
  const user = (await res.json()).data?.[0];
  if (!user) return null;

  let avatarUrl = null;
  try {
    const t = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${user.id}&size=150x150&format=Png`,
      { signal: AbortSignal.timeout(8000) },
    );
    avatarUrl = (await t.json()).data?.[0]?.imageUrl || null;
  } catch (error) {
    logger.warn('Roblox avatar lookup failed:', error);
  }
  return { robloxId: user.id, username: user.name, displayName: user.displayName, avatarUrl };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function addEntry(db, { username }) {
  return serialize(async () => {
    const name = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new HttpError(400, 'Enter a valid Roblox username');

    const list = await load(db);
    if (list.length >= MAX_ENTRIES) throw new HttpError(400, `Leaderboard is full (${MAX_ENTRIES})`);

    const user = await lookupRobloxUser(name);
    if (!user) throw new HttpError(404, `No Roblox user named "${name}"`);
    if (list.some(e => e.robloxId === user.robloxId)) {
      throw new HttpError(409, `${user.username} is already on the leaderboard`);
    }

    const entry = { id: crypto.randomUUID(), ...user };
    if (!(await db.set(KEY, [...list, entry]))) throw new HttpError(503, 'Database unavailable');
    return publicEntry(entry);
  });
}

export function reorderEntries(db, ids) {
  return serialize(async () => {
    const list = await load(db);
    if (!Array.isArray(ids) || ids.length !== list.length || new Set(ids).size !== ids.length) {
      throw new HttpError(409, 'The list changed. Reload the page and try again.');
    }
    const byId = new Map(list.map(e => [e.id, e]));
    if (!ids.every(id => byId.has(id))) {
      throw new HttpError(409, 'The list changed. Reload the page and try again.');
    }
    const next = ids.map(id => byId.get(id));
    if (!(await db.set(KEY, next))) throw new HttpError(503, 'Database unavailable');
    return next.map(publicEntry);
  });
}

export function removeEntry(db, id) {
  return serialize(async () => {
    const list = await load(db);
    const next = list.filter(e => e.id !== id);
    if (next.length === list.length) throw new HttpError(404, 'Entry not found');
    if (!(await db.set(KEY, next))) throw new HttpError(503, 'Database unavailable');
  });
}

async function freshAvatars(entries) {
  const urls = new Map();
  try {
    const ids = entries.map(e => e.robloxId).join(',');
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids}&size=150x150&format=Png`,
      { signal: AbortSignal.timeout(8000) },
    );
    for (const t of (await res.json()).data || []) {
      if (t.imageUrl) urls.set(t.targetId, t.imageUrl);
    }
  } catch (error) {
    logger.warn('Roblox avatar refresh failed, using saved avatars:', error);
  }
  return urls;
}

/**
 * One embed per player (Discord allows one thumbnail per embed), 10 embeds per message.
 * Returns { header, batches } where each batch is the embeds for one message.
 */
export async function buildLeaderboardMessages(db) {
  const all = await getLeaderboard(db);
  if (!all.length) throw new HttpError(400, 'The leaderboard is empty');
  const top = all.slice(0, MAX_POSTED);
  const avatars = await freshAvatars(top);
  const medals = ['🥇', '🥈', '🥉'];
  const colors = [0xf0b232, 0xc0c4cc, 0xcd7f32];
  const esc = (t) => String(t).replace(/_/g, '\\_');

  const embeds = top.map((e, i) => {
    const embed = new EmbedBuilder()
      .setColor(colors[i] ?? 0x5865f2)
      .setDescription(`${medals[i] || `**#${i + 1}**`}  **${esc(e.displayName)}**\n@${esc(e.username)}`);
    const img = avatars.get(e.robloxId) || e.avatarUrl;
    if (img) embed.setThumbnail(img);
    return embed;
  });

  const batches = [];
  for (let i = 0; i < embeds.length; i += 10) batches.push(embeds.slice(i, i + 10));
  const footer = all.length > top.length ? `\n*Showing the top ${top.length} of ${all.length}*` : '';
  return { header: '## Leaderboard' + footer, batches };
}

export const sendError = (res, error) => {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  logger.error('Leaderboard error:', error);
  return res.status(500).json({ error: error?.message || 'Something went wrong' });
};

const CSS = `*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:#1e1f22;color:#dbdee1;display:flex;justify-content:center;padding:32px 16px}
main{width:100%;max-width:560px}
h1{font-size:20px;margin:0 0 20px}
a{color:#8ea1e1}
input,select,button{font:inherit;color:inherit;background:#2b2d31;border:1px solid #3f4147;border-radius:6px;padding:8px 10px}
button{background:#5865f2;border:0;cursor:pointer;font-weight:600}
button.del{background:#da373c}
button:disabled{opacity:.5}
ol{list-style:none;margin:20px 0 0;padding:0}
li{display:flex;align-items:center;gap:12px;background:#2b2d31;border-radius:8px;padding:10px 12px;margin-bottom:8px}
.rank{width:28px;text-align:center;font-weight:700;color:#949ba4}
li:nth-child(1) .rank{color:#f0b232}li:nth-child(2) .rank{color:#c0c4cc}li:nth-child(3) .rank{color:#cd7f32}
img,.ph{width:40px;height:40px;border-radius:50%;background:#3f4147;flex:none}
.who{flex:1;min-width:0}.who b{display:block;overflow:hidden;text-overflow:ellipsis}.who small{color:#949ba4}
.row{display:flex;gap:8px}.row input{flex:1;min-width:0}
select{flex:1;min-width:0;font:inherit;color:inherit;background:#2b2d31;border:1px solid #3f4147;border-radius:6px;padding:8px 10px}
li button.up,li button.down{background:#3f4147;padding:6px 9px}
li[draggable=true]{cursor:grab}li.drag{opacity:.4}li.over{outline:2px solid #5865f2}
#status{margin-top:12px;min-height:20px;font-size:14px}.ok{color:#57f287}.err{color:#ed4245}.empty{color:#949ba4;margin-top:20px}
.hidden{display:none}`;

const RENDER = `
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeImg=u=>/^https:\\/\\/[a-z0-9.-]+\\.rbxcdn\\.com\\//.test(u||'')?u:'';
function row(e,i,edit){
  const img=safeImg(e.avatarUrl);
  return '<li '+(edit?'draggable="true" ':'')+'data-id="'+esc(e.id)+'"><span class="rank">'+(i+1)+'</span>'
   +(img?'<img src="'+esc(img)+'" alt="">':'<span class="ph"></span>')
   +'<span class="who"><b>'+esc(e.displayName)+'</b><small>@'+esc(e.username)+'</small></span>'
   +(edit?'<button class="up" title="Move up">&#9650;</button><button class="down" title="Move down">&#9660;</button><button class="del">Remove</button>':'')+'</li>';
}`;

export const PUBLIC_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Leaderboard</title>
<style>${CSS}</style></head><body><main><h1>Leaderboard</h1><ol id="list"></ol><div id="empty" class="empty hidden">No one on the leaderboard yet.</div>
<script>${RENDER}
fetch('/leaderboard/data').then(r=>r.json()).then(d=>{
  document.getElementById('list').innerHTML=d.entries.map((e,i)=>row(e,i,false)).join('');
  if(!d.entries.length)document.getElementById('empty').classList.remove('hidden');
});
</script></main></body></html>`;

export const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Edit leaderboard</title>
<style>${CSS}</style></head><body><main>
<h1>Edit leaderboard</h1>
<p style="color:#949ba4;font-size:14px">Drag players, or use the arrows, to set their spot. Top is #1.</p>
<p><a href="/dashboard">Send messages</a> · <a href="/leaderboard">Public view</a></p>
<form id="login"><div class="row"><input id="pw" type="password" placeholder="Dashboard password" required><button>Unlock</button></div></form>
<form id="add" class="row hidden"><input id="u" placeholder="Roblox username" required maxlength="20"><button id="addbtn">Add</button></form>
<form id="post" class="row hidden" style="margin-top:12px"><select id="guild"></select><select id="channel"></select><button id="postbtn">Post to Discord</button></form>
<ol id="list"></ol><div id="status"></div>
<script>${RENDER}
const $=id=>document.getElementById(id);
let token=sessionStorage.getItem('dash')||'';
const say=(t,c)=>{$('status').textContent=t;$('status').className=c||''};
async function api(path,opts={}){
  const r=await fetch('/dashboard/api/leaderboard'+path,{...opts,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||('Error '+r.status));
  return d;
}
let guilds=[];
function fillChannels(){
  const g=guilds.find(x=>x.id===$('guild').value);
  $('channel').innerHTML='';
  (g?g.channels:[]).forEach(c=>$('channel').add(new Option('#'+c.name,c.id)));
}
async function loadChannels(){
  const r=await fetch('/dashboard/api/channels',{headers:{Authorization:'Bearer '+token}});
  if(!r.ok)return;
  guilds=(await r.json()).guilds;
  $('guild').innerHTML='';
  guilds.forEach(g=>$('guild').add(new Option(g.name,g.id)));
  fillChannels();
}
async function load(){
  try{
    const d=await api('');
    $('login').classList.add('hidden');$('add').classList.remove('hidden');$('post').classList.remove('hidden');
    if(!guilds.length)await loadChannels();
    $('list').innerHTML=d.entries.map((e,i)=>row(e,i,true)).join('');
    if(!d.entries.length)say('No one yet. Add a Roblox username above.');
  }catch(e){sessionStorage.removeItem('dash');token='';say(e.message,'err')}
}
$('login').onsubmit=e=>{e.preventDefault();token=$('pw').value;sessionStorage.setItem('dash',token);load()};
$('guild').onchange=fillChannels;
$('post').onsubmit=async e=>{
  e.preventDefault();$('postbtn').disabled=true;say('Posting...');
  try{await api('/post',{method:'POST',body:JSON.stringify({channelId:$('channel').value})});say('Posted to Discord.','ok')}
  catch(err){say(err.message,'err')}
  $('postbtn').disabled=false;
};
$('add').onsubmit=async e=>{
  e.preventDefault();$('addbtn').disabled=true;say('Looking up Roblox user...');
  try{await api('',{method:'POST',body:JSON.stringify({username:$('u').value})});
    $('u').value='';await load();say('Added.','ok')}catch(err){say(err.message,'err')}
  $('addbtn').disabled=false;
};
let busy=false;
async function saveOrder(){
  const ids=[...$('list').children].map(li=>li.dataset.id);
  try{await api('/order',{method:'PUT',body:JSON.stringify({ids})});await load();say('Order saved.','ok')}
  catch(err){say(err.message,'err');await load()}
}
$('list').onclick=async e=>{
  const li=e.target.closest('li');if(!li||busy)return;
  const c=e.target.classList;
  try{
    if(c.contains('up')&&li.previousElementSibling){li.parentNode.insertBefore(li,li.previousElementSibling);await saveOrder()}
    else if(c.contains('down')&&li.nextElementSibling){li.parentNode.insertBefore(li.nextElementSibling,li);await saveOrder()}
    else if(c.contains('del')){
      if(!confirm('Remove this player?'))return;
      await api('/'+encodeURIComponent(li.dataset.id),{method:'DELETE'});await load();say('Removed.','ok');
    }
  }catch(err){say(err.message,'err')}
};
let dragged=null;
$('list').ondragstart=e=>{dragged=e.target.closest('li');if(dragged){dragged.classList.add('drag');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','')}};
$('list').ondragover=e=>{
  if(!dragged)return;e.preventDefault();
  const over=e.target.closest('li');
  [...$('list').children].forEach(x=>x.classList.remove('over'));
  if(over&&over!==dragged)over.classList.add('over');
};
$('list').ondrop=async e=>{
  e.preventDefault();
  const over=e.target.closest('li');
  if(dragged&&over&&over!==dragged){
    const kids=[...$('list').children];
    over.parentNode.insertBefore(dragged,kids.indexOf(dragged)<kids.indexOf(over)?over.nextSibling:over);
    dragged=null;await saveOrder();
  }
};
$('list').ondragend=()=>{dragged=null;[...$('list').children].forEach(x=>x.classList.remove('drag','over'))};
if(token)load();
</script></main></body></html>`;
