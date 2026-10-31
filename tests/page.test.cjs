'use strict';
// Static checks on the shipped page: it parses, every element the controller uses exists,
// every pictogram exists, and nothing user-visible talks about syncing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const template = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');

test('页面脚本都能解析，构建产物包含全部模块', () => {
  const scripts = [...html.matchAll(/<script id="([^"]+)">([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map(m => m[1]), ['rehab-voice', 'rehab-core', 'rehab-audio', 'rehab-store', 'rehab-app']);
  for (const [, name, source] of scripts) new vm.Script(source, { filename: name });
  assert.ok(!html.includes('/* BUILD:'));
});

test('控制器用到的元素都存在', () => {
  const ids = new Set([...template.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]));
  for (const name of ["home", "prep", "run", "hold", "between", "done", "records"]) used.add(name);
  const missing = [...used].filter(id => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('每个动作都有示意图符号', () => {
  const context = vm.createContext({ Date, Intl });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/core.js'), 'utf8'), context);
  const arts = Object.values(context.RehabCore.PLANS).flatMap(plan => plan.items.map(item => item.art));
  for (const art of arts) assert.ok(template.includes(`id="art-${art}"`), art);
  const images = Object.values(context.RehabCore.PLANS).flatMap(plan => plan.items.map(item => item.image)).filter(Boolean);
  assert.equal(images.length, 5, '双腿关节训练五项都有示意图');
  for (const image of images) {
    const file = path.join(root, image);
    assert.ok(fs.existsSync(file), image);
    assert.ok(fs.statSync(file).size < 200 * 1024, `${image} 不超过 200 KB`);
  }
});

test('界面文字不出现同步、云端、口令、登录', () => {
  const visible = template.replace(/<!--[\s\S]*?-->/g, '').replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script[\s\S]*?<\/script>/g, '');
  const strings = [...app.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2]).join('\n');
  for (const word of ['同步', '云端', '口令', '登录', '冲突', '接管']) {
    assert.ok(!visible.includes(word), `template: ${word}`);
    assert.ok(!strings.includes(word), `app.js: ${word}`);
  }
});
