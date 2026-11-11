/* Shared billing controls. Mode switches never save unsaved price-history edits. */
(function () {
  if (window.__DSH_BILLING_BOUND__) return;
  window.__DSH_BILLING_BOUND__ = true;
  var switching = false;
  function messages() { return (window.__DSH_LIVE__ || window.__DSH_I18N__ || {}).messages || {}; }
  function tr(key, params) { var text = messages()[key] || key; return text.replace(/\{(\w+)\}/g, function (_, name) { return params && params[name] !== undefined ? params[name] : ''; }); }
  function savedConfig() { return JSON.parse(document.getElementById('dsh-cost-data').textContent).billing.config; }
  function live() { return window.__DSH_LIVE__ && window.__DSH_LIVE__.mode === 'http'; }
  function formConfig(form) {
    var config = { mode: savedConfig().mode, timeZone: 'Asia/Shanghai', subscriptions: {} };
    form.querySelectorAll('[data-billing-provider]').forEach(function (group) {
      config.subscriptions[group.dataset.billingProvider] = Array.from(group.querySelectorAll('[data-billing-row]')).map(function (row) {
        var date = row.querySelector('[data-effective]').value;
        var amount = row.querySelector('[data-monthly]').value;
        if (!date && !amount && config.mode === 'usage') return null;
        if (!date || amount === '') throw new Error(tr('billing.hint'));
        return { effectiveFrom: date, monthlyUsd: Number(amount) };
      }).filter(Boolean);
    });
    return config;
  }
  async function write(path, value) {
    var response = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CostLive-Settings': '1' }, body: JSON.stringify(value) });
    var answer = await response.json(); if (!response.ok) throw new Error(answer.error || response.status);
    return answer;
  }
  document.addEventListener('click', async function (event) {
    var add = event.target.closest('[data-billing-add]');
    if (add) { var group = add.closest('fieldset'); var row = group.querySelector('[data-billing-row]'); if (row) { var next = row.cloneNode(true); next.querySelectorAll('input').forEach(function (input) { input.value = ''; }); group.querySelector('[data-billing-history]').appendChild(next); } }
    var remove = event.target.closest('[data-billing-remove]');
    if (remove) { var rows = remove.closest('fieldset').querySelectorAll('[data-billing-row]'); if (rows.length > 1) remove.closest('[data-billing-row]').remove(); else rows[0].querySelectorAll('input').forEach(function (input) { input.value = ''; }); }
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
})();
