/*
 * dsh-cost live dashboard client.
 *
 * In `http` mode it polls `/api/fragment` every N seconds and swaps only the
 * report body (`.wrap`), so the page keeps the exact dsh-cost report layout
 * while the numbers update in place.
 *
 * In `file` mode the page is opened through file:///; a browser cannot execute
 * the CLI there, so a background regenerator (dsh-cost-live-watch.cmd) rewrites
 * this HTML file and the page reloads itself every N seconds. Scroll position
 * and expanded session rows survive the reload. If two reloads in a row see the
 * same snapshot, auto-reload pauses and asks the user to start the watcher.
 */
(function () {
  'use strict';

  var CONFIG = window.__DSH_LIVE__ || {};
  var MODE = CONFIG.mode === 'file' ? 'file' : 'http';
  var INTERVAL = Math.max(5000, Number(CONFIG.intervalMs) || 20000);
  var AUTO_RELOAD = MODE === 'file' && CONFIG.autoReload === true;
  var ENDPOINT = typeof CONFIG.endpoint === 'string' && CONFIG.endpoint ? CONFIG.endpoint : '/api/fragment';
  var SERVER_URL = typeof CONFIG.serverUrl === 'string' && CONFIG.serverUrl ? CONFIG.serverUrl : null;
  var STORE = 'dsh-cost-live:v1:';
  var MAX_STALE = 2;

  var state = {
    paused: false,
    autoPausedForStale: false,
    busy: false,
    nextAt: 0,
    lastGeneratedAt: typeof CONFIG.generatedAt === 'number' ? CONFIG.generatedAt : null,
    lastCost: null,
    staleCount: 0,
    fails: 0,
    error: null,
    hiddenAt: null,
    retryTimer: null,
    tickTimer: null,
    requestId: 0,
    storageBlocked: false,
    lastHtml: null,
    showAll: false,
    range: 'all',
    view: 'session',
    lastView: null,
  };

  var dock = null;
  var ui = {};

  /* ------------------------------------------------------------------ utils */

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function clock(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    var date = new Date(ms);
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  function readStore(key, fallback) {
    try {
      var raw = window.sessionStorage.getItem(STORE + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      window.sessionStorage.setItem(STORE + key, JSON.stringify(value));
    } catch (error) {
      /* private mode / storage disabled: live updates still work */
    }
  }

  /** file:// auto-reload relies on sessionStorage for stale detection. */
  function storageWorks() {
    try {
      var probe = STORE + 'probe';
      window.sessionStorage.setItem(probe, '1');
      window.sessionStorage.removeItem(probe);
      return true;
    } catch (error) {
      return false;
    }
  }

  function textOf(root, selector) {
    var node = root && root.querySelector(selector);
    return node && node.textContent ? node.textContent.trim() : '';
  }

  function currentCost() {
    return textOf(document, '.cards .card.money .v') || textOf(document, '.cards .card .v');
  }

  function currentSummary() {
    var cards = document.querySelectorAll('.cards .card');
    var cost = cards[0] ? textOf(cards[0], '.v') : '—';
    var tokens = cards[1] ? textOf(cards[1], '.v') : '—';
    // Count only sessions inside the active time range: rows paged away by
    // "show more" stay in the DOM but are not hidden by the range filter.
    var rows = document.querySelectorAll('tr.session');
    var sessions = 0;
    for (var index = 0; index < rows.length; index += 1) {
      if (!rows[index].hasAttribute('data-range-hidden')) sessions += 1;
    }
    if (state.view === 'daily' && state.lastView && state.lastView.stats) {
      sessions = state.lastView.stats.sessions;
    }
    var unpriced = document.querySelector('.note.warn');
    var rangeNote = document.querySelector('[data-range-note]');
    return {
      cost: cost || '—',
      tokens: tokens || '—',
      sessions: sessions,
      range: rangeNote ? rangeNote.textContent.trim() : '',
      unpriced: unpriced ? unpriced.textContent.trim() : '',
    };
  }

  function openSessionIds() {
    var ids = [];
    var rows = document.querySelectorAll('tr.detail.open[data-session]');
    for (var index = 0; index < rows.length; index += 1) {
      var id = rows[index].getAttribute('data-session');
      if (id) ids.push(id);
    }
    return ids;
  }

  function findDetail(id) {
    var rows = document.querySelectorAll('tr.detail[data-session]');
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index].getAttribute('data-session') === id) return rows[index];
    }
    return null;
  }

  function restoreOpen(ids) {
    if (!Array.isArray(ids)) return;
    for (var index = 0; index < ids.length; index += 1) {
      var row = findDetail(ids[index]);
      if (row) row.classList.add('open');
    }
  }

  /* ------------------------------------------------ time range + paging */

  /** localStorage handle; file:// / private mode may throw on access. */
  function localStorageRef() {
    try {
      return window.localStorage;
    } catch (error) {
      return null;
    }
  }

  function urlParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (error) {
      return null;
    }
  }

  function syncUrl() {
    try {
      var next = new URL(window.location.href);
      next.searchParams.set('range', state.range);
      next.searchParams.set('view', state.view);
      window.history.replaceState(null, '', next.toString());
    } catch (error) {
      /* file:// / restricted history: URL state is optional */
    }
  }

  function readRange() {
    var runtime = window.DSH_TIME_RANGE;
    if (!runtime) return 'all';
    var fromUrl = urlParam('range');
    if (fromUrl) return runtime.normalizeTimeRange(fromUrl);
    return runtime.readSavedRange(localStorageRef());
  }

  function readView() {
    var runtime = window.DSH_TIME_RANGE;
    if (!runtime) return 'session';
    var fromUrl = urlParam('view');
    if (fromUrl) return runtime.normalizeView(fromUrl);
    return runtime.readSavedView(localStorageRef());
  }

  /**
   * Re-apply the selected time range and the "show all sessions" state.
   *
   * `window.DSH_TIME_RANGE` is injected by live.mjs from the same source the
   * standalone report embeds: it hides out-of-range rows, re-pages survivors,
   * and recomputes the cards + model table from the embedded dataset. Calling
   * it after every fragment swap also keeps the user's range across refreshes.
   */
  function applyView() {
    var runtime = window.DSH_TIME_RANGE;
    if (!runtime) return null;
    var result = runtime.applyTimeRange(document, { range: state.range, showAll: state.showAll, view: state.view });
    if (result) state.lastView = result;
    return result;
  }

  function setShowAll(showAll) {
    state.showAll = showAll === true;
    writeStore('showAll', state.showAll);
    applyView();
    writeStore('open', openSessionIds());
  }

  function setRange(range) {
    var runtime = window.DSH_TIME_RANGE;
    if (!runtime) return;
    state.range = runtime.normalizeTimeRange(range);
    runtime.saveRange(localStorageRef(), state.range);
    applyView();
    syncUrl();
    writeStore('open', openSessionIds());
    render();
  }

  function setView(view) {
    var runtime = window.DSH_TIME_RANGE;
    if (!runtime) return;
    state.view = runtime.normalizeView(view);
    runtime.saveView(localStorageRef(), state.view);
    applyView();
    syncUrl();
    writeStore('open', openSessionIds());
    render();
  }

  function rememberState() {
    writeStore('open', openSessionIds());
    writeStore('scroll', window.scrollY || window.pageYOffset || 0);
  }

  function restoreScroll() {
    var saved = readStore('scroll', null);
    if (typeof saved !== 'number') return;
    window.requestAnimationFrame(function () {
      window.scrollTo(0, saved);
    });
  }

  /* --------------------------------------------------------------- the dock */

  function buildDock() {
    dock = document.createElement('aside');
    dock.className = 'live-dock';
    dock.setAttribute('aria-label', '实时刷新状态');
    dock.innerHTML = [
      '<div class="ld-head">',
      '<span class="ld-dot" aria-hidden="true"></span>',
      '<span class="ld-label">实时</span>',
      '<span class="ld-time">—</span>',
      '</div>',
      '<div class="ld-progress" aria-hidden="true"><i></i></div>',
      '<div class="ld-sub">—</div>',
      '<div class="ld-metrics">—</div>',
      '<div class="ld-actions">',
      '<button type="button" class="ld-btn" data-act="refresh" title="立即刷新（快捷键 R）">刷新</button>',
      '<button type="button" class="ld-btn" data-act="pause" title="暂停 / 继续自动刷新（快捷键 P）">暂停</button>',
      '<a class="ld-link" data-act="server" target="_blank" rel="noopener" hidden>实时版</a>',
      '</div>',
      '<div class="ld-note" hidden></div>',
    ].join('');
    document.body.appendChild(dock);

    ui.dot = dock.querySelector('.ld-dot');
    ui.label = dock.querySelector('.ld-label');
    ui.time = dock.querySelector('.ld-time');
    ui.progress = dock.querySelector('.ld-progress i');
    ui.sub = dock.querySelector('.ld-sub');
    ui.metrics = dock.querySelector('.ld-metrics');
    ui.refresh = dock.querySelector('[data-act="refresh"]');
    ui.pause = dock.querySelector('[data-act="pause"]');
    ui.server = dock.querySelector('[data-act="server"]');
    ui.note = dock.querySelector('.ld-note');

    if (SERVER_URL && MODE === 'file') {
      ui.server.href = SERVER_URL;
      ui.server.hidden = false;
    }

    dock.addEventListener('click', function (event) {
      var action = event.target.closest('[data-act]');
      if (!action) return;
      var name = action.getAttribute('data-act');
      if (name === 'refresh') {
        event.preventDefault();
        manualRefresh();
      } else if (name === 'pause') {
        event.preventDefault();
        setPaused(!state.paused);
      }
    });
  }

  function setNote(message, kind) {
    if (!message) {
      ui.note.hidden = true;
      ui.note.className = 'ld-note';
      ui.note.textContent = '';
      return;
    }
    ui.note.hidden = false;
    ui.note.className = 'ld-note show' + (kind ? ' ' + kind : '');
    ui.note.textContent = message;
  }

  function statusOf() {
    if (state.busy) return { key: 'loading', label: '刷新中' };
    if (state.paused) return { key: state.autoPausedForStale ? 'stale' : 'paused', label: '已暂停' };
    if (state.error) return { key: 'error', label: '连接中断' };
    if (MODE === 'file') return AUTO_RELOAD ? { key: 'file', label: '自动重载' } : { key: 'static', label: '静态快照' };
    return { key: 'live', label: '实时' };
  }

  function render() {
    if (!dock) return;
    var status = statusOf();
    var summary = currentSummary();
    var remaining = state.paused ? 0 : Math.max(0, state.nextAt - Date.now());
    var ratio = state.paused ? 0 : Math.max(0, Math.min(1, remaining / INTERVAL));
    var seconds = Math.ceil(remaining / 1000);
    var intervalSeconds = Math.round(INTERVAL / 1000);

    dock.dataset.state = status.key;
    ui.label.textContent = status.label;
    ui.time.textContent = state.lastGeneratedAt ? clock(state.lastGeneratedAt) : '—';
    ui.time.title = state.lastGeneratedAt ? '数据生成时间 ' + new Date(state.lastGeneratedAt).toLocaleString() : '';
    ui.progress.style.width = (ratio * 100).toFixed(1) + '%';
    ui.metrics.textContent = summary.cost + ' · ' + summary.sessions + ' 个会话\n' + summary.tokens + ' tokens';
    ui.metrics.title = [summary.range, summary.unpriced || '所有会话的 token 与费用合计'].filter(Boolean).join('\n');

    if (MODE === 'http') {
      if (state.paused) ui.sub.textContent = '自动刷新已暂停';
      else if (state.busy) ui.sub.textContent = '正在拉取最新数据…';
      else if (state.error) ui.sub.textContent = '连接失败 · 第 ' + state.fails + ' 次重试中';
      else ui.sub.textContent = '每 ' + intervalSeconds + ' 秒自动刷新 · ' + seconds + ' 秒后更新';
    } else if (AUTO_RELOAD) {
      if (state.paused) ui.sub.textContent = state.autoPausedForStale ? '文件未更新 · 自动重载已暂停' : '自动重载已暂停';
      else ui.sub.textContent = '每 ' + intervalSeconds + ' 秒重载 · ' + seconds + ' 秒后重载';
    } else {
      ui.sub.textContent = '静态快照 · 不会自动更新';
    }

    ui.refresh.textContent = MODE === 'file' ? '重载' : '刷新';
    ui.refresh.disabled = state.busy;
    ui.pause.textContent = state.paused ? '继续' : '暂停';

    if (state.error) {
      setNote('无法连接本地服务（' + state.error + '），将自动重试。', 'error');
    } else if (state.autoPausedForStale) {
      setNote(
        '此快照连续 ' + MAX_STALE + ' 次没有更新：浏览器无法自行执行命令。请双击 dsh-cost-live-watch.cmd 启动后台更新，然后点「继续」。',
        '',
      );
    } else if (MODE === 'file' && state.storageBlocked) {
      setNote('浏览器禁止 file:// 页面使用本地存储，自动重载已停用（否则会无限刷新）。请使用 dsh-cost-live.cmd 启动本地实时服务。', '');
    } else if (MODE === 'file' && !AUTO_RELOAD) {
      setNote('file:/// 页面不能直接执行 dsh-cost 命令；需要自动更新请使用 dsh-cost-live.cmd 或 dsh-cost-live-watch.cmd。', '');
    } else if (
      MODE === 'file' &&
      AUTO_RELOAD &&
      !state.paused &&
      state.lastGeneratedAt &&
      Date.now() - state.lastGeneratedAt > 60000
    ) {
      setNote('这份快照生成于 ' + clock(state.lastGeneratedAt) + ' 且已超过 1 分钟未更新。运行 dsh-cost-live-watch.cmd 可保持自动重建。', '');
    } else {
      setNote('');
    }

    document.title = (summary.cost && summary.cost !== '—' ? summary.cost + ' · ' : '') + 'DSH 会话费用';
  }

  /* --------------------------------------------------------------- refresh */

  function applyFragment(html) {
    if (typeof html !== 'string' || html.indexOf('<div class="wrap"') === -1) {
      throw new Error('返回的数据格式不正确');
    }
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var open = openSessionIds();
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var next = parsed.querySelector('.wrap');
    if (!next) throw new Error('返回的数据缺少报告主体');
    var imported = document.importNode(next, true);
    imported.id = 'live-wrap';
    var current = document.getElementById('live-wrap');
    if (!current) throw new Error('页面结构已变化');
    current.replaceWith(imported);
    restoreOpen(open);
    applyView();
    window.scrollTo(0, scrollY);
    window.requestAnimationFrame(function () {
      window.scrollTo(0, scrollY);
    });
  }

  function flashChanged() {
    var card = document.querySelector('.cards .card.money');
    if (card) {
      card.classList.remove('ld-flash');
      void card.offsetWidth; /* restart the animation */
      card.classList.add('ld-flash');
      window.setTimeout(function () {
        card.classList.remove('ld-flash');
      }, 1600);
    }
    dock.classList.add('ld-pulse');
    window.setTimeout(function () {
      dock.classList.remove('ld-pulse');
    }, 900);
  }

  function refresh(reason) {
    if (MODE !== 'http' || state.busy) return;
    state.busy = true;
    state.error = null;
    const requestId = ++state.requestId;
    render();

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = window.setTimeout(function () {
      if (controller) controller.abort();
    }, 15000);
    var url = ENDPOINT + (ENDPOINT.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();

    window
      .fetch(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (payload) {
        if (requestId !== state.requestId) return;
        var before = currentSummary();
        if (payload.html !== state.lastHtml) {
          applyFragment(payload.html);
          state.lastHtml = payload.html;
        }
        state.busy = false;
        state.error = null;
        state.fails = 0;
        state.lastGeneratedAt = typeof payload.generatedAt === 'number' ? payload.generatedAt : Date.now();
        state.nextAt = Date.now() + INTERVAL;
        window.clearTimeout(timeout);
        var after = currentSummary();
        if (before.cost !== after.cost || before.tokens !== after.tokens || before.sessions !== after.sessions) {
          flashChanged();
        }
        state.lastCost = after.cost;
        render();
      })
      .catch(function (error) {
        window.clearTimeout(timeout);
        if (requestId !== state.requestId) return;
        state.busy = false;
        state.fails += 1;
        state.error = error && error.name === 'AbortError' ? '请求超时' : (error && error.message) || '网络错误';
        state.nextAt = Date.now() + INTERVAL;
        render();
        if (!state.paused) {
          window.clearTimeout(state.retryTimer);
          state.retryTimer = window.setTimeout(function () {
            if (!state.paused) refresh('retry');
          }, Math.min(10000, 1500 * state.fails));
        }
      });
  }

  function reloadFile() {
    rememberState();
    writeStore('generatedAt', state.lastGeneratedAt);
    writeStore('staleCount', state.staleCount);
    writeStore('paused', state.paused);
    writeStore('cost', currentCost());
    window.location.reload();
  }

  function manualRefresh() {
    if (MODE === 'http') {
      window.clearTimeout(state.retryTimer);
      state.fails = 0;
      refresh('manual');
      return;
    }
    if (state.autoPausedForStale) {
      state.autoPausedForStale = false;
      state.staleCount = 0;
      writeStore('staleCount', 0);
    }
    reloadFile();
  }

  function setPaused(paused) {
    state.paused = paused;
    state.error = null;
    state.fails = 0;
    state.busy = false;
    state.requestId += 1;
    window.clearTimeout(state.retryTimer);

    if (paused) {
      state.nextAt = 0;
      writeStore('paused', true);
      render();
      return;
    }

    if (state.autoPausedForStale) {
      state.autoPausedForStale = false;
      state.staleCount = 0;
      writeStore('staleCount', 0);
      writeStore('paused', false);
      reloadFile();
      return;
    }

    writeStore('paused', false);
    if (MODE === 'http') {
      refresh('resume');
    } else {
      state.nextAt = AUTO_RELOAD ? Date.now() + INTERVAL : 0;
      render();
    }
  }

  function tick() {
    if (!state.paused && !state.busy) {
      if (MODE === 'http') {
        if (state.nextAt && Date.now() >= state.nextAt) refresh('auto');
      } else if (AUTO_RELOAD && state.nextAt && Date.now() >= state.nextAt) {
        reloadFile();
      }
    }
    render();
  }

  /* ------------------------------------------------------------------- boot */

  function bootHttp() {
    var open = readStore('open', []);
    state.showAll = readStore('showAll', false) === true;
    state.range = readRange();
    state.view = readView();
    restoreOpen(open);
    applyView();
    restoreScroll();
    state.lastCost = currentCost();
    state.nextAt = Date.now() + INTERVAL;
    render();
  }

  function bootFile() {
    var previousGeneratedAt = readStore('generatedAt', null);
    var savedPaused = readStore('paused', false) === true;
    var previousCost = readStore('cost', null);
    var open = readStore('open', []);
    state.showAll = readStore('showAll', false) === true;
    state.range = readRange();
    state.view = readView();
    restoreOpen(open);
    applyView();
    restoreScroll();

    if (previousGeneratedAt !== null && previousGeneratedAt === state.lastGeneratedAt) {
      state.staleCount = (Number(readStore('staleCount', 0)) || 0) + 1;
    } else {
      state.staleCount = 0;
    }
    writeStore('generatedAt', state.lastGeneratedAt);
    writeStore('staleCount', state.staleCount);

    if (state.staleCount >= MAX_STALE) {
      state.paused = true;
      state.autoPausedForStale = true;
    } else {
      state.paused = savedPaused;
    }

    state.lastCost = currentCost();
    state.nextAt = AUTO_RELOAD ? Date.now() + INTERVAL : 0;
    if (previousCost && previousCost !== state.lastCost) flashChanged();
    render();
    if (state.staleCount >= MAX_STALE) writeStore('paused', true);
  }

  function bindEvents() {
    document.addEventListener('click', function (event) {
      var rangeButton = event.target.closest ? event.target.closest('.range-btn') : null;
      if (rangeButton) {
        event.preventDefault();
        setRange(rangeButton.getAttribute('data-range'));
        return;
      }
      var viewButton = event.target.closest ? event.target.closest('.view-btn') : null;
      if (viewButton) {
        event.preventDefault();
        setView(viewButton.getAttribute('data-view'));
        return;
      }
      var toggle = event.target.closest ? event.target.closest('[data-sessions-toggle]') : null;
      if (toggle) {
        event.preventDefault();
        setShowAll(!state.showAll);
        return;
      }
      var row = event.target.closest ? event.target.closest('tr.session, tr.day') : null;
      if (!row) return;
      if (event.target.closest('a, button')) return;
      var detail = document.getElementById(row.getAttribute('data-target'));
      if (!detail) return;
      detail.classList.toggle('open');
      writeStore('open', openSessionIds());
    });

    document.addEventListener('keydown', function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      var target = event.target || {};
      var tag = String(target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) return;
      if (event.key === 'r' || event.key === 'R') manualRefresh();
      if (event.key === 'p' || event.key === 'P') setPaused(!state.paused);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        state.hiddenAt = Date.now();
        return;
      }
      var hiddenFor = state.hiddenAt ? Date.now() - state.hiddenAt : 0;
      state.hiddenAt = null;
      if (state.paused) {
        render();
        return;
      }
      if (MODE === 'http') {
        var age = state.lastGeneratedAt ? Date.now() - state.lastGeneratedAt : INTERVAL + 1;
        if (hiddenFor > 0 && age >= INTERVAL) refresh('visible');
        else state.nextAt = Date.now() + INTERVAL;
      } else if (AUTO_RELOAD && hiddenFor > 0) {
        state.nextAt = Date.now() + INTERVAL;
      } else if (MODE === 'file' && !AUTO_RELOAD) {
        state.nextAt = 0;
      }
      render();
    });

    window.addEventListener('beforeunload', function () {
      if (MODE === 'file') rememberState();
    });
  }

  function boot() {
    if (MODE === 'file' && AUTO_RELOAD && !storageWorks()) {
      AUTO_RELOAD = false;
      state.storageBlocked = true;
    }
    buildDock();
    if (MODE === 'file') bootFile();
    else bootHttp();
    bindEvents();
    state.tickTimer = window.setInterval(tick, 200);
    render();
    if (MODE === 'http' && state.lastGeneratedAt && Date.now() - state.lastGeneratedAt > INTERVAL) {
      refresh('boot');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
