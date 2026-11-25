/* The Peers Certification: shared behaviour for every page. No libraries. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ARROW = '<svg class="arrow" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>';
  var PHOTOS = ['session', 'portrait', 'group', 'call', 'beach', 'desk'];

  function api(method, url, body) {
    return fetch(url, {
      method: method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) {}
        if (!r.ok) { var er = new Error((j && j.error) || 'Something went wrong. Please try again.'); er.status = r.status; er.data = j; throw er; }
        return j;
      });
    });
  }
  function sha(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    });
  }
  // The password never leaves the browser as typed: it is hashed with the email first, then hashed again on the server.
  function pwHash(email, pw) { return sha(String(email).trim().toLowerCase() + '|' + pw); }
  function pwProblem(pw) {
    if (pw.length < 8) return 'Your password must be at least 8 characters.';
    if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return 'Your password needs an upper and a lower case letter.';
    if (!/[0-9]/.test(pw)) return 'Your password needs a number.';
    return '';
  }
  function money(pence, cur) {
    var code = String(cur || 'gbp').toUpperCase();
    try { return new Intl.NumberFormat(code === 'USD' ? 'en-US' : 'en-GB', { style: 'currency', currency: code, minimumFractionDigits: pence % 100 ? 2 : 0 }).format(pence / 100); }
    catch (e) { return (pence / 100).toFixed(2); }
  }
  function date(iso) { try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; } }
  function q(name) { return new URLSearchParams(location.search).get(name) || ''; }
  function note(el, text, kind) { if (!el) return; el.textContent = text || ''; el.className = 'note ' + (kind || ''); el.classList.toggle('hide', !text); }
  function photoFor(course, i) { return '/img/' + (course && /^[a-z]{1,20}$/.test(course.img || '') ? course.img : PHOTOS[(i || 0) % PHOTOS.length]) + '.jpg'; }
  // price with the earlier price struck through when there is one
  function priceHtml(c, size) {
    var was = c.was ? '<s class="was">' + esc(money(c.was, c.cur)) + '</s>' : '';
    return '<span class="pricerow"><span class="price"' + (size ? ' style="font-size:' + size + 'px"' : '') + '>' + esc(money(c.price, c.cur)) + '</span>' + was + '</span>';
  }
  // ---- launch offer: the end date comes from the server; every [data-until] counts down, and the page refreshes once at zero ----
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function timeLeft(until) { var ms = Date.parse(until) - Date.now(); if (!(ms > 0)) return null; var t = Math.floor(ms / 1000); return [Math.floor(t / 86400), Math.floor(t % 86400 / 3600), Math.floor(t % 3600 / 60), t % 60]; }
  function endDate(until) { try { return new Date(until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' }).replace(' ', '\u00a0'); } catch (e) { return ''; } }
  function timerHtml(until, compact) { return '<span class="timer' + (compact ? ' compact' : '') + '" data-until="' + esc(until) + '"></span>'; }
  var bornAt = Date.now();
  function tick() {
    [].forEach.call(document.querySelectorAll('[data-until]'), function (el) {
      var l = timeLeft(el.getAttribute('data-until'));
      if (!l) {
        el.textContent = 'Offer ended';
        var k = 'ended:' + el.getAttribute('data-until'), seen = false;
        try { seen = sessionStorage.getItem(k); sessionStorage.setItem(k, '1'); } catch (e) { seen = true; }
        if (!seen && Date.now() - bornAt > 5000) setTimeout(function () { location.reload(); }, 1500);
        return;
      }
      el.setAttribute('aria-label', 'Offer ends in ' + l[0] + ' days ' + l[1] + ' hours ' + l[2] + ' minutes');
      el.innerHTML = el.classList.contains('compact') ? l[0] + 'd ' + pad2(l[1]) + 'h ' + pad2(l[2]) + 'm ' + pad2(l[3]) + 's'
        : ['days', 'hrs', 'min', 'sec'].map(function (u, i) { return '<span class="tu"><b>' + (i ? pad2(l[i]) : l[i]) + '</b><i>' + u + '</i></span>'; }).join('');
    });
  }
  setInterval(tick, 1000);
  function saveHtml(c) { return c.was ? '<span class="savepill">Save ' + esc(money(c.was - c.price, c.cur)) + (c.offer ? ' · ' + c.offer.pct + '% off' : '') + '</span>' : ''; }
  function url(c) { return c.slug ? '/' + c.slug : '/certification?c=' + encodeURIComponent(c.id); }
  function titleHtml(t) { var m = /^(Certified)\s+(.*)$/.exec(t); return m ? esc(m[1]) + ' <em>' + esc(m[2]) + '</em>' : esc(t); }

  var whoP = null;
  function who() { if (!whoP) whoP = api('GET', '/api/whoami').catch(function () { return { role: 'anon' }; }); return whoP; }
  var catP = null;
  var TAGS = ['Foundations', 'Mind and performance', 'Relationships and family', 'Wellbeing and healing'];
  function catalogue() {
    if (!catP) catP = api('GET', '/api/catalogue').then(function (r) {
      var rank = function (c) { var i = TAGS.indexOf(c.tag); return i < 0 ? 99 : i; };
      return (r.courses || []).sort(function (x, y) { return (Number(y.featured) - Number(x.featured)) || (rank(x) - rank(y)) || x.title.localeCompare(y.title); });
    });
    return catP;
  }

  // ---------- header and footer ----------
  function chrome() {
    var h = $('#site-header'), f = $('#site-footer');
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var links = [['Verify a certificate', '/verify']];
    var cur = function (href) { return href === path ? ' aria-current="page"' : ''; };
    function render(w) {
      var acct = w.role === 'learner' ? ['My learning', '/learn'] : w.role === 'admin' ? ['Admin', '/admin'] : ['Sign in', '/login'];
      var boss = w.role === 'admin' && /^\/admin(\/|$)/.test(path);
      var inside = boss || (w.role === 'learner' && /^\/(learn|account)(\/|$)/.test(path)); // signed in and working: no sales menu
      var all = boss ? [['Admin', '/admin'], ['View site', '/']] : inside ? [['My learning', '/learn'], ['Account', '/account']] : links;
      h.innerHTML = '<header class="site-head"><div class="wrap bar">' +
        '<a class="brand" href="' + (boss ? '/admin' : inside ? '/learn' : '/') + '">' + EMBLEM + '<span>The Peers <em>Certification</em></span></a>' +
        '<div class="head-right"><nav class="nav desk" aria-label="Main">' + all.map(function (l) { return '<a href="' + l[1] + '"' + cur(l[1]) + '>' + l[0] + '</a>'; }).join('') + '</nav>' +
        (inside ? '<button type="button" class="btn btn-line btn-s" data-out>Sign out</button>' : '<a class="btn btn-ink btn-s" href="' + acct[1] + '">' + acct[0] + '</a>') +
        '<button type="button" class="burger" aria-label="Open menu" aria-expanded="false"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg></button></div></div>' +
        '<nav class="mmenu hide" aria-label="Menu">' + all.map(function (l) { return '<a href="' + l[1] + '">' + l[0] + '</a>'; }).join('') + (inside ? '<a href="#" data-out>Sign out</a>' : '<a href="' + acct[1] + '">' + acct[0] + '</a>') + '</nav></header>';
      h.querySelectorAll('[data-out]').forEach(function (el) { el.addEventListener('click', function (e) { e.preventDefault(); signOut(); }); });
      var b = $('.burger', h), m = $('.mmenu', h);
      b.addEventListener('click', function () { var open = m.classList.toggle('hide'); b.setAttribute('aria-expanded', String(!open)); });
      m.addEventListener('click', function () { m.classList.add('hide'); });
    }
    if (h) { render({ role: 'anon' }); who().then(render); }
    // site-wide launch offer ribbon, on sales pages only (never in admin, learning or account pages)
    if (h && !/^\/(admin|learn|account|setup|login|set-password|forgot|reset)(\/|$)/.test(path)) catalogue().then(function (list) {
      var o = null; list.forEach(function (c) { if (!o && c.offer) o = c.offer; });
      if (!o || $('.offerbar')) return;
      var bar = document.createElement('div');
      bar.className = 'offerbar';
      bar.innerHTML = '<div class="wrap"><span><b>Launch offer:</b> ' + o.pct + '% off<span class="wide-only"> every certification</span> until ' + esc(endDate(o.until)) + '</span><span class="ends">Ends in ' + timerHtml(o.until, true) + '</span>' +
        (path === '/certifications' ? '' : '<a href="/certifications">See all 20' + ARROW + '</a>') + '</div>';
      h.parentNode.insertBefore(bar, h); tick();
    }, function () {});
    if (f) {
      f.innerHTML = '<footer class="site-foot"><div class="wrap in">' +
        '<div class="rowf" style="gap:48px 72px"><div class="stack" style="flex:1.4 1 380px;min-width:0">' +
        '<h2>One idea a week for building your <em>coaching life.</em></h2>' +
        '<form class="news" novalidate><label class="sr" for="news-email">Email address</label><input id="news-email" type="email" placeholder="Your email address" autocomplete="email"><button class="btn btn-sun btn-s" type="submit">Sign me up</button></form>' +
        '<p class="small hide" role="status" style="color:var(--sun)"></p></div>' +
        '<div class="cols">' +
        '<div class="col"><span>Explore</span><a href="/#how-it-works">How it works</a><a href="/verify">Verify a certificate</a></div>' +
        '<div class="col"><span>Your account</span><a href="/login">Sign in</a><a href="/learn">My learning</a><a href="/account">Account settings</a></div>' +
        '<div class="col"><span>Support</span><a href="/#faq">FAQ</a><a href="/contact">Contact</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds</a></div>' +
        '</div></div>' +
        '<div class="wordmark" aria-hidden="true">The Peers <em>Certification</em></div>' +
        '<div class="legal"><span class="foot-mark">' + EMBLEM + 'thepeerscertification.com</span><span>Photography shown is placeholder imagery.</span></div></div></footer>';
      var form = $('.news', f), msg = $('[role=status]', f);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = $('#news-email', f).value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { msg.textContent = 'Please enter a valid email address.'; msg.classList.remove('hide'); return; }
        api('POST', '/api/db/add', { coll: 'leads/' + 'newsletter' + '/items', data: { kind: 'newsletter', subject: 'Newsletter sign-up', fields: { Email: v } } })
          .then(function () { msg.textContent = 'Thank you. You are on the list.'; form.reset(); }, function (er) { msg.textContent = er.message; })
          .then(function () { msg.classList.remove('hide'); });
      });
    }
  }

  // ---------- enrol: two fields, then straight to payment ----------
  function enrol(course) {
    var old = $('.modal'); if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'modal';
    d.innerHTML = '<div class="box" role="dialog" aria-modal="true" aria-labelledby="en-h">' +
      '<button type="button" class="x" aria-label="Close"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg></button>' +
      '<p class="eyebrow">Step 1 of 2</p>' +
      '<h2 id="en-h" class="d3" style="padding-right:48px">Enrol on <em>' + esc(course.title) + '</em></h2>' +
      '<p>Tell us where to send your login, then pay securely by card. You can start the first module straight away.</p>' +
      '<form class="stack" novalidate style="gap:14px">' +
      '<div class="field"><label for="en-name">Your name</label><input id="en-name" type="text" autocomplete="name" required></div>' +
      '<div class="field"><label for="en-email">Email address</label><input id="en-email" type="email" autocomplete="email" required></div>' +
      '<button class="btn btn-sea btn-block" type="submit">Continue to secure payment' + ARROW + '</button>' +
      '<p class="note hide" role="status"></p></form>' +
      '<p class="small muted">One payment of ' + esc(money(course.price, course.cur)) + '. No subscription. 12 months of access.</p></div>';
    document.body.appendChild(d);
    var close = function () { d.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $('.x', d).addEventListener('click', close);
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    var msg = $('.note', d), btn = $('button[type=submit]', d);
    $('#en-name', d).focus();
    $('form', d).addEventListener('submit', function (e) {
      e.preventDefault();
      var n = $('#en-name', d).value.trim(), em = $('#en-email', d).value.trim();
      if (!n) return note(msg, 'Please add your name.', 'bad');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return note(msg, 'Please enter a valid email address.', 'bad');
      btn.disabled = true; note(msg, 'Opening the secure payment page…', '');
      api('POST', '/api/enrol', { course: course.id, n: n, e: em }).then(function (r) { location.href = r.url; }, function (er) { btn.disabled = false; note(msg, er.message, 'bad'); });
    });
  }
  // any element with data-enrol="<course id>" opens the enrol step
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-enrol]');
    if (!b) return;
    e.preventDefault();
    catalogue().then(function (list) { var c = list.filter(function (x) { return x.id === b.getAttribute('data-enrol'); })[0]; if (c) enrol(c); });
  });

  function requireLearner() {
    return who().then(function (w) {
      if (w.role !== 'learner') { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search)); return new Promise(function () {}); }
      return w;
    });
  }
  document.addEventListener('submit', function (e) {
    var f = e.target; if (!f.matches || !f.matches('form[data-news]')) return;
    e.preventDefault();
    var input = f.querySelector('input[type=email]'), msg = f.nextElementSibling, v = input.value.trim();
    var tell = function (t) { if (msg && msg.getAttribute('role') === 'status') { msg.textContent = t; msg.classList.remove('hide'); } };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return tell('Please enter a valid email address.');
    api('POST', '/api/db/add', { coll: 'leads/newsletter/items', data: { kind: 'newsletter', subject: 'Newsletter sign-up', fields: { Email: v } } })
      .then(function () { f.reset(); tell('Thank you. You are on the list.'); }, function (er) { tell(er.message); });
  });
  // ---------- the emblem: the mark of the awarding body, used in the header, footer and on certificates ----------
  var EMBLEM = '<svg class="emblem" aria-hidden="true" viewBox="0 0 64 64"><circle cx="32" cy="32" r="31" fill="#F0A868"/><circle cx="32" cy="32" r="26" fill="none" stroke="#1D1916" stroke-width="1" stroke-dasharray="1.5 3"/>' +
    '<text x="31" y="45" text-anchor="middle" font-family="Instrument Serif,Georgia,serif" font-style="italic" font-size="38" fill="#1D1916">P</text><path d="M46 14l1.7 4.8 4.8 1.7-4.8 1.7L46 27l-1.7-4.8-4.8-1.7 4.8-1.7z" fill="#A8521D"/></svg>';

  // ---------- motion: sections ease in as they are reached and headline numbers count up (off for people who ask for less motion) ----------
  function motion() {
    if (!('IntersectionObserver' in window) || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) || document.querySelector('main.app')) return;
    document.documentElement.classList.add('anim');
    var countUp = function (el) {
      var m = /^(\D*)(\d+)(\D*)$/.exec(el.textContent.trim()); if (!m || el.dataset.done) return; el.dataset.done = 1;
      var end = +m[2], t0 = 0, dur = 1100;
      var step = function (t) { if (!t0) t0 = t; var k = Math.min(1, (t - t0) / dur), v = Math.round(end * (1 - Math.pow(1 - k, 3))); el.textContent = m[1] + v + m[3]; if (k < 1) requestAnimationFrame(step); };
      el.textContent = m[1] + '0' + m[3]; requestAnimationFrame(step);
    };
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (!e.isIntersecting) return; e.target.classList.add('in'); io.unobserve(e.target); if (e.target.matches('.hero-stats,.nums')) [].forEach.call(e.target.querySelectorAll('b'), countUp); }); }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    var queued = false, scan = function () { queued = false; [].forEach.call(document.querySelectorAll('section > .wrap, .hero-stats, .cta'), function (el) { if (el.dataset.rv || el.classList.contains('hero-copy') || el.closest('.lhero')) return; el.dataset.rv = 1; el.classList.add('rv'); io.observe(el); }); };
    scan(); new MutationObserver(function () { if (!queued) { queued = true; requestAnimationFrame(scan); } }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', motion); else motion();

  // ---------- the certificate: one design, used for the real thing and for examples ----------
  function sealSvg() {
    var pts = [], n = 28, i, a, r;
    for (i = 0; i < n * 2; i++) { a = Math.PI * i / n; r = i % 2 ? 46 : 50; pts.push((60 + r * Math.sin(a)).toFixed(2) + ',' + (60 - r * Math.cos(a)).toFixed(2)); }
    return '<svg class="seal" aria-hidden="true" viewBox="0 0 120 150"><path d="M38 92l-12 54 18-9 10 13 10-50z" fill="#C97A36"/><path d="M82 92l12 54-18-9-10 13-10-50z" fill="#D98B45"/>' +
      '<polygon points="' + pts.join(' ') + '" fill="#F0A868"/><circle cx="60" cy="60" r="41" fill="none" stroke="#1D1916" stroke-width=".8"/><circle cx="60" cy="60" r="27" fill="#FBF8F2" stroke="#1D1916" stroke-width=".8"/>' +
      '<defs><path id="seal-ring" d="M60 60m-33.5 0a33.5 33.5 0 1 1 67 0a33.5 33.5 0 1 1 -67 0"/></defs><text font-family="DM Sans,system-ui,sans-serif" font-size="6.4" font-weight="700" letter-spacing="1.9" fill="#1D1916"><textPath href="#seal-ring" startOffset="0">CERTIFIED COACH  ✦  VERIFIED ONLINE  ✦  </textPath></text>' +
      '<path d="M48 61l8.5 8.5L73 51" fill="none" stroke="#1D1916" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  function certificate(o) {
    var name = String(o.n || ''), size = name.length > 30 ? 4.6 : name.length > 22 ? 5.6 : 7;
    return '<div class="certificate' + (o.cls ? ' ' + o.cls : '') + '" role="img" aria-label="' + esc((o.example ? 'Example certificate: ' : 'Certificate: ') + o.title + (o.example ? '' : ', awarded to ' + name)) + '"' + (o.style ? ' style="' + o.style + '"' : '') + '><div class="in">' +
      '<i class="cn tl"></i><i class="cn tr"></i><i class="cn bl"></i><i class="cn br"></i>' +
      '<span class="org">' + EMBLEM + '<span>The Peers Certification</span></span>' +
      '<span class="ttl">Certificate <em>of</em> Achievement</span><span class="rule"></span>' +
      '<span class="say">This is to certify that</span><span class="who" style="font-size:' + size + 'cqw">' + esc(name) + '</span>' +
      '<span class="say">has completed the course of study, passed the final examination<br>and is awarded the title of</span><span class="what">' + esc(o.title) + '</span>' +
      '<div class="foot"><div class="cfact"><b>' + esc(o.date) + '</b><span>Date awarded</span></div>' + sealSvg() + '<div class="cfact"><b>' + esc(o.no) + '</b><span>Certificate number</span></div></div>' +
      '<span class="check">Verify this certificate at ' + esc(o.host || 'thepeerscertification.com') + '/verify</span></div></div>';
  }
  function signOut() { return api('POST', '/api/logout', {}).then(function () { location.href = '/'; }); }

  window.TCC = { timerHtml: timerHtml, endDate: endDate, saveHtml: saveHtml, tick: tick, certificate: certificate, $: $, esc: esc, api: api, sha: sha, pwHash: pwHash, pwProblem: pwProblem, money: money, date: date, q: q, note: note, who: who, catalogue: catalogue, enrol: enrol, requireLearner: requireLearner, signOut: signOut, photoFor: photoFor, priceHtml: priceHtml, titleHtml: titleHtml, url: url, ARROW: ARROW };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', chrome); else chrome();
})();
