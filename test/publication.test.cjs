'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('public package, patch and generated client use the same owned npm name', () => {
  assert.equal(pkg.name, '@leonchan2840/dsh-quick-model-panel');
  assert.equal(pkg.private, undefined);
  const names = [...read('cordis.patch.yml').matchAll(/name:\s*'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(names, [pkg.name]);
  let descriptor;
  vm.runInNewContext(read('client.js'), { window: { __ModuleLoader__: { load: value => { descriptor = value; } } } });
  assert.equal(descriptor.id, pkg.name);
  // 只核对模块描述符，不伪造宿主 React 或执行实际 UI。
  assert.equal(typeof descriptor.factory, 'function');
});

test('build reads the manifest name instead of baking a local package scope into the loader', () => {
  const renamed = '@example/dsh-quick-model-panel';
  const virtualFs = { readFileSync(file, encoding) {
    if (path.resolve(file) === path.join(root, 'package.json')) return JSON.stringify({ ...pkg, name: renamed });
    return fs.readFileSync(file, encoding);
  } };
  const loaded = { exports: {} };
  const requireModule = name => {
    if (name === 'node:fs') return virtualFs;
    if (name === 'node:path') return path;
    throw new Error('Unexpected build dependency: ' + name);
  };
  vm.runInNewContext(read('build.cjs'), { require: requireModule, module: loaded, __dirname: root });
  const result = loaded.exports.buildClient();
  assert.ok(result.includes('id: ' + JSON.stringify(renamed)));
  assert.ok(!result.includes('@local/dsh-quick-model-panel'));
});

test('release includes real screenshot resources and no installation lifecycle scripts or dependencies', () => {
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/');
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[name], undefined);
  assert.equal(pkg.dependencies, undefined);
  for (const file of ['model-panel-overview.png', 'quick-panel.png']) {
    const relative = 'docs/images/' + file;
    const bytes = fs.readFileSync(path.join(root, relative));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(read('README.md').includes('./' + relative));
  }
  for (const name of ['README.md', 'SECURITY.md']) assert.ok(!read(name).includes('保留 `private: true`'));
});
