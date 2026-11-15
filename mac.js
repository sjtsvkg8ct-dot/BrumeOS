// Mac distant : passer sur macOS, sur un Mac mini loué chez Scaleway (ou tout Mac qui partage son écran).
// - Le bureau du Mac s'affiche dans une fenêtre à part (mac/mac.html), avec noVNC : partage d'écran
//   d'Apple (VNC, connexion Apple Remote Desktop par utilisateur et mot de passe).
// - Le réseau passe par ici : la fenêtre ne choisit pas où elle se connecte, elle reçoit et envoie
//   des octets vers le Mac choisi dans Brume (une connexion TCP directe, sans relais).
// - Compte Scaleway relié (clé d'API) : la liste des Mac mini, leur adresse, leur port et leurs
//   identifiants viennent de l'API Apple silicon ; « Redémarrer » passe aussi par elle.
// - Mots de passe et clé d'API sont chiffrés par le système quand il le permet (comme le Courrier).
// - Sur le système Linux, la fenêtre prend tout l'écran ; « Revenir à Brume » la cache sans couper
//   la connexion, pour rebasculer tout de suite.
'use strict';
const tcp = require('net');
const fs = require('fs');
const path = require('path');

const API = process.env.BRUME_SCW_API || 'https://api.scaleway.com';
const ZONES = ['fr-par-1', 'fr-par-3'];   // zones où Scaleway loue des Mac mini
const CONSOLE_URL = 'https://console.scaleway.com/apple-silicon/servers';

