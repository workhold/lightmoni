import test from 'node:test';
import assert from 'node:assert/strict';
import { billingPayload, billingIsDirty, modelIdentity, validUsagePage, recentDaily, calendarDate, validPrice, tokenCount, costAmount, timezoneChoices, usageDateRange, usageSource } from './model-management.ts';

const billing = { base_url: 'https://provider.example/v1', protocol: 'anthropic-messages', model: 'fixture', currency: 'CNY', input_price_per_million: 3, output_price_per_million: 12 };

test('billing keeps the loaded connection identity and distinguishes free from missing prices', () => {
  assert.deepEqual(billingPayload(billing, { currency: 'USD', input_price_per_million: 0 }), {
    base_url: billing.base_url, protocol: billing.protocol, model: billing.model, currency: 'USD', input_price_per_million: 0, output_price_per_million: null,
  });
  assert.equal(billingPayload(billing, { currency: 'CNY', input_price_per_million: null, output_price_per_million: 1.25 }).input_price_per_million, null);
});

test('price validation accepts explicit zero or unset and rejects invalid billable values', () => {
  for (const value of [null, undefined, 0, 0.000001, 1e9]) assert.equal(validPrice(value), true);
  for (const value of [-1, NaN, Infinity, 1e9 + 1, '0', '']) assert.equal(validPrice(value), false);
});

test('dirty pricing compares currency and nullable prices independently of execution limits', () => {
  const values = { currency: 'CNY', input_price_per_million: 3, output_price_per_million: 12 };
  assert.equal(billingIsDirty(billing, values), false);
  assert.equal(billingIsDirty(billing, { ...values, input_price_per_million: 9.99 }), true);
  assert.equal(billingIsDirty(billing, { ...values, currency: 'USD' }), true);
  assert.equal(billingIsDirty({ ...billing, input_price_per_million: null }, { ...values, input_price_per_million: undefined }), false);
  assert.equal(billingIsDirty({ ...billing, input_price_per_million: null }, { ...values, input_price_per_million: 0 }), true);
  assert.equal(modelIdentity({ ...billing, max_steps: 2 }), modelIdentity({ ...billing, max_steps: 8 }));
  assert.notEqual(modelIdentity(billing), modelIdentity({ ...billing, model: 'other' }));
  assert.notEqual(modelIdentity(billing), modelIdentity({ ...billing, protocol: 'openai-responses' }));
  assert.equal(modelIdentity(), '');
});

test('daily order is recent first without changing API data and pagination remains valid', () => {
  const daily = [{ date: '2026-10-15' }, { date: '2026-10-17' }, { date: '2026-10-16' }];
  assert.deepEqual(recentDaily(daily).map(row => row.date), ['2026-10-17', '2026-10-16', '2026-10-15']);
  assert.equal(daily[0].date, '2026-10-15');
  assert.equal(validUsagePage(2, 24), 2);
  assert.equal(validUsagePage(3, 11), 2);
  assert.equal(validUsagePage(2, 0), 1);
  assert.equal(validUsagePage(0, 30), 1);
  assert.equal(calendarDate(new Date('2026-10-17T23:30:00Z'), 'Asia/Shanghai'), '2026-10-18');
  assert.equal(calendarDate(new Date('2026-10-17T23:30:00Z'), 'America/Los_Angeles'), '2026-10-17');
});

test('missing token reports are unknown while known zero and partial sums stay distinct', () => {
  assert.equal(tokenCount(0, 2, 2), '未知');
  assert.equal(tokenCount(0, 0, 2), '0');
  assert.equal(tokenCount(1234, 1, 3), '1,234');
  assert.equal(tokenCount(0, 0, 0), '0');
});

test('small nonzero estimates cannot be mistaken for a free call', () => {
  assert.equal(costAmount(0), '0.00');
  assert.equal(costAmount(1.234567), '1.234567');
  assert.equal(costAmount(0.00000001), '< 0.000001');
});

test('calendar ranges include the last day in the selected timezone and support browser zone choices', () => {
  assert.equal(usageDateRange('2026-10-10T16:00:00Z', '2026-10-17T16:00:00Z', 'Asia/Shanghai'), '2026/10/11 至 2026/10/17');
  assert.equal(usageDateRange('invalid', 'invalid', 'UTC'), '');
  const choices = timezoneChoices('Asia/Kathmandu');
  assert.ok(choices.some(choice => choice.value === 'Asia/Kathmandu'));
  assert.ok(choices.some(choice => choice.value === 'UTC'));
  assert.equal(new Set(choices.map(choice => choice.value)).size, choices.length);
});

test('usage labels distinguish assistant and explicit connection tests', () => {
  assert.match(usageSource('assistant'), /历史整理/);
  assert.equal(usageSource('connection-test'), '连接测试');
  assert.equal(usageSource(''), '未知来源');
});

test('English usage display preserves unknown values and partial accounting semantics', () => {
  assert.equal(tokenCount(0, 1, 1, 'en-US'), 'Unknown');
  assert.equal(tokenCount(0, 0, 1, 'en-US'), '0');
  assert.equal(tokenCount(1234, 1, 2, 'en-US'), '1,234');
  assert.equal(costAmount(1e-9, 'en-US'), '< 0.000001');
  assert.equal(usageSource('connection-test', 'en-US'), 'Connection test');
  assert.equal(usageSource('custom-provider-source', 'en-US'), 'custom-provider-source');
  assert.equal(usageSource('', 'en-US'), 'Unknown source');
  assert.equal(usageDateRange('2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z', 'UTC', 'en-US'), '10/01/2026 to 10/02/2026');
  assert.equal(tokenCount(0, 1, 1), '未知');
});
