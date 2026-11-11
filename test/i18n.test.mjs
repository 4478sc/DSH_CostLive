import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, MESSAGES, i18nText, localeFromAcceptLanguage, normalizeLocale, t } from '../src/i18n.mjs';

test('normalizeLocale accepts tags, regions and odd casing', () => {
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('EN-us'), 'en');
  assert.equal(normalizeLocale('en_GB'), 'en');
  assert.equal(normalizeLocale('zh-CN'), 'zh');
  assert.equal(normalizeLocale('zh'), 'zh');
  assert.equal(normalizeLocale('fr'), 'zh', 'unknown locales fall back to the default');
  assert.equal(normalizeLocale(''), 'zh');
  assert.equal(normalizeLocale(null), 'zh');
});

test('localeFromAcceptLanguage picks the highest-weighted supported tag', () => {
  assert.equal(localeFromAcceptLanguage('en-US,en;q=0.9,zh;q=0.8'), 'en');
  assert.equal(localeFromAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8'), 'zh');
  assert.equal(localeFromAcceptLanguage('fr-FR,fr;q=0.9'), 'zh');
  assert.equal(localeFromAcceptLanguage(''), 'zh');
});

test('i18nText substitutes placeholders and keeps unknown ones', () => {
  assert.equal(i18nText({ a: 'x {n} y' }, 'a', { n: 3 }), 'x 3 y');
  assert.equal(i18nText({ a: 'x {n} y' }, 'a', {}), 'x {n} y');
  assert.equal(i18nText({}, 'missing'), 'missing', 'a missing key is visible, never silent');
});

test('every locale defines the same keys and placeholders', () => {
  const reference = MESSAGES[LOCALES[0]];
  for (const locale of LOCALES.slice(1)) {
    const other = MESSAGES[locale];
    assert.deepEqual(Object.keys(other).sort(), Object.keys(reference).sort(), locale + ' key set');
    for (const key of Object.keys(reference)) {
      const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      assert.equal(placeholders(other[key]), placeholders(reference[key]), locale + ' placeholders for ' + key);
    }
  }
});

test('t() falls back to Chinese for unknown locales', () => {
  assert.equal(t('fr', 'card.cost'), MESSAGES.zh['card.cost']);
  assert.equal(t('en', 'card.cost'), 'Total cost');
});
