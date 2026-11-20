// Sends goo (http://127.0.0.1:8068) the odoo.com session cookie, so its backend can
// read task stages (see backend/services/tasks.py) without a separate API key. goo
// keeps the session in memory only (server.ODOO_SESSION) — this extension never
// writes it anywhere itself. It only ever reads the one cookie it needs through the
// browser's own cookies API; it never touches the browser's stored/encrypted data.

const GOO_URL = "http://127.0.0.1:8068/api/odoo-session";
const COOKIE_NAME = "session_id";
const COOKIE_URL = "https://www.odoo.com/";
// a goo restart forgets the session (it is kept in memory only, never written to
// disk) -- resend it on this cadence so goo picks it back up on its own, without
// the user doing anything beyond already having an odoo.com tab open somewhere
const RESEND_MINUTES = 5;

async function sendCurrentSession() {
  const cookie = await chrome.cookies.get({ url: COOKIE_URL, name: COOKIE_NAME });
  if (!cookie) return;
  try {
    await fetch(GOO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: cookie.value }),
    });
  } catch (e) {
    // goo isn't running right now -- the next cookie change or heartbeat retries
  }
}

chrome.cookies.onChanged.addListener((info) => {
  const domain = info.cookie.domain;
  if (info.cookie.name === COOKIE_NAME && (domain === "odoo.com" || domain.endsWith(".odoo.com"))) {
    sendCurrentSession();
  }
});

chrome.runtime.onStartup.addListener(sendCurrentSession);
chrome.runtime.onInstalled.addListener(sendCurrentSession);

chrome.alarms.create("resend-session", { periodInMinutes: RESEND_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "resend-session") sendCurrentSession();
});

sendCurrentSession();
