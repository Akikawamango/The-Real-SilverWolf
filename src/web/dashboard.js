import express from 'express';
import crypto from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import {
  ADMIN_PAGE, getLeaderboard, addEntry, updateEntry, removeEntry, sendError,
} from './leaderboard.js';

const SENDABLE_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const MAX_LENGTH = 2000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Dashboard for sending messages as the bot.
 * Disabled unless DASHBOARD_PASSWORD is set.
 */
export function createDashboardRouter(client) {
  const router = express.Router();
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return null;

  const fails = new Map();

  const auth = (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const recent = (fails.get(ip) || []).filter(t => t > now - FAIL_WINDOW_MS);
    if (recent.length >= MAX_FAILS) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !safeEqual(token, password)) {
      recent.push(now);
      fails.set(ip, recent);
      return res.status(401).json({ error: 'Wrong password' });
    }
    next();
  };

  router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(PAGE);
  });

  router.use('/api', express.json({ limit: '16kb' }), auth);

  router.get('/leaderboard', (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(ADMIN_PAGE);
  });

  const lb = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      sendError(res, error);
    }
  };
  lb.get('/', wrap(async () => ({ entries: await getLeaderboard(client.db) })));
  lb.post('/', wrap(async (req) => ({ entry: await addEntry(client.db, req.body || {}) })));
  lb.patch('/:id', wrap(async (req) => ({ entry: await updateEntry(client.db, req.params.id, req.body || {}) })));
  lb.delete('/:id', wrap(async (req) => { await removeEntry(client.db, req.params.id); return { ok: true }; }));
  router.use('/api/leaderboard', lb);

  router.get('/api/channels', (req, res) => {
    const guilds = [...client.guilds.cache.values()].map(guild => {
      const me = guild.members.me;
      const channels = [...guild.channels.cache.values()]
        .filter(c => SENDABLE_TYPES.has(c.type))
        .filter(c => me && c.permissionsFor(me)?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
        ]))
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map(c => ({ id: c.id, name: c.name }));
      return { id: guild.id, name: guild.name, channels };
    });
    res.json({ guilds });
  });

  router.post('/api/send', async (req, res) => {
    const { channelId, content } = req.body || {};
    if (typeof channelId !== 'string' || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'channelId and content are required' });
    }
    if (content.length > MAX_LENGTH) {
      return res.status(400).json({ error: `Message is over ${MAX_LENGTH} characters` });
    }
    try {
      const channel = client.channels.cache.get(channelId);
      if (!channel || !SENDABLE_TYPES.has(channel.type) || !channel.guild) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      const sent = await channel.send({ content, allowedMentions: { parse: [] } });
      logger.info(`Dashboard message sent to #${channel.name} (${channel.guild.name})`);
      res.json({ ok: true, messageId: sent.id });
    } catch (error) {
      logger.error('Dashboard send failed:', error);
      res.status(502).json({ error: error?.message || 'Discord rejected the message' });
    }
  });

  return router;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Dashboard</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:#1e1f22;color:#dbdee1;display:flex;justify-content:center;padding:32px 16px}
main{width:100%;max-width:560px}
h1{font-size:20px;margin:0 0 20px}
label{display:block;font-size:12px;text-transform:uppercase;color:#b5bac1;margin:16px 0 6px}
input,select,textarea,button{width:100%;font:inherit;color:inherit;background:#2b2d31;border:1px solid #3f4147;border-radius:6px;padding:10px}
textarea{min-height:140px;resize:vertical}
button{background:#5865f2;border:0;margin-top:16px;cursor:pointer;font-weight:600}
button:disabled{opacity:.5;cursor:default}
#status{margin-top:12px;min-height:20px;font-size:14px}
.ok{color:#57f287}.err{color:#ed4245}.count{font-size:12px;color:#949ba4;text-align:right}
.hidden{display:none}
</style></head><body><main>
<h1>Send a message as the bot</h1>
<form id="login">
  <label for="pw">Dashboard password</label>
  <input id="pw" type="password" autocomplete="current-password" required>
  <button>Unlock</button>
</form>
<p><a href="/dashboard/leaderboard" style="color:#8ea1e1">Edit leaderboard</a></p>
<form id="send" class="hidden">
  <label for="guild">Server</label><select id="guild"></select>
  <label for="channel">Channel</label><select id="channel"></select>
  <label for="content">Message</label>
  <textarea id="content" maxlength="2000" required></textarea>
  <div class="count"><span id="n">0</span>/2000</div>
  <button id="go">Send</button>
</form>
<div id="status"></div>
<script>
const $=id=>document.getElementById(id);
let token=sessionStorage.getItem('dash')||'', guilds=[];
const say=(t,c)=>{$('status').textContent=t;$('status').className=c||''};
async function api(path,opts={}){
  const r=await fetch('/dashboard/api'+path,{...opts,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||('Error '+r.status));
  return d;
}
function fillChannels(){
  const g=guilds.find(x=>x.id===$('guild').value);
  $('channel').innerHTML='';
  (g?g.channels:[]).forEach(c=>$('channel').add(new Option('#'+c.name,c.id)));
}
async function load(){
  try{
    guilds=(await api('/channels')).guilds;
    $('login').classList.add('hidden');$('send').classList.remove('hidden');
    $('guild').innerHTML='';
    guilds.forEach(g=>$('guild').add(new Option(g.name,g.id)));
    fillChannels();say('');
  }catch(e){sessionStorage.removeItem('dash');token='';say(e.message,'err')}
}
$('login').onsubmit=e=>{e.preventDefault();token=$('pw').value;sessionStorage.setItem('dash',token);load()};
$('guild').onchange=fillChannels;
$('content').oninput=()=>$('n').textContent=$('content').value.length;
$('send').onsubmit=async e=>{
  e.preventDefault();$('go').disabled=true;say('Sending...');
  try{
    await api('/send',{method:'POST',body:JSON.stringify({channelId:$('channel').value,content:$('content').value})});
    $('content').value='';$('n').textContent=0;say('Sent.','ok');
  }catch(err){say(err.message,'err')}
  $('go').disabled=false;
};
if(token) load();
</script></main></body></html>`;
