import { mount, startWatcher } from './features.js';

const $ = s => document.querySelector(s);
const TABS = [
  ['reminders', '⏰', 'Reminders'],
  ['work', '📝', 'Work hours'],
  ['settings', '⚙️', 'Settings'],
];
const page = () => (location.hash.match(/^#\/(reminders|work|settings)/) || [])[1] || 'reminders';
const nav = () => `<nav class="dock tabs-nav" aria-label="Navigation">${TABS.map(([id, ic, name]) =>
  `<a class="dk tabn ${page() === id ? 'on' : ''}" href="#/${id}" aria-label="${name}"><span>${ic}</span><small>${name}</small></a>`).join('')}</nav>`;

function render() {
  $('#app').innerHTML = '<div id="view"></div>' + nav();
  mount($('#view'), '#/' + page());
}
addEventListener('hashchange', render);

let deferred = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; window.__install = async () => { deferred.prompt(); await deferred.userChoice; deferred = null; }; });

render(); startWatcher();
if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform?.()) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
