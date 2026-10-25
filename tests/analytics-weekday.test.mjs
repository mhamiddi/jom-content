import test from 'node:test';
import assert from 'node:assert/strict';
import { weekdayAverages } from '../analytics-weekday.mjs';

test('groups visible post views by local weekday and returns Monday-first averages', () => {
  const result = weekdayAverages([
    { date: '2026-10-19', views: 100, views_missing: false },
    { date: '2026-10-26', views: 300, views_missing: false },
    { date: '2026-10-20', views: 200, views_missing: false },
    { date: '2026-10-24', views: 800, views_missing: false },
    { date: '2026-10-25', views: 999, views_missing: true },
  ]);

  assert.deepEqual(result.map(({ key, label, items, views, avgViews }) => ({ key, label, items, views, avgViews })), [
    { key: 'mon', label: 'Isn', items: 2, views: 400, avgViews: 200 },
    { key: 'tue', label: 'Sel', items: 1, views: 200, avgViews: 200 },
    { key: 'wed', label: 'Rab', items: 0, views: 0, avgViews: null },
    { key: 'thu', label: 'Kha', items: 0, views: 0, avgViews: null },
    { key: 'fri', label: 'Jum', items: 0, views: 0, avgViews: null },
    { key: 'sat', label: 'Sab', items: 1, views: 800, avgViews: 800 },
    { key: 'sun', label: 'Ahd', items: 0, views: 0, avgViews: null },
  ]);
});
