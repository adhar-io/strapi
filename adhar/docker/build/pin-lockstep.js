'use strict';

/**
 * Keep every lockstep @strapi/* package at the project's Strapi version.
 *
 *   node pin-lockstep.js <version> pin    write npm overrides for drifted packages
 *   node pin-lockstep.js <version> check  fail if any drift remains
 *
 * Strapi's plugins declare @strapi/admin, @strapi/data-transfer and friends as
 * `^5.0.0` PEER dependencies, so npm hoists the newest 5.x next to the copies
 * the pinned packages nest. A create-strapi@5.57.0 project ends up running
 * @strapi/admin, utils and types 5.59.0 alongside 5.57.0. Two copies of
 * @strapi/utils break its error classes' `instanceof`, so a 403 from
 * users-permissions is answered as a 500.
 *
 * "Lockstep" is read from the tree rather than from a list: any @strapi/*
 * package that has a copy at <version> is one. Design-system packages
 * (@strapi/design-system, icons, ui-primitives) are versioned separately and
 * never match, so they are left alone.
 */
const fs = require('fs');
const path = require('path');

const [version, mode] = process.argv.slice(2);
if (!version || !['pin', 'check'].includes(mode)) {
  console.error('usage: pin-lockstep.js <version> pin|check');
  process.exit(64);
}

const root = process.cwd();
const versions = new Map(); // name -> Map(version -> [paths])

const record = (dir) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (!pkg.name || !pkg.name.startsWith('@strapi/')) return;
  if (!versions.has(pkg.name)) versions.set(pkg.name, new Map());
  const byVersion = versions.get(pkg.name);
  if (!byVersion.has(pkg.version)) byVersion.set(pkg.version, []);
  byVersion.get(pkg.version).push(path.relative(root, dir));
};

const walk = (modules) => {
  if (!fs.existsSync(modules)) return;
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dirs = entry.name.startsWith('@')
      ? fs
          .readdirSync(path.join(modules, entry.name), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(modules, entry.name, e.name))
      : [path.join(modules, entry.name)];
    for (const dir of dirs) {
      if (fs.existsSync(path.join(dir, 'package.json'))) record(dir);
      walk(path.join(dir, 'node_modules'));
    }
  }
};

walk(path.join(root, 'node_modules'));

const drifted = [...versions]
  .filter(([, byVersion]) => byVersion.has(version) && byVersion.size > 1)
  .map(([name, byVersion]) => ({
    name,
    others: [...byVersion].filter(([v]) => v !== version),
  }));

if (mode === 'check') {
  if (drifted.length === 0) {
    const lockstep = [...versions].filter(([, v]) => v.has(version)).length;
    console.log(`lockstep: ${lockstep} @strapi packages, all at ${version}`);
    process.exit(0);
  }
  for (const { name, others } of drifted) {
    for (const [v, paths] of others) console.error(`drift: ${name}@${v} at ${paths.join(', ')}`);
  }
  process.exit(1);
}

// pin: an override must not contradict a direct dependency's spec, and those
// are already exact, so only transitive packages are written.
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const direct = new Set(Object.keys(pkg.dependencies || {}));
pkg.overrides = pkg.overrides || {};
for (const { name, others } of drifted) {
  if (direct.has(name) || pkg.overrides[name]) continue;
  pkg.overrides[name] = version;
  console.log(`pin: ${name} ${others.map(([v]) => v).join(', ')} -> ${version}`);
}
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
