#!/usr/bin/env node
/**
 * install-dev — 把 dsh-bilibili 同步进 DSH 的 desktop profile，并注册为 bundle。
 *
 *   node scripts/install-dev.mjs            # 安装 / 同步
 *   node scripts/install-dev.mjs --remove   # 卸载（还原 package.json）
 *   node scripts/install-dev.mjs --check    # 只检查当前状态，不改动
 *
 * 与 dsh-video-storyboard 的 install-dev.mjs 同一套逻辑：
 * desktop profile 由 Electron 应用独占管理，`dsh plugin --profile desktop ...` 会被拒绝
 * （"managed exclusively by the Electron application"），所以手动复制 + 改 package.json。
 *
 * 复制而不是软链：Node 解析裸包名（`@deepseek-ai/dsh-tools`）用真实路径，
 * 软链会让它从源码目录向上找、找不到宿主的包。
 */

import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
const PKG_NAME = 'dsh-bilibili';
const TARGET = join(PROFILE_DIR, 'node_modules', PKG_NAME);
// .git / test 不进 profile；node_modules 要进（qrcode 是运行时依赖，宿主不会替它装）
const SKIP_TOP = new Set(['.git', 'test', 'assets', '.tmp']);

const mode = process.argv.includes('--remove') ? 'remove'
  : process.argv.includes('--check') ? 'check' : 'install';

if (!existsSync(PROFILE_DIR)) {
  console.error(`profile 不存在：${PROFILE_DIR}`);
  process.exit(2);
}
const pkgPath = join(PROFILE_DIR, 'package.json');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function patchProfile({ add }) {
  const pkg = await readJson(pkgPath);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const hasDep = Object.hasOwn(pkg.dependencies ?? {}, PKG_NAME);

  if (add) {
    if (!hasDep) {
      const backup = join(PROFILE_DIR, `package.json.bak-${new Date().toISOString().replace(/[:.]/g, '-')}-preinstall`);
      await writeFile(backup, await readFile(pkgPath), 'utf8');
      console.log(`已备份 package.json → ${backup}`);
    }
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [PKG_NAME]: `file:${HERE.replace(/\\/g, '/')}` };
    if (!bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles = [...bundles, PKG_NAME];
  } else {
    if (pkg.dependencies) delete pkg.dependencies[PKG_NAME];
    if (pkg.dsh?.profile?.bundles) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME);
    }
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

async function syncFiles() {
  // 旧版本把登录凭证写在插件目录里（.sessdata.json），同步会被 rm 掉 —— 先抢救出来，
  // 装完再放回去，避免每次同步都把登录态冲掉。新版本凭证已移到 DSH_HOME，不受影响。
  const credFile = join(TARGET, '.sessdata.json');
  const qrFile = join(TARGET, '.qr-login.png');
  const savedCred = existsSync(credFile) ? await readFile(credFile, 'utf8') : null;
  const savedQr = existsSync(qrFile) ? await readFile(qrFile) : null;
  await rm(TARGET, { recursive: true, force: true });
  await cp(HERE, TARGET, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(HERE.length).replace(/^[\\/]+/, '');
      const top = rel.split(/[\\/]/)[0];
      return !SKIP_TOP.has(top);
    },
  });
  if (savedCred) {
    await writeFile(credFile, savedCred, 'utf8');
    console.log('已保留插件目录内的旧凭证 .sessdata.json');
  }
  if (savedQr) {
    await writeFile(qrFile, savedQr);
    console.log('已保留插件目录内的旧二维码 .qr-login.png');
  }
}

async function report() {
  const installed = existsSync(TARGET);
  const pkg = await readJson(pkgPath);
  const registered = (pkg.dsh?.profile?.bundles ?? []).includes(PKG_NAME);
  const dep = pkg.dependencies?.[PKG_NAME] ?? null;
  console.log(`profile      : ${PROFILE_DIR}`);
  console.log(`node_modules : ${installed ? '已安装' : '未安装'}  ${TARGET}`);
  console.log(`bundles 注册 : ${registered ? '是' : '否'}`);
  console.log(`dependencies : ${dep ?? '无'}`);
  return { installed, registered, dep };
}

if (mode === 'check') {
  await report();
  process.exit(0);
}

if (mode === 'remove') {
  await rm(TARGET, { recursive: true, force: true });
  await patchProfile({ add: false });
  console.log('已卸载。重启 DSH 生效（tool 会消失）。');
  await report();
  process.exit(0);
}

await syncFiles();
await patchProfile({ add: true });
await report();
console.log('\n完成。重启 DSH Desktop 后生效（插件树在进程启动时组合）。');
