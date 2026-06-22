/* ===========================================================
   Rent With Lena - front-end
   =========================================================== */
(function () {
  'use strict';

  /* Zillow access is temporarily off. Disable every booking link/button and
     swap its label for a "coming back soon" notice. Restore the URL below and
     this loop to the previous wiring to re-enable. */
  Array.prototype.forEach.call(document.querySelectorAll('[data-zillow]'), function (el) {
    el.removeAttribute('href');
    el.removeAttribute('target');
    el.removeAttribute('rel');
    el.setAttribute('aria-disabled', 'true');
    el.classList.add('is-disabled');
    el.textContent = 'Zillow listing coming back soon';
    el.addEventListener('click', function (e) { e.preventDefault(); });
  });

  /* Current year */
  var yr = document.getElementById('yr');
  if (yr) yr.textContent = new Date().getFullYear();

  /* ---------- Highlight cards: click / keyboard to expand more info ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.hl[role="button"]'), function (card) {
    function toggle() {
      card.setAttribute('aria-expanded', card.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    }
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggle(); }
    });
  });

  /* ---------- Header background on scroll ---------- */
  var header = document.getElementById('header');
  function onHeaderScroll() {
    if (window.scrollY > 40) header.classList.add('solid');
    else header.classList.remove('solid');
  }
  onHeaderScroll();
  window.addEventListener('scroll', onHeaderScroll, { passive: true });

  /* ---------- Skip-the-tour button (hide once past both video scrubs) ---------- */
  var skipBtn = document.getElementById('skip-tour');
  var afterVideos = document.getElementById('location');
  if (skipBtn && afterVideos) {
    function onSkipScroll() {
      /* gone once the post-video content reaches the top of the viewport */
      var passed = afterVideos.getBoundingClientRect().top <= 8;
      skipBtn.classList.toggle('gone', passed);
    }
    onSkipScroll();
    window.addEventListener('scroll', onSkipScroll, { passive: true });
  }

  /* ---------- Video progress bar (ticked timeline for the active scrub) ---------- */
  (function setupVidProgress() {
    var bar = document.getElementById('vid-progress');
    var fill = document.getElementById('vp-fill');
    if (!bar || !fill) return;
    /* The scroll-scrub "videos" on the page, in document order. */
    var scrubs = ['scrub', 'scrub2']
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);
    if (!scrubs.length) return;

    function onVidScroll() {
      var vh = window.innerHeight;
      var active = null, prog = 0;
      for (var i = 0; i < scrubs.length; i++) {
        var r = scrubs[i].getBoundingClientRect();
        /* "watching" this video while its sticky stage still fills the screen */
        if (r.top <= 1 && r.bottom > vh * 0.5) {
          var total = scrubs[i].offsetHeight - vh;
          var p = total > 0 ? (-r.top) / total : 1;
          active = scrubs[i];
          prog = p < 0 ? 0 : p > 1 ? 1 : p;
          break;
        }
      }
      if (active) {
        var pct = Math.round(prog * 100);
        fill.style.setProperty('--p', pct + '%');
        bar.setAttribute('aria-valuenow', pct);
        bar.setAttribute('aria-hidden', 'false');
        bar.classList.add('show');
      } else {
        bar.classList.remove('show');
        bar.setAttribute('aria-hidden', 'true');
      }
    }
    onVidScroll();
    window.addEventListener('scroll', onVidScroll, { passive: true });
    window.addEventListener('resize', onVidScroll, { passive: true });
  })();

  /* ===========================================================
     SCROLL-SCRUB CANVAS (image sequence) - reusable engine
     Two instances run on the page: the interior hero tour, and a
     shorter "leaving the house → Brickell skyline" finale below the
     gallery. Each owns its own frame set, canvas and captions.
     =========================================================== */
  var pad = function (n) { return ('0000' + n).slice(-4); };
  /* Pick the right-weight frame set: crisp on desktop, lighter on phones. */
  var isHandheld = Math.min(window.innerWidth, window.innerHeight) <= 760
    || /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent);
  var canBitmap = typeof window.createImageBitmap === 'function';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Frames load as plain <img>s (works from both a web server and a local
     file:// preview, unlike fetch). We then decode a sliding *band* of them
     into ImageBitmaps and only ever PAINT those bitmaps - never a raw <img>.
     Painting a bitmap is instant (no main-thread JPEG decode → no scroll jank),
     and because we never ctx.drawImage a raw <img>, the browser never builds the
     gigabyte-scale decoded-image cache that crashed an earlier version. Bitmaps
     outside the band are released, so memory stays bounded. */
  function createScrub(opts) {
    var section = opts.section, canvas = opts.canvas;
    if (!section || !canvas) return null;
    var ctx = canvas.getContext('2d', { alpha: false });
    var FRAME_COUNT = opts.frameCount;
    var FRAME_DIR = opts.dir;
    var framePath = function (i) { return FRAME_DIR + 'f_' + pad(i + 1) + '.jpg'; };
    var loader = opts.loader || null;
    var loaderFill = opts.loaderFill || null;
    var loaderPct = opts.loaderPct || null;
    var heroIntro = opts.intro || null;
    var caps = Array.prototype.slice.call(section.querySelectorAll('.cap'));
    var CAP_WIN = opts.capWindow || 0.06;

    var images   = new Array(FRAME_COUNT);   // source <img>s (decode source only)
    var bitmaps  = new Array(FRAME_COUNT);   // decoded ImageBitmaps (ready to paint)
    var decoding = new Array(FRAME_COUNT);   // decode in flight?
    var loadedCount = 0, revealed = false, started = false;
    var REVEAL_AT = Math.min(28, FRAME_COUNT);   // reveal once first scenes are in
    /* Sliding-window sizes. KEEP bounds peak memory (≈ (2·KEEP+1) decoded frames);
       AHEAD (< KEEP) is how far we pre-decode in the scroll direction. */
    var KEEP  = isHandheld ? 16 : 26;
    var AHEAD = isHandheld ? 10 : 18;
    var MAX_DECODE = isHandheld ? 3 : 6;   // cap concurrent decodes so a flick can't storm
    var inflight = 0, lastDir = 1;
    var current = 0, target = 0, lastDrawn = -1, lastCenter = -1;
    var cw = 0, ch = 0, dpr = 1, lastPct = -1;

    function decodeFrame(i) {
      if (!canBitmap || bitmaps[i] || decoding[i] || inflight >= MAX_DECODE) return;
      var img = images[i];
      if (!img || !img.complete || !img.naturalWidth) return;
      decoding[i] = true; inflight++;
      window.createImageBitmap(img).then(function (bm) {
        decoding[i] = false; inflight--;
        if (bitmaps[i] || Math.abs(i - Math.round(current)) > KEEP) {
          try { bm.close(); } catch (e) {}        // already have it, or it scrolled away
        } else {
          bitmaps[i] = bm;
          if (Math.round(current) === i) lastDrawn = -1; // repaint if it's the visible frame
        }
        fillBand(Math.round(current), lastDir);            // keep the pipeline topped up
      }).catch(function () { decoding[i] = false; inflight--; });
    }

    /* Request decodes for the band around `center`, nearest-first and biased
       toward scroll direction, until the concurrency cap is reached. */
    function fillBand(center, dir) {
      decodeFrame(center);
      var fwd = dir >= 0 ? AHEAD : (AHEAD >> 1);
      var bwd = dir >= 0 ? (AHEAD >> 1) : AHEAD;
      for (var d = 1; d <= AHEAD && inflight < MAX_DECODE; d++) {
        if (d <= fwd && center + d < FRAME_COUNT) decodeFrame(center + d);
        if (d <= bwd && center - d >= 0)          decodeFrame(center - d);
      }
    }

    /* Release decoded bitmaps that have scrolled outside the keep band. */
    function releaseBand(center) {
      for (var i = 0; i < FRAME_COUNT; i++) {
        if (bitmaps[i] && Math.abs(i - center) > KEEP) {
          try { bitmaps[i].close(); } catch (e) {}
          bitmaps[i] = null;
        }
      }
    }

    function manageWindow(center, dir) {
      lastCenter = center; lastDir = dir;
      fillBand(center, dir);
      releaseBand(center);
    }

    /* ---- canvas sizing (cover, dpr-aware) ---- */
    function resize() {
      /* cap at 1.5: imperceptible for a moving hero, but far cheaper to paint
         each frame than a full 2x backing store on hi-dpi screens */
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      cw = canvas.clientWidth; ch = canvas.clientHeight;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(current, true);
    }

    function drawImageCover(img) {
      if (!img) return false;
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      if (!iw || !ih) return false;
      var r = Math.max(cw / iw, ch / ih);
      var w = iw * r, h = ih * r;
      ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
      return true;
    }

    /* The exact decoded bitmap, else the nearest decoded one - visually identical
       and, crucially, never stalls on a decode, so fast scrubbing stays smooth
       (a frame or two stale during a flick is imperceptible). */
    function nearestPaintable(idx) {
      if (bitmaps[idx]) return bitmaps[idx];
      for (var d = 1; d < FRAME_COUNT; d++) {
        var a = idx - d, b = idx + d;
        if (a >= 0 && bitmaps[a]) return bitmaps[a];
        if (b < FRAME_COUNT && bitmaps[b]) return bitmaps[b];
      }
      return null;
    }

    /* Legacy fallback (browsers without createImageBitmap): paint the nearest
       loaded <img> directly - decodes on draw, but those users are rare. */
    function nearestImage(idx) {
      var im = images[idx];
      if (im && im.complete && im.naturalWidth) return im;
      for (var d = 1; d < FRAME_COUNT; d++) {
        var a = images[idx - d], b = images[idx + d];
        if (idx - d >= 0 && a && a.complete && a.naturalWidth) return a;
        if (idx + d < FRAME_COUNT && b && b.complete && b.naturalWidth) return b;
      }
      return null;
    }

    function draw(frameFloat, force) {
      var idx = Math.max(0, Math.min(FRAME_COUNT - 1, Math.round(frameFloat)));
      if (!force && idx === lastDrawn) return;
      var src = canBitmap ? nearestPaintable(idx) : nearestImage(idx);
      if (drawImageCover(src)) lastDrawn = idx;
    }

    function computeProgress() {
      var rect = section.getBoundingClientRect();
      var total = section.offsetHeight - window.innerHeight;
      if (total <= 0) return 0;
      var p = (-rect.top) / total;
      return p < 0 ? 0 : p > 1 ? 1 : p;
    }

    function updateOverlays(p) {
      if (heroIntro) {                 // intro fades over first 9% of scroll
        var o = 1 - p / 0.09;
        if (o < 0) o = 0;
        heroIntro.style.opacity = o;
        heroIntro.style.transform = 'translateY(' + (-50 + (-p * 40)) + '%)';
        heroIntro.style.pointerEvents = o < 0.05 ? 'none' : '';
      }
      for (var i = 0; i < caps.length; i++) {
        var at = parseFloat(caps[i].getAttribute('data-at'));
        caps[i].classList.toggle('show', Math.abs(p - at) < CAP_WIN);
      }
    }

    function tick() {
      target = computeProgress() * (FRAME_COUNT - 1);
      if (reduceMotion) current = target;
      else {
        current += (target - current) * 0.18;
        if (Math.abs(target - current) < 0.08) current = target;
      }
      var idx = Math.round(current);
      if (idx !== lastCenter) manageWindow(idx, target >= current ? 1 : -1);
      draw(current);
      updateOverlays(target / (FRAME_COUNT - 1));
      requestAnimationFrame(tick);
    }

    function updateLoader() {
      var pct = Math.round((loadedCount / FRAME_COUNT) * 100);
      if (pct !== lastPct) {           // avoid touching the DOM on every load
        lastPct = pct;
        if (loaderFill) loaderFill.style.width = pct + '%';
        if (loaderPct) loaderPct.textContent = pct < 100 ? ('Loading the tour · ' + pct + '%') : 'Ready';
      }
      if (!revealed && loadedCount >= REVEAL_AT) reveal();
    }

    function reveal() {
      revealed = true;
      resize();
      manageWindow(0, 1);
      draw(0, true);
      if (loader) loader.classList.add('hide');
      requestAnimationFrame(tick);
    }

    function loadFrames() {
      for (var i = 0; i < FRAME_COUNT; i++) {
        (function (i) {
          var img = new Image();
          img.decoding = 'async';
          img.onload = img.onerror = function () {
            loadedCount++; updateLoader();
            if (revealed && Math.abs(i - Math.round(current)) <= AHEAD) decodeFrame(i);
            else if (!canBitmap && revealed && Math.round(current) === i) lastDrawn = -1;
          };
          img.src = framePath(i);
          images[i] = img;
        })(i);
      }
    }

    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });

    function startLoading() {
      if (started) return; started = true;
      resize();
      loadFrames();
      setTimeout(function () { if (!revealed) reveal(); }, 6000); // safety on a slow link
    }

    resize();   // size the canvas right away so layout isn't 0-height
    return { start: startLoading, section: section };
  }

  var DIR  = isHandheld ? 'assets/frames-m/'  : 'assets/frames/';
  var DIR2 = isHandheld ? 'assets/frames2-m/' : 'assets/frames2/';

  /* Interior tour - the hero. Loads immediately. */
  var heroScrub = createScrub({
    section: document.getElementById('scrub'),
    canvas: document.getElementById('scrub-canvas'),
    dir: DIR, frameCount: 882,
    loader: document.getElementById('loader'),
    loaderFill: document.getElementById('loader-fill'),
    loaderPct: document.getElementById('loader-pct'),
    intro: document.getElementById('hero-intro')
  });
  if (heroScrub) heroScrub.start();

  /* Exterior finale (leaving the house → skyline) - below the gallery.
     Lazy-loads as it approaches the viewport so it isn't competing with the
     hero for bandwidth/decoding on page load. */
  var skyScrub = createScrub({
    section: document.getElementById('scrub2'),
    canvas: document.getElementById('scrub2-canvas'),
    dir: DIR2, frameCount: 176
  });
  if (skyScrub) {
    if ('IntersectionObserver' in window) {
      var io2 = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) {
          skyScrub.start(); io2.disconnect();
        }
      }, { rootMargin: '120% 0px' });   // start ~one screen before it's in view
      io2.observe(skyScrub.section);
    } else {
      skyScrub.start();
    }
  }

  /* ===========================================================
     GALLERY LIGHTBOX
     =========================================================== */
  var items = Array.prototype.slice.call(document.querySelectorAll('.gal-item'));
  var srcs = items.map(function (b) { return b.getAttribute('data-src'); });
  var lb = document.getElementById('lightbox');
  var lbImg = document.getElementById('lb-img');
  var lbIndex = 0;

  function openLb(i) {
    lbIndex = (i + srcs.length) % srcs.length;
    lbImg.setAttribute('src', srcs[lbIndex]);
    lb.classList.add('open');
    lb.setAttribute('aria-hidden', 'false');
  }
  function closeLb() { lb.classList.remove('open'); lb.setAttribute('aria-hidden', 'true'); }

  items.forEach(function (b, i) { b.addEventListener('click', function () { openLb(i); }); });
  if (lb) {
    lb.querySelector('.lb-close').addEventListener('click', closeLb);
    lb.querySelector('.lb-next').addEventListener('click', function (e) { e.stopPropagation(); openLb(lbIndex + 1); });
    lb.querySelector('.lb-prev').addEventListener('click', function (e) { e.stopPropagation(); openLb(lbIndex - 1); });
    lb.addEventListener('click', function (e) { if (e.target === lb) closeLb(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') closeLb();
      else if (e.key === 'ArrowRight') openLb(lbIndex + 1);
      else if (e.key === 'ArrowLeft') openLb(lbIndex - 1);
    });
  }

  /* ===========================================================
     GALLERY CAROUSEL - arrow buttons scroll the track
     =========================================================== */
  (function () {
    var track = document.querySelector('.gal-track');
    if (!track) return;
    var prev = document.querySelector('.car-prev');
    var next = document.querySelector('.car-next');
    function page() { return Math.max(track.clientWidth * 0.8, 240); }
    function update() {
      var max = track.scrollWidth - track.clientWidth - 2;
      if (prev) prev.disabled = track.scrollLeft <= 2;
      if (next) next.disabled = track.scrollLeft >= max;
    }
    if (prev) prev.addEventListener('click', function () { track.scrollBy({ left: -page(), behavior: 'smooth' }); });
    if (next) next.addEventListener('click', function () { track.scrollBy({ left: page(), behavior: 'smooth' }); });
    track.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  })();

  /* ===========================================================
     SCROLL REVEAL (fade + rise as elements enter the viewport)
     =========================================================== */
  (function setupReveal() {
    if (reduceMotion || !('IntersectionObserver' in window)) return;

    /* Elements that fade & rise individually on scroll-in. */
    var sel = [
      '.welcome .eyebrow', '.welcome .display', '.welcome .lede', '.welcome .stats', '.welcome .cta-row',
      '.gallery .eyebrow', '.gallery .display',
      '.loc-text .eyebrow', '.loc-text .display', '.loc-text .lede', '.loc-text .cta-row',
      '.loc-map',
      '.book .eyebrow', '.book .display', '.book-sub', '.book .cta-row', '.book-addr'
    ].join(',');

    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
      el.classList.add('reveal');
    });

    /* Grid children animate in a staggered cascade. */
    [['.hl-grid', '.hl'], ['.gal-grid', '.gal-item']].forEach(function (pair) {
      var grid = document.querySelector(pair[0]);
      if (!grid) return;
      Array.prototype.forEach.call(grid.querySelectorAll(pair[1]), function (el, i) {
        el.classList.add('reveal');
        el.style.setProperty('--reveal-delay', (i * 80) + 'ms');
      });
    });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (el) {
      io.observe(el);
    });
  })();
})();
