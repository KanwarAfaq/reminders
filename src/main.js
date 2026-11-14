import { mount, startWatcher } from './features.js';
import { startAutoUpdate } from './update.js';

const $ = s => document.querySelector(s);
const TABS = [
  ['home', '🏠', 'Home'],
  ['reminders', '⏰', 'Reminders'],
  ['work', '📝', 'Work hours'],
  ['settings', '⚙️', 'Settings'],
];
const page = () => (location.hash.match(/^#\/(home|reminders|work|settings)/) || [])[1] || 'home';
const nav = () => `<nav class="dock tabs-nav" aria-label="Navigation">${TABS.map(([id, ic, name]) =>
  `<a class="dk tabn ${page() === id ? 'on' : ''}" href="#/${id}" aria-label="${name}"><span>${ic}</span><small>${name}</small></a>`).join('')}</nav>`;

function render() {
  $('#app').innerHTML = '<div id="view"></div>' + nav();
  mount($('#view'), '#/' + page());
}
addEventListener('hashchange', render);

let deferred = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; window.__install = async () => { deferred.prompt(); await deferred.userChoice; deferred = null; }; });

render(); startWatcher(); startAutoUpdate();
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
