/* Shared billing controls. Mode switches never save unsaved price-history edits. */
(function () {
  if (window.__DSH_BILLING_BOUND__) return;
  window.__DSH_BILLING_BOUND__ = true;
  var switching = false;
  var DAY = /^\d{4}-\d{2}-\d{2}$/;
  function messages() { return (window.__DSH_LIVE__ || window.__DSH_I18N__ || {}).messages || {}; }
  function tr(key, params) { var text = messages()[key] || key; return text.replace(/\{(\w+)\}/g, function (_, name) { return params && params[name] !== undefined ? params[name] : ''; }); }
  function savedConfig() { return JSON.parse(document.getElementById('dsh-cost-data').textContent).billing.config; }
  function live() { return window.__DSH_LIVE__ && window.__DSH_LIVE__.mode === 'http'; }
  /** Amount paid for one period, or null when the field is empty, or NaN when it is not a valid cents value. */
  function amountOf(row) {
    var raw = row.querySelector('[data-monthly]').value;
    if (raw === '') return null;
    var value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) return NaN;
    return value;
  }
  function setHint(hint, bad, text) {
    hint.textContent = text || '';
    hint.classList.toggle('billing-period-bad', bad === true);
  }
  /** Recompute each row's covered days with the server's own period rules (shared through window.DSH_BILLING). */
  function refreshPeriods(group) {
    if (!group) return;
    var entries = [];
    Array.prototype.forEach.call(group.querySelectorAll('[data-billing-row]'), function (row) {
      var date = row.querySelector('[data-effective]');
      var hint = row.querySelector('[data-billing-period]');
      if (!date || !hint) return;
      entries.push({ date: DAY.test(date.value) ? date.value : '', amount: amountOf(row), hint: hint });
    });
    var usable = entries.filter(function (entry) { return entry.date !== '' && entry.amount !== null && !Number.isNaN(entry.amount); });
    var api = window.DSH_BILLING;
    var texts = [];
    if (usable.length && api && typeof api.periods === 'function') {
      var seen = Object.create(null);
      var duplicate = false;
      usable.forEach(function (entry) { if (seen[entry.date]) duplicate = true; seen[entry.date] = true; });
      if (duplicate) {
        usable.forEach(function (entry) { texts.push({ bad: true, text: tr('billing.duplicate') }); });
      } else {
        var sorted = usable.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
        var periods = api.periods(sorted.map(function (entry) { return { effectiveFrom: entry.date, monthlyUsd: entry.amount }; }));
        var byStart = Object.create(null);
        periods.forEach(function (period) { byStart[period.start] = period; });
        usable.forEach(function (entry) {
          var period = byStart[entry.date];
          texts.push(period && period.days >= 1 ? { bad: false, text: tr('billing.period', { from: period.start, to: period.end, days: period.days, expires: period.expiresOn }) } : { bad: true, text: tr('billing.needDate') });
        });
      }
    }
    if (texts.length === usable.length) usable.forEach(function (entry, index) { setHint(entry.hint, texts[index].bad, texts[index].text); });
    entries.forEach(function (entry) { if (usable.indexOf(entry) === -1) setHint(entry.hint, false, ''); });
  }
  function refreshAll() { Array.prototype.forEach.call(document.querySelectorAll('[data-billing-provider]'), refreshPeriods); }
  function formConfig(form) {
    var config = { mode: savedConfig().mode, timeZone: 'Asia/Shanghai', subscriptions: {} };
    form.querySelectorAll('[data-billing-provider]').forEach(function (group) {
      var seen = Object.create(null);
      config.subscriptions[group.dataset.billingProvider] = Array.from(group.querySelectorAll('[data-billing-row]')).map(function (row) {
        var date = row.querySelector('[data-effective]').value;
        var raw = row.querySelector('[data-monthly]').value;
        if (!date && raw === '') return null;
        if (!DAY.test(date)) throw new Error(tr('billing.needDate'));
        if (seen[date]) throw new Error(tr('billing.duplicate'));
        seen[date] = true;
        var amount = amountOf(row);
        if (amount === null || Number.isNaN(amount)) throw new Error(tr('billing.needAmount'));
        return { effectiveFrom: date, monthlyUsd: amount };
      }).filter(Boolean);
    });
    return config;
  }
  async function write(path, value) {
    var response = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CostLive-Settings': '1' }, body: JSON.stringify(value) });
    var answer = await response.json(); if (!response.ok) throw new Error(answer.error || response.status);
    return answer;
  }
  document.addEventListener('input', function (event) {
    var group = event.target.closest && event.target.closest('[data-billing-provider]');
    if (group) refreshPeriods(group);
  });
  document.addEventListener('click', async function (event) {
    var add = event.target.closest('[data-billing-add]');
    if (add) { var group = add.closest('fieldset'); var row = group.querySelector('[data-billing-row]'); if (row) { var next = row.cloneNode(true); next.querySelectorAll('input').forEach(function (input) { input.value = ''; }); group.querySelector('[data-billing-history]').appendChild(next); refreshPeriods(group); } }
    var remove = event.target.closest('[data-billing-remove]');
    if (remove) {
      var rows = remove.closest('fieldset').querySelectorAll('[data-billing-row]');
      if (rows.length > 1) remove.closest('[data-billing-row]').remove();
      else rows[0].querySelectorAll('input').forEach(function (input) { input.value = ''; });
      refreshPeriods(remove.closest('fieldset'));
    }
    var button = event.target.closest('[data-billing-mode]');
    if (!button || switching) return;
    var message = document.querySelector('[data-billing-mode-message]');
    if (!live()) { message.textContent = tr('billing.static'); return; }
    var mode = button.dataset.billingMode;
    if (mode === savedConfig().mode) return;
    switching = true;
    document.querySelectorAll('[data-billing-mode]').forEach(function (node) { node.disabled = true; });
    try {
      var answer = await write('/api/billing/mode', { mode: mode, locale: window.__DSH_LIVE__.locale });
      window.dispatchEvent(new CustomEvent('dsh-billing-updated', { detail: answer.fragment }));
    } catch (error) {
      message.textContent = tr('billing.failed', { error: error.message });
      var editor = document.getElementById('billing-settings');
      if (mode === 'real' && editor) editor.open = true;
    } finally {
      switching = false;
      document.querySelectorAll('[data-billing-mode]').forEach(function (node) { node.disabled = false; });
    }
  });
  document.addEventListener('submit', async function (event) {
    if (event.target.id !== 'billing-form') return;
    event.preventDefault(); var form = event.target; var message = form.querySelector('[data-billing-message]');
    if (!live()) { message.textContent = tr('billing.static'); return; }
    try {
      await write('/api/billing', formConfig(form));
      message.textContent = tr('billing.saved'); location.reload();
    } catch (error) { message.textContent = tr('billing.failed', { error: error.message }); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshAll); else refreshAll();
})();
