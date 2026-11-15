// Fenêtre du Mac : le bureau macOS avec noVNC (partage d'écran d'Apple, connexion Apple Remote Desktop).
// Les octets passent par le processus principal (window.brumeMac) : un « canal » que noVNC prend
// pour un WebSocket. Les textes viennent de Brume, déjà traduits.
import { RFB, KeyTable as XK } from './novnc.js';

const M = window.brumeMac;
const $ = (id) => document.getElementById(id);
const body = document.body;

const DEF = {
  back: 'Revenir à Brume', ctrl: 'Ctrl = ⌘', ctrlTip: 'La touche Ctrl sert de touche Commande (⌘) du Mac, et Alt de Ctrl. Cliquez pour garder les touches telles quelles.',
  fullscreen: 'Plein écran', disconnect: 'Déconnecter', user: 'Utilisateur', password: 'Mot de passe', signin: 'Se connecter',
  close: 'Fermer', retry: 'Réessayer', connecting: 'Connexion à {name}…', connected: 'Connecté', waiting: 'Connexion…', stopped: 'Déconnecté',
  refused: 'Le Mac refuse la connexion sur ce port. Vérifiez le port du partage d’écran dans la console Scaleway.',
  timeout: 'Le Mac ne répond pas : il est peut-être éteint ou en train de redémarrer.',
  notfound: 'Adresse introuvable. Vérifiez l’adresse IP du Mac.',
  unreach: 'Le Mac est injoignable. Vérifiez votre connexion à Internet.',
  auth: 'Utilisateur ou mot de passe refusé par le Mac.',
  lost: 'La connexion au Mac a été coupée.', closed: 'Vous êtes déconnecté du Mac.', failed: 'Connexion impossible.',
  login: 'Identifiants du Mac « {name} »', hint: 'Ctrl+Alt+B : revenir à Brume', screen: 'Bureau du Mac'
};
let L = DEF, info = null;
const fmt = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m));

let rfb = null, ch = null, tcpErr = '', authFailed = false, wasConnected = false, ctrlCmd = true, lastClip = '', barTimer = 0;

function setState(st, text, err) {
  body.dataset.state = st === 'connected' ? 'connected' : err ? 'error' : 'busy';
  $('state').textContent = st === 'connected' ? L.connected : st === 'connecting' ? L.waiting : L.stopped;
  $('spin').hidden = st !== 'connecting';
  $('msg').textContent = text || '';
  $('acts').hidden = st === 'connecting' || st === 'connected' || st === 'login';
  $('login').hidden = st !== 'login';
  if (st !== 'connected') showBar(true);
}

// Le canal : ce que noVNC attend d'un WebSocket (send, close, readyState, onopen, onmessage…)
class Channel {
  constructor() {
    this.binaryType = 'arraybuffer'; this.protocol = ''; this.readyState = 'connecting';
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
  }
  send(d) {
    if (this.readyState !== 'open') return;
    const u8 = d instanceof Uint8Array ? d : new Uint8Array(d);
    M.send(u8.slice());   // copie : seulement les octets à envoyer
  }
  close() {
    if (this.readyState === 'closed' || this.readyState === 'closing') return;
    this.readyState = 'closing'; M.disconnect();
  }
}
M.on((type, data) => {
  const c = ch; if (!c) return;
  if (type === 'open') { c.readyState = 'open'; if (c.onopen) c.onopen(); }
  else if (type === 'data' && data) {
    const u = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (c.onmessage) c.onmessage({ data: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) });
  } else if (type === 'close') {
    tcpErr = (data && data.error) || '';
    c.readyState = 'closed';
    if (c.onclose) c.onclose({ code: tcpErr ? 1006 : 1000, reason: tcpErr, wasClean: !tcpErr });
  }
});

function errText() {
  if (/ECONNREFUSED/.test(tcpErr)) return L.refused;
  if (/ETIMEDOUT/.test(tcpErr)) return L.timeout;
  if (/ENOTFOUND|EAI_AGAIN/.test(tcpErr)) return L.notfound;
  if (/ENETUNREACH|EHOSTUNREACH|ENETDOWN/.test(tcpErr)) return L.unreach;
  return wasConnected ? L.lost : L.failed;
}

// Ctrl = ⌘ : la touche Ctrl du PC envoie Commande (Alt_L pour les serveurs VNC du Mac), Alt gauche envoie Ctrl
function wrapKeys(r) {
  const kb = r._keyboard; if (!kb || typeof kb.onkeyevent !== 'function') return;
  const orig = kb.onkeyevent;
  kb.onkeyevent = (keysym, code, down, numlock, capslock) => {
    if (ctrlCmd) {
      if (keysym === XK.XK_Control_L || keysym === XK.XK_Control_R) keysym = XK.XK_Alt_L;
      else if (keysym === XK.XK_Alt_L) keysym = XK.XK_Control_L;
    }
    return orig(keysym, code, down, numlock, capslock);
  };
}

