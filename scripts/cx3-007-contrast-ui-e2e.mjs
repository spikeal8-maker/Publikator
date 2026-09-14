import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const css = await fs.readFile(new URL('../public/theme-v3.css', import.meta.url), 'utf8');
const darkCss = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
function color(source, name) {
  const match = source.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `missing ${name}`);
  return match[1];
}
function rgb(hex) { return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255); }
function luminance(hex) {
  return rgb(hex).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a, b) { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); }
assert.ok(contrast(color(css, '--text-primary'), color(css, '--bg')) >= 7, 'light primary contrast');
assert.ok(contrast(color(css, '--text-secondary'), color(css, '--surface')) >= 4.5, 'light secondary contrast');
assert.ok(contrast(color(darkCss, '--text-primary'), color(darkCss, '--bg')) >= 7, 'dark primary contrast');
assert.ok(contrast(color(darkCss, '--text-secondary'), color(darkCss, '--surface')) >= 4.5, 'dark secondary contrast');
for (const marker of ['--success', '--warning', '--danger', '.badge.PUBLISHED::before', '.badge.FAILED::before', ':focus-visible']) assert.ok(css.includes(marker), `theme marker missing: ${marker}`);

const dashboardSource = await fs.readFile(new URL('../public/dashboard-v3.js', import.meta.url), 'utf8');
for (const marker of ['Сегодня', '7 дней', 'Нужно проверить', 'Проблемы', 'status-chip', '.open-post']) assert.ok(dashboardSource.includes(marker), `dashboard marker missing: ${marker}`);
const dashboardCss = await fs.readFile(new URL('../public/dashboard-v3.css', import.meta.url), 'utf8');
for (const marker of ['dashboard-v3-metrics', 'dashboard-v3-attention', 'status-chip', '@media (max-width: 620px)']) assert.ok(dashboardCss.includes(marker), `dashboard css marker missing: ${marker}`);
const index = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
assert.ok(index.includes('/theme-v3.css'));
assert.ok(index.includes('/dashboard-v3.css'));
assert.ok(index.includes('/dashboard-v3.js'));
console.log('CX3-007 contrast UI: PASS');
