/* =========================================================
   OFF-SCREEN RENDER HOST
   =========================================================
   This document has no tab and no window (chrome.offscreen), so the user
   never sees anything.

   It renders the remote page in a REAL FRAME - an <iframe src="...">. The
   page runs in a genuine browsing context with its own origin, so hydration,
   CMP/consent widgets and lazy-loaded legal text behave exactly as in a tab.
   The frame's content script reports back through the
   READY / EXTRACT / TEXT message protocol, which the service worker drives.

   There is deliberately no srcdoc strategy: a srcdoc document inherits this
   document's CSP (script-src 'self'), so the site's own scripts would be
   blocked and the render would be worth no more than the static HTML we
   already have.

   Protocol:
     worker -> frame : NEXUSKITTY_RENDER_FRAME_EXTRACT {token}
     frame  -> worker: NEXUSKITTY_RENDER_FRAME_READY  {token, href, title}
                       NEXUSKITTY_RENDER_FRAME_TEXT    {token, text, href, title}
   ========================================================= */

const RENDER_HOST_ID = 'nk-render-host';
const FRAME_LOAD_TIMEOUT_MS = 20000;

let currentFrame = null;

function removeCurrentFrame() {
  if (!currentFrame) return;
  try { currentFrame.remove(); } catch (e) {}
  currentFrame = null;
}

function hostElement() {
  return document.getElementById(RENDER_HOST_ID) || document.body;
}

function renderInRealFrame(url, token) {
  removeCurrentFrame();
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.name = `nk-render-${token}`;
  // Chrome only paints a limited region of an off-screen document, so stay
  // inside the default 1280x720 budget: a larger viewport would make lazy
  // content think it is off-screen and never render it.
  frame.style.cssText = 'width:1280px;height:720px;border:0;position:absolute;left:-30000px;top:0;';
  currentFrame = frame;
  hostElement().appendChild(frame);

  // The token also travels in the fragment: window.name is overwritten by a
  // surprising number of sites (analytics, ad tech), which silently broke the
  // READY handshake. The fragment never reaches the server, so the document is
  // the one the URL asked for.
  const target = `${url}${url.includes('#') ? '&' : '#'}__nk_render=${encodeURIComponent(token)}`;
  frame.src = target;

  frame.addEventListener('load', () => {
    // Proves the frame element completed a navigation. Combined with a missing
    // READY this distinguishes "the site refused to be framed" from "the frame
    // loaded but our content script never ran inside it".
    try {
      chrome.runtime.sendMessage({
        type: 'NEXUSKITTY_OFFSCREEN_FRAME_LOADED',
        token,
        src: target,
      });
    } catch (e) {}
  });

  // Safety net: the worker has its own timeouts, this only keeps the document
  // from holding on to a dead frame.
  setTimeout(removeCurrentFrame, FRAME_LOAD_TIMEOUT_MS);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'NEXUSKITTY_OFFSCREEN_RENDER') {
    try {
      renderInRealFrame(message.url, message.token);
      sendResponse({ ok: true, mode: 'frame' });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  }

  return false;
});