function connect(creds) {
  if (rfb) { try { rfb.disconnect(); } catch (e) { /* déjà fermé */ } rfb = null; }
  $('screen').textContent = '';
  ch = new Channel(); tcpErr = ''; authFailed = false; wasConnected = false;
  setState('connecting', fmt(L.connecting, { name: info.name }));
  const r = rfb = new RFB($('screen'), ch, { credentials: creds || { username: info.user, password: info.pass || undefined }, shared: true });
  r.scaleViewport = true; r.resizeSession = false; r.qualityLevel = 6; r.compressionLevel = 2; r.focusOnClick = true;
  r.background = '#101216';
  wrapKeys(r);
  r.addEventListener('connect', () => {
    if (r !== rfb) return;
    wasConnected = true; setState('connected'); showBar(true); r.focus(); syncClip();   // la barre se montre un instant, puis se cache
  });
  r.addEventListener('disconnect', (e) => {
    if (r !== rfb) return;
    if (authFailed) return;
    if (e.detail && e.detail.clean && !tcpErr && wasConnected) setState('closed', L.closed);
    else setState('error', errText(), true);
  });
  r.addEventListener('securityfailure', () => { if (r === rfb) { authFailed = true; setState('error', L.auth, true); } });
  r.addEventListener('credentialsrequired', () => {
    if (r !== rfb) return;
    setState('login', fmt(L.login, { name: info.name }));
    $('lu').value = info.user || ''; setTimeout(() => ($('lu').value ? $('lp') : $('lu')).focus(), 30);
  });
  r.addEventListener('clipboard', (e) => { const t = e.detail && e.detail.text; if (typeof t === 'string') { lastClip = t; M.clipWrite(t); } });
  M.connect();
}
$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  const creds = { username: $('lu').value.trim(), password: $('lp').value };
  $('lp').value = '';
  if (rfb) { setState('connecting', fmt(L.connecting, { name: info.name })); rfb.sendCredentials(creds); }
});

// Presse-papiers : ce que vous copiez dans Brume part vers le Mac quand vous revenez sur sa fenêtre
async function syncClip() {
  if (!rfb || body.dataset.state !== 'connected') return;
  try { const t = await M.clipRead(); if (t && t !== lastClip) { lastClip = t; rfb.clipboardPasteFrom(t); } } catch (e) { /* rien à coller */ }
}
window.addEventListener('focus', () => { syncClip(); if (rfb && body.dataset.state === 'connected') rfb.focus(); });

// La barre : toujours là dans une fenêtre ; en plein écran (et sur le système Linux), elle se cache
function showBar(on) {
  clearTimeout(barTimer);
  body.classList.toggle('bar-on', !!on);
  if (on && body.classList.contains('over') && body.dataset.state === 'connected') barTimer = setTimeout(() => { if (!$('bar').matches(':hover')) body.classList.remove('bar-on'); }, 2500);
}
document.addEventListener('mousemove', (e) => { if (body.classList.contains('over') && e.clientY <= 3) showBar(true); }, true);
$('bar').addEventListener('mouseleave', () => { if (body.classList.contains('over')) showBar(true); });
const back = () => { if (rfb) try { rfb.blur(); } catch (e) { /* rien */ } M.action('back'); };
$('back').addEventListener('click', back);
$('quit').addEventListener('click', () => { if (rfb) try { rfb.disconnect(); } catch (e) { /* rien */ } M.action('close'); });
$('close2').addEventListener('click', () => M.action('close'));
$('retry').addEventListener('click', () => connect());
$('ctrl').addEventListener('click', () => {
  ctrlCmd = !ctrlCmd; $('ctrl').setAttribute('aria-pressed', String(ctrlCmd)); M.pref({ ctrlCmd });
  if (rfb && body.dataset.state === 'connected') rfb.focus();
});
$('fs').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await document.documentElement.requestFullscreen();
    // Le clavier entier va au Mac (Alt+Tab, touche Windows…) ; un appui long sur Échap quitte le plein écran
    if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {});
  } catch (e) { M.action('fullscreen'); }
});
document.addEventListener('fullscreenchange', () => {
  body.classList.toggle('over', !!document.fullscreenElement || !!(info && info.kiosk));
  if (!document.fullscreenElement && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  showBar(!document.fullscreenElement);
});
// Ctrl+Alt+B : revenir à Brume (avant que le Mac ne voie les touches)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === 'KeyB') { e.preventDefault(); e.stopImmediatePropagation(); back(); }
}, true);

// Démarrage
info = await M.init();
if (!info) {
  setState('error', DEF.failed, true);
} else {
  L = Object.assign({}, DEF, info.labels || {});
  document.documentElement.lang = String(L.lang || 'fr');
  document.querySelectorAll('[data-l]').forEach((el) => { const k = el.dataset.l; if (L[k]) el.textContent = L[k]; });
  $('ctrl').title = L.ctrlTip; $('back').title = L.hint; $('screen').setAttribute('aria-label', L.screen);
  $('name').textContent = info.name; document.title = info.name;
  // Sur un Mac, la touche ⌘ est déjà Commande : pas d'échange Ctrl/⌘
  const hostMac = /Mac/i.test(navigator.platform || '');
  ctrlCmd = !hostMac && info.ctrlCmd !== false; $('ctrl').setAttribute('aria-pressed', String(ctrlCmd)); $('ctrl').hidden = hostMac;
  body.classList.toggle('kiosk', !!info.kiosk); body.classList.toggle('over', !!info.kiosk);
  connect();
}
