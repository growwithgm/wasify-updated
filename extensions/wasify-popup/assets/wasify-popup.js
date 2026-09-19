/*
 * Wasify WhatsApp popup — storefront runtime.
 *
 * Order of operations, and why:
 *   1. localStorage gates first (subscribed = never again; dismissed = wait
 *      N days) — zero network for returning visitors.
 *   2. Shopify Customer Privacy check — the popup IS marketing, so in
 *      consent regions nothing runs (not even the config call) until
 *      marketing is allowed. If consent arrives later, we retry once.
 *   3. Config from the App Proxy. Page targeting was decided on the SERVER:
 *      show:false means this popup never existed on this page — no flash.
 *   4. Trigger (delay / scroll / exit-intent), then render. All content
 *      comes from config and is inserted as textContent — nothing is
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
  if (Date.now() < (parseInt(lsGet(KEY_HIDE) || '0', 10) || 0)) return;

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
    fetch(PROXY + '/popup/config?path=' + encodeURIComponent(location.pathname), { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg || !cfg.enabled || !cfg.show) return;
        arm(cfg);
      })
      .catch(function () {});
  }

  /* ---- 4: trigger ---- */
  function arm(cfg) {
    var t = cfg.trigger || { kind: 'delay', value: 5 };
    var opened = false;
    function once() { if (!opened) { opened = true; open(cfg); } }

    if (t.kind === 'scroll') {
      var pct = Math.max(1, Math.min(100, t.value || 40));
      var onScroll = function () {
        var h = document.documentElement;
        var scrolled = (h.scrollTop + window.innerHeight) / h.scrollHeight * 100;
        if (scrolled >= pct) { window.removeEventListener('scroll', onScroll); once(); }
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    } else if (t.kind === 'exit_intent' && window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
      document.documentElement.addEventListener('mouseleave', function onLeave(e) {
        if (e.clientY <= 0) { document.documentElement.removeEventListener('mouseleave', onLeave); once(); }
      });
    } else {
      // 'delay' — and the exit-intent fallback on touch screens, where there
      // is no cursor to leave with.
      setTimeout(once, Math.max(1, t.value || 5) * 1000);
    }
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