function createMac({ app, BrowserWindow, ipcMain, safeStorage, net, clipboard, kiosk, sysEvent, getMain, dir }) {
  const DIR = dir || path.join(app.getPath('userData'), 'mac');
  let win = null, sock = null, cur = null, tcpErr = '', ping = null;
  const alive = () => !!win && !win.isDestroyed();
  const okUser = (u) => typeof u === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(u);
  const err = (code, message) => { const e = new Error(message || code); e.code = code; return e; };
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

  // ---------- Ce qui est gardé, par utilisateur de Brume ----------
  const fileOf = (u) => path.join(DIR, u + '.json');
  function read(u) {
    try { const j = JSON.parse(fs.readFileSync(fileOf(u), 'utf8')); return { macs: Array.isArray(j.macs) ? j.macs : [], scw: j.scw || null, last: j.last || '', ctrlCmd: j.ctrlCmd !== false }; }
    catch (e) { return { macs: [], scw: null, last: '', ctrlCmd: true }; }
  }
  function write(u, data) {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const tmp = fileOf(u) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, fileOf(u));
  }
  function seal(s) {
    try { if (safeStorage && safeStorage.isEncryptionAvailable()) return { enc: 'safe', data: safeStorage.encryptString(String(s)).toString('base64') }; }
    catch (e) { /* brouillage simple */ }
    return { enc: 'plain', data: Buffer.from(String(s), 'utf8').toString('base64') };
  }
  function unseal(p) {
    if (!p || !p.data) return '';
    try { return p.enc === 'safe' ? safeStorage.decryptString(Buffer.from(p.data, 'base64')) : Buffer.from(p.data, 'base64').toString('utf8'); }
    catch (e) { return ''; }
  }
  const pub = (m) => ({ id: m.id, name: m.name, host: m.host, port: m.port, user: m.user, source: m.source || 'manual',
    zone: m.zone || '', status: m.status || '', type: m.type || '', hasPass: !!(m.pass && m.pass.data) });
  const validHost = (h) => /^[A-Za-z0-9.-]{1,253}$/.test(h) || /^\[?[0-9A-Fa-f:.]{2,45}\]?$/.test(h);
  const newId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- API Scaleway (Apple silicon) ----------
  async function api(key, method, p, body) {
    let r;
    try {
      r = await net.fetch(API + p, { method, headers: { 'X-Auth-Token': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw err('net', e.message); }
    const text = await r.text(); let j = null;
    try { j = JSON.parse(text); } catch (e) { /* pas du JSON */ }
    if (!r.ok) throw err(r.status === 401 || r.status === 403 ? 'key' : r.status === 404 ? 'notfound' : 'api', (j && j.message) || ('HTTP ' + r.status));
    return j || {};
  }
  async function listServers(key, project) {
    const out = []; let okZones = 0, last = null;
    for (const z of ZONES) {
      try {
        for (let page = 1; page < 20; page++) {
          const j = await api(key, 'GET', `/apple-silicon/v1alpha1/zones/${z}/servers?page_size=100&page=${page}` + (project ? '&project_id=' + encodeURIComponent(project) : ''));
          okZones++;
          const s = Array.isArray(j.servers) ? j.servers : [];
          s.forEach((x) => out.push(Object.assign({ zone: z }, x)));
          if (s.length < 100) break;
        }
      } catch (e) { last = e; if (e.code === 'key' || e.code === 'net') throw e; }
    }
    if (!okZones) throw last || err('api');
    return out;
  }
  // Un Mac mini de l'API : adresse et identifiants du partage d'écran (vnc_url d'abord, sinon les champs à part)
  function fromServer(x) {
    let host = String(x.ip || ''), port = (x.vnc_port | 0) || 5900, user = String(x.ssh_username || 'm1'), pass = String(x.sudo_password || '');
    try {
      if (x.vnc_url) {
        const u = new URL(String(x.vnc_url));
        if (u.hostname) host = u.hostname.replace(/^\[|\]$/g, '');
        if (u.port) port = +u.port;
        if (u.username) user = decodeURIComponent(u.username);
        if (u.password) pass = decodeURIComponent(u.password);
      }
    } catch (e) { /* adresse illisible : on garde les champs à part */ }
    return { id: 'scw-' + x.id, source: 'scaleway', serverId: String(x.id), zone: x.zone, name: str(x.name, 80) || 'Mac mini',
      host, port, user, pass: pass ? seal(pass) : null, status: String(x.status || ''), type: String(x.type || '') };
  }
  async function syncScaleway(u, data) {
    const key = unseal(data.scw && data.scw.key); if (!key) throw err('key');
    const list = (await listServers(key, data.scw.project || '')).map(fromServer);
    const manual = data.macs.filter((m) => m.source !== 'scaleway');
    data.macs = [...list, ...manual];
    data.scw.synced = Date.now();
    write(u, data);
    return list.length;
  }

  // ---------- Ce que Brume demande ----------
  async function brume(op, a) {
    const u = a.u; if (!okUser(u)) throw err('user');
    const data = read(u);
    const state = () => ({ ok: true, macs: data.macs.map(pub), last: data.last,
      scw: data.scw ? { linked: true, project: data.scw.project || '', synced: data.scw.synced || 0 } : { linked: false },
      session: cur && cur.u === u && alive() ? { id: cur.id, name: cur.name, visible: win.isVisible() && !win.isMinimized() } : null,
      console: CONSOLE_URL });
    if (op === 'state') return state();
    if (op === 'add' || op === 'edit') {
      const host = str(a.host, 253).replace(/^\[|\]$/g, ''), port = a.port | 0, user = str(a.user, 64), name = str(a.name, 80);
      if (!validHost(host)) throw err('host');
      if (port < 1 || port > 65535) throw err('port');
      if (!user) throw err('user-name');
      let m = op === 'edit' ? data.macs.find((x) => x.id === a.id && x.source !== 'scaleway') : null;
      if (op === 'edit' && !m) throw err('mac');
      if (!m) { m = { id: newId(), source: 'manual' }; data.macs.push(m); }
      Object.assign(m, { name: name || host, host, port, user });
      if (typeof a.pass === 'string' && (a.pass || op === 'add')) m.pass = a.pass ? seal(a.pass.slice(0, 200)) : null;
      write(u, data);
      return Object.assign(state(), { id: m.id });
    }
    if (op === 'remove') {
      data.macs = data.macs.filter((x) => x.id !== a.id || x.source === 'scaleway');
      write(u, data);
      if (cur && cur.u === u && cur.id === a.id) close();
      return state();
    }
    if (op === 'link') {
      const key = str(a.key, 200), project = str(a.project, 80);
      if (!key) throw err('key');
      data.scw = { key: seal(key), project };
      try { await syncScaleway(u, data); }
      catch (e) { if (e.code === 'key') { data.scw = null; } throw e; }
      return state();
    }
    if (op === 'refresh') { await syncScaleway(u, data); return state(); }
    if (op === 'unlink') {
      data.scw = null; data.macs = data.macs.filter((x) => x.source !== 'scaleway');
      write(u, data);
      if (cur && cur.u === u && String(cur.id).startsWith('scw-')) close();
      return state();
    }
    if (op === 'reboot') {
      const m = data.macs.find((x) => x.id === a.id && x.source === 'scaleway'); if (!m) throw err('mac');
      const key = unseal(data.scw && data.scw.key); if (!key) throw err('key');
      await api(key, 'POST', `/apple-silicon/v1alpha1/zones/${m.zone}/servers/${encodeURIComponent(m.serverId)}/reboot`, {});
      if (cur && cur.u === u && cur.id === m.id) close();
      m.status = 'rebooting'; write(u, data);
      return state();
    }
    if (op === 'open') {
      const m = data.macs.find((x) => x.id === a.id); if (!m) throw err('mac');
      data.last = m.id; write(u, data);
      open(u, m, a.labels && typeof a.labels === 'object' ? a.labels : {}, data.ctrlCmd);
      return state();
    }
    if (op === 'show') { if (cur && cur.u === u && alive()) { show(); return state(); } throw err('session'); }
    if (op === 'hide') { hide(); return { ok: true }; }
    if (op === 'close') { if (!cur || cur.u === u || a.any) close(); return { ok: true }; }
    throw err('op');
  }
  async function call(op, args) {
    const a = args && typeof args === 'object' ? args : {};
    try {
      if (op === 'hide' && !a.u) { hide(); return { ok: true }; }
      if (op === 'close' && !a.u) { close(); return { ok: true }; }
      return await brume(String(op), a);
    } catch (e) { return { ok: false, error: e.code || 'failed', message: String(e.message || '').slice(0, 200) }; }
  }

  // ---------- La fenêtre du Mac ----------
  function show() {
    if (!alive()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus(); win.webContents.focus();
  }
  function hide() {
    if (!alive()) return;
    if (kiosk) win.hide(); else win.minimize();
    const m = getMain(); if (m) m.focus();
  }
  function close() {
    if (sock) { try { sock.destroy(); } catch (e) { /* déjà fermée */ } sock = null; }
    if (alive()) win.close();
  }
  function open(u, m, labels, ctrlCmd) {
    if (alive() && cur && cur.u === u && cur.id === m.id) { show(); return; }
    if (alive()) { const old = win; close(); if (win === old) { clearInterval(ping); ping = null; win = null; } }
    cur = { u, id: m.id, name: m.name, host: m.host, port: m.port, user: m.user, pass: unseal(m.pass), labels, ctrlCmd };
    const w = win = new BrowserWindow({
      width: 1280, height: 840, minWidth: 640, minHeight: 420,
      title: m.name, backgroundColor: '#101216',
      fullscreen: kiosk, frame: !kiosk, autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'mac', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
    });
    if (typeof win.setMenu === 'function') win.setMenu(null);
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    // Travailler sur le Mac compte comme une activité : Brume ne se verrouille pas pendant ce temps
    let last = 0;
    wc.on('input-event', () => { const now = Date.now(); if (now - last > 4000) { last = now; sysEvent({ type: 'activity' }); } });
    ping = setInterval(() => { if (alive() && win.isVisible() && !win.isMinimized() && win.isFocused()) sysEvent({ type: 'activity' }); }, 30000);
    w.on('closed', () => {
      if (win !== w) return;   // une autre fenêtre a déjà pris la place
      clearInterval(ping); ping = null;
      if (sock) { try { sock.destroy(); } catch (e) { /* déjà fermée */ } sock = null; }
      win = null; cur = null;
      const mw = getMain(); if (mw) mw.focus();
    });
    win.once('ready-to-show', () => { if (alive()) { win.show(); win.focus(); } });
    win.loadFile(path.join(__dirname, 'mac', 'mac.html'));
  }
  const fromMac = (e) => alive() && e.sender === win.webContents;
  const send = (type, data) => { if (alive() && !win.webContents.isDestroyed()) win.webContents.send('mac:evt', type, data); };

  ipcMain.handle('mac:init', (e) => {
    if (!fromMac(e) || !cur) return null;
    return { name: cur.name, host: cur.host, port: cur.port, user: cur.user, pass: cur.pass, labels: cur.labels, kiosk: !!kiosk, ctrlCmd: cur.ctrlCmd !== false };
  });
  // Connexion TCP vers le Mac choisi dans Brume (jamais vers une adresse donnée par la fenêtre)
  ipcMain.handle('mac:connect', (e) => {
    if (!fromMac(e) || !cur) return { ok: false };
    if (sock) { try { sock.destroy(); } catch (x) { /* déjà fermée */ } }
    tcpErr = '';
    const s = tcp.connect({ host: cur.host, port: cur.port });
    sock = s;
    s.setNoDelay(true);
    s.setTimeout(15000, () => { if (!s.connecting) return; tcpErr = 'ETIMEDOUT'; s.destroy(); });
    s.on('connect', () => { s.setTimeout(0); if (sock === s) send('open'); });
    s.on('data', (b) => { if (sock === s) send('data', b); });
    s.on('error', (x) => { tcpErr = x.code || 'ERROR'; });
    s.on('close', () => { if (sock === s) { sock = null; send('close', { error: tcpErr }); } });
    return { ok: true };
  });
  ipcMain.on('mac:send', (e, data) => {
    if (!fromMac(e) || !sock || sock.destroyed || !(data instanceof Uint8Array)) return;
    sock.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });
  ipcMain.on('mac:disconnect', (e) => { if (fromMac(e) && sock) { try { sock.end(); sock.destroy(); } catch (x) { /* déjà fermée */ } } });
  ipcMain.on('mac:action', (e, a) => {
    if (!fromMac(e)) return;
    if (a === 'back') hide();
    else if (a === 'close') close();
    else if (a === 'fullscreen' && !kiosk) win.setFullScreen(!win.isFullScreen());
  });
  ipcMain.on('mac:pref', (e, p) => {
    if (!fromMac(e) || !cur || !p || typeof p !== 'object') return;
    const data = read(cur.u); data.ctrlCmd = !!p.ctrlCmd; cur.ctrlCmd = data.ctrlCmd; write(cur.u, data);
  });
  // (selon la version d'Electron, readText rend le texte ou une promesse)
  ipcMain.handle('mac:clip-read', async (e) => (fromMac(e) && clipboard ? String((await clipboard.readText()) || '').slice(0, 1000000) : ''));
  ipcMain.on('mac:clip-write', (e, t) => { if (fromMac(e) && clipboard && typeof t === 'string') clipboard.writeText(t.slice(0, 1000000)); });

  return { call, hide, close, CONSOLE_URL };
}

module.exports = { createMac, ZONES };
