/* Shared settings handler for live and static reports. Never writes DSH data. */
(function () {
  if (window.__DSH_BILLING_BOUND__) return;
  window.__DSH_BILLING_BOUND__ = true;
  function messages() { return (window.__DSH_LIVE__ || window.__DSH_I18N__ || {}).messages || {}; }
  function tr(key, params) { var text = messages()[key] || key; return text.replace(/\{(\w+)\}/g, function (_, name) { return params && params[name] !== undefined ? params[name] : ''; }); }
  function download(name, text, type) { var url = URL.createObjectURL(new Blob([text], { type: type })); var a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }
  function showSaveScope() {
    if (!window.__DSH_LIVE__ || window.__DSH_LIVE__.mode !== 'http') { var note = document.querySelector('[data-billing-message]'); if (note) note.textContent = tr('billing.static'); }
  }
  showSaveScope();
  function formConfig(form) {
    var config = { mode: form.elements['billing-mode'].value, timeZone: 'Asia/Shanghai', subscriptions: {} };
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
  document.addEventListener('click', function (event) {
    var add = event.target.closest('[data-billing-add]');
    if (add) { var group = add.closest('fieldset'); var row = group.querySelector('[data-billing-row]'); if (row) { var next = row.cloneNode(true); next.querySelectorAll('input').forEach(function (input) { input.value = ''; }); group.querySelector('[data-billing-history]').appendChild(next); } }
    var remove = event.target.closest('[data-billing-remove]');
    if (remove) { var rows = remove.closest('fieldset').querySelectorAll('[data-billing-row]'); if (rows.length > 1) remove.closest('[data-billing-row]').remove(); else rows[0].querySelectorAll('input').forEach(function (input) { input.value = ''; }); }
    if (event.target.closest('[data-billing-export]')) { try { download('costlive-billing.json', JSON.stringify(formConfig(document.getElementById('billing-form')), null, 2), 'application/json'); } catch (error) { document.querySelector('[data-billing-message]').textContent = error.message; } }
    var output = event.target.closest('[data-real-export]');
    if (output && window.__DSH_REAL_VIEW__) {
      var report = window.__DSH_REAL_VIEW__;
      if (output.dataset.realExport === 'json') download('costlive-real.json', JSON.stringify(report, null, 2), 'application/json');
      else { var rows = [['billing_mode','time_zone','from','until','provider','input_tokens','output_tokens','cache_write_tokens','cache_read_tokens','cost_cny','cost_usd','idle_usd','usd_per_million_tokens','configured']]; report.providers.concat([Object.assign({provider:'TOTAL'},report.summary)]).forEach(function (r) { rows.push(['real',report.timeZone,report.from || '',report.until,r.provider,r.tokens.uncachedInputTokens,r.tokens.outputTokens,r.tokens.cacheWriteTokens,r.tokens.cacheReadTokens,(r.costMicroCny/1e6).toFixed(6),(r.costMicroUsd/1e6).toFixed(6),(r.idleMicroUsd/1e6).toFixed(6),r.tokenPrice.usdMicroPerM === null ? '' : (r.tokenPrice.usdMicroPerM/1e6).toFixed(6),r.configured]); }); download('costlive-real.csv','\uFEFF' + rows.map(function (row) { return row.map(function (v) { return '"' + String(v).replace(/"/g,'""') + '"'; }).join(','); }).join('\r\n') + '\r\n','text/csv;charset=utf-8'); }
    }
  });
  document.addEventListener('change', async function (event) {
    if (!event.target.matches('[data-billing-import]')) return;
    try {
      var file = event.target.files[0]; if (!file || file.size > 65536) throw new Error('Invalid configuration file');
      var config = JSON.parse(await file.text()); var form = document.getElementById('billing-form');
      form.elements['billing-mode'].value = config.mode;
      form.querySelectorAll('[data-billing-provider]').forEach(function (group) {
        var history = config.subscriptions[group.dataset.billingProvider]; if (!Array.isArray(history) || !history.length || history.length > 200) throw new Error('Invalid subscription history');
        var container = group.querySelector('[data-billing-history]'); var template = container.querySelector('[data-billing-row]').cloneNode(true); container.replaceChildren();
        history.forEach(function (entry) { var row = template.cloneNode(true); row.querySelector('[data-effective]').value = entry.effectiveFrom; row.querySelector('[data-monthly]').value = entry.monthlyUsd; container.appendChild(row); });
      });
    } catch (error) { document.querySelector('[data-billing-message]').textContent = tr('billing.failed', {error:error.message}); }
  });
  document.addEventListener('submit', async function (event) {
    if (event.target.id !== 'billing-form') return;
    event.preventDefault(); var form = event.target; var message = form.querySelector('[data-billing-message]');
    if (!window.__DSH_LIVE__ || window.__DSH_LIVE__.mode !== 'http') { message.textContent = tr('billing.static'); return; }
    try {
      var config = formConfig(form);
      var response = await fetch('/api/billing', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CostLive-Settings': '1' }, body: JSON.stringify(config) });
      var answer = await response.json(); if (!response.ok) throw new Error(answer.error || response.status);
      message.textContent = tr('billing.saved'); location.reload();
    } catch (error) { message.textContent = tr('billing.failed', {error:error.message}); }
  });
})();
