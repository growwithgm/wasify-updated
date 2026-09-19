/*
 * Wasify WhatsApp popup — storefront runtime.
 *
 * Order of operations, and why:
 *   1. localStorage gates first: subscribed = nothing, ever. Dismissed =
 *      the POPUP stays hidden until the stamped date, but the TEASER tab
 *      may still render (its config says so) — so the visitor can reopen
 *      it themselves without being re-imposed on.
 *   2. Shopify Customer Privacy check — the popup IS marketing, so in
 *      consent regions nothing runs (not even the config call) until
 *      marketing is allowed. If consent arrives later, we retry once.
 *   3. Config from the App Proxy. Page/device/logged-in-customer targeting
 *      was decided on the SERVER: show:false means neither popup nor teaser
 *      exists on this page — no flash.
 *   4. Triggers: independent conditions (exit / delay / scroll) that can be
 *      armed together — OR by default, AND when triggers.all is set. This
 *      mirrors triggerSatisfied() in the app's popup engine.
 *   5. Render. All content comes from config as textContent — nothing is
 *      hardcoded here, empty fields simply don't render.
 */
(function () {
  'use strict';

  var root = document.getElementById('wasify-popup-root');
  if (!root) return;

  var PROXY = (root.getAttribute('data-proxy') || '/apps/wasify').replace(/\/+$/, '');
  var COUNTRY = root.getAttribute('data-country') || 'ES';
  var LOCALE = root.getAttribute('data-locale') || 'en';
  var KEY_DONE = 'wasify_popup_done';
  var KEY_HIDE = 'wasify_popup_hide_until';

  /* ---- 1: local gates (never throw in private windows) ---- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  if (lsGet(KEY_DONE)) return;
  var dismissed = Date.now() < (parseInt(lsGet(KEY_HIDE) || '0', 10) || 0);

  /* ---- 2: customer privacy ---- */
  var retried = false;
  function whenMarketingAllowed(next) {
    var cp = window.Shopify && window.Shopify.customerPrivacy;
    if (!cp) return next(); // no privacy API on this shop → no restriction configured

    var allowed = false;
    try {
      if (typeof cp.firstPartyMarketingAllowed === 'function') {
        // Region-aware: true where no regulation applies, and true after
        // consent where one does.
        allowed = cp.firstPartyMarketingAllowed();
      } else if (typeof cp.currentVisitorConsent === 'function') {
        // Older API: only an explicit yes counts — an undecided EU visitor
        // must not see a marketing popup.
        allowed = (cp.currentVisitorConsent() || {}).marketing === 'yes';
      } else {
        allowed = true;
      }
    } catch (e) { allowed = false; }

    if (allowed) return next();

    // Consent may be granted after page load (the banner). One retry.
    document.addEventListener('visitorConsentCollected', function onConsent() {
      if (retried) return;
      retried = true;
      document.removeEventListener('visitorConsentCollected', onConsent);
      whenMarketingAllowed(next);
    });
  }

  /* ---- 3: config ---- */
  function fetchConfig() {
    var qs = '?path=' + encodeURIComponent(location.pathname) + (dismissed ? '&mode=teaser' : '');
    fetch(PROXY + '/popup/config' + qs, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg || !cfg.enabled || !cfg.show) return;
        if (dismissed) {
          // Frequency rules bind the POPUP, not the teaser: no auto-open,
          // but the visitor may reopen it by hand.
          if (cfg.teaser) showTeaser(cfg);
          return;
        }
        arm(cfg);
      })
      .catch(function () {});
  }

  /* ---- 4: triggers — independent, OR by default, AND when cfg says so ---- */
  function arm(cfg) {
    var t = cfg.triggers || {};
    var met = { exit: false, delay: false, scroll: false };
    var opened = false;
    var cleanups = [];

    // Mirrors triggerSatisfied() in src/lib/engines/popup.ts.
    function satisfied() {
      var enabled = [];
      if (t.exit) enabled.push(met.exit);
      if (t.delay) enabled.push(met.delay);
      if (t.scroll) enabled.push(met.scroll);
      if (!enabled.length) return false;
      if (t.all) {
        for (var i = 0; i < enabled.length; i++) if (!enabled[i]) return false;
        return true;
      }
      for (var j = 0; j < enabled.length; j++) if (enabled[j]) return true;
      return false;
    }

    function check() {
      if (opened || !satisfied()) return;
      opened = true;
      for (var i = 0; i < cleanups.length; i++) cleanups[i]();
      open(cfg);
    }

    if (t.delay) {
      var timer = setTimeout(function () { met.delay = true; check(); }, t.delay.seconds * 1000);
      cleanups.push(function () { clearTimeout(timer); });
    }

    if (t.scroll) {
      var onScroll = function () {
        var h = document.documentElement;
        var pct = (h.scrollTop + window.innerHeight) / h.scrollHeight * 100;
        if (pct >= t.scroll.pct) { met.scroll = true; check(); }
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      cleanups.push(function () { window.removeEventListener('scroll', onScroll); });
      onScroll();
    }

    if (t.exit) {
      if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
        var onLeave = function (e) { if (e.clientY <= 0) { met.exit = true; check(); } };
        document.documentElement.addEventListener('mouseleave', onLeave);
        cleanups.push(function () { document.documentElement.removeEventListener('mouseleave', onLeave); });
      } else {
        // No cursor to leave with on touch screens — the agreed fallback is
        // a delay, using the delay seconds when set, else 12s.
        var fallback = setTimeout(function () { met.exit = true; check(); },
          ((t.delay && t.delay.seconds) || 12) * 1000);
        cleanups.push(function () { clearTimeout(fallback); });
      }
    }
  }

  /* ---- teaser tab ---- */
  var teaserEl = null;
  function showTeaser(cfg) {
    if (teaserEl || !cfg.teaser) return;
    teaserEl = el('button', 'wasify-popup-teaser wasify-popup-teaser--' +
      (cfg.teaser.position === 'bottom-left' ? 'left' : 'right'), cfg.teaser.text || '');
    if (!teaserEl.textContent) { teaserEl = null; return; } // empty text = no teaser, nothing breaks
    teaserEl.addEventListener('click', function () {
      hideTeaser();
      open(cfg);
    });
    document.body.appendChild(teaserEl);
  }
  function hideTeaser() {
    if (teaserEl) { teaserEl.remove(); teaserEl = null; }
  }

  /* ---- render ---- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text; // config text is DATA, never markup
    return n;
  }

  function open(cfg) {
    var c = cfg.content || {};

    var overlay = el('div', 'wasify-popup-overlay');
    var card = el('div', 'wasify-popup-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    var close = el('button', 'wasify-popup-close', '×');
    close.setAttribute('aria-label', 'Close');
    card.appendChild(close);

    if (c.heading) { var h = el('div', 'wasify-popup-heading', c.heading); card.appendChild(h); card.setAttribute('aria-label', c.heading); }
    if (c.subheading) card.appendChild(el('div', 'wasify-popup-sub', c.subheading));

    var form = el('form', 'wasify-popup-form');

    var phone = el('input', 'wasify-popup-phone');
    phone.type = 'tel';
    phone.name = 'phone';
    phone.autocomplete = 'tel';
    phone.placeholder = '+34 600 123 456';
    form.appendChild(phone);

    // Honeypot — humans never see it, bots love it.
    var hp = el('input', 'wasify-popup-hp');
    hp.type = 'text';
    hp.name = 'website';
    hp.tabIndex = -1;
    hp.autocomplete = 'off';
    hp.setAttribute('aria-hidden', 'true');
    form.appendChild(hp);

    var consentBox = null;
    if (c.consent) {
      var label = el('label', 'wasify-popup-consent');
      consentBox = el('input');
      consentBox.type = 'checkbox';
      label.appendChild(consentBox);
      label.appendChild(el('span', null, c.consent));
      form.appendChild(label);
    }

    var btn = el('button', 'wasify-popup-btn', c.button || '');
    btn.type = 'submit';
    form.appendChild(btn);

    var err = el('div', 'wasify-popup-error');
    form.appendChild(err);

    if (c.disclaimer) form.appendChild(el('div', 'wasify-popup-disclaimer', c.disclaimer));

    card.appendChild(form);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    phone.focus();

    function refresh() {
      btn.disabled = !(phone.value.trim() && (!consentBox || consentBox.checked));
    }
    refresh();
    phone.addEventListener('input', refresh);
    if (consentBox) consentBox.addEventListener('change', refresh);

    function dismiss() {
      var days = (cfg.frequency && cfg.frequency.dismiss_days) || 7;
      lsSet(KEY_HIDE, String(Date.now() + days * 86400000));
      overlay.remove();
      // The tab stays behind so they can come back — their choice, not ours.
      if (cfg.teaser) showTeaser(cfg);
    }
    close.addEventListener('click', dismiss);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) dismiss(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); dismiss(); }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      btn.disabled = true;
      err.textContent = '';

      fetch(PROXY + '/popup/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({
          phone: phone.value,
          country_code: COUNTRY,
          locale: LOCALE,
          hp: hp.value,
          path: location.pathname,
          page_url: location.href,
          consent_text: c.consent || '',
          consent_checked: consentBox ? consentBox.checked : false,
        }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) {
            err.textContent = (res.j && res.j.error) || 'Something went wrong — please try again.';
            refresh();
            return;
          }
          lsSet(KEY_DONE, '1');
          hideTeaser();
          form.remove();
          if (c.success) card.appendChild(el('div', 'wasify-popup-success', c.success));
          if (res.j && res.j.code) card.appendChild(el('div', 'wasify-popup-code', res.j.code));
        })
        .catch(function () {
          err.textContent = 'Network error — please try again.';
          refresh();
        });
    });
  }

  whenMarketingAllowed(fetchConfig);
})();
