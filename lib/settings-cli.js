/**
 * dsh-simple-notify - settings CLI.
 *
 * Reads and writes the same settings.json that lib/index.js consumes, so the
 * switches can be flipped from a shell without registering any DSH tool:
 *
 *   node lib/settings-cli.js show
 *   node lib/settings-cli.js set silent true
 *   node lib/settings-cli.js set fullscreenMode skip
 *   node lib/settings-cli.js reset
 *
 * Why this exists instead of a `ctx.inject(['tools'], ...)` registration:
 * @deepseek-ai/dsh-tools is a peerDependency that only the DSH process itself
 * can resolve (it lives inside app.asar). A plugin linked in from outside the
 * profile cannot import it, and pulling a copy out of the asar risks handing
 * back objects the host does not recognise. A plain CLI needs no imports from
 * the host at all.
 *
 * The file this writes is picked up the next time the plugin applies.
 */

import { SETTING_SPECS, coerce, describeAll, readStored, resolveAll, settingsPath, writeStored } from './settings-store.js';

function usage() {
  const keys = Object.keys(SETTING_SPECS).join(' | ');
  return [
    '用法：',
    '  node lib/settings-cli.js show                列出全部设置及来源',
    '  node lib/settings-cli.js set <key> <value>   修改一项',
    '  node lib/settings-cli.js reset               清空本地覆盖，回到默认',
    '',
    `可用的 key：${keys}`,
    '',
    '取值：',
    ...Object.entries(SETTING_SPECS).map(([key, spec]) => {
      const shape = spec.kind === 'boolean' ? 'true / false' : spec.values.join(' / ');
      return `  ${key.padEnd(24)} ${shape.padEnd(26)} ${spec.label}`;
    }),
    '',
    `配置文件：${settingsPath()}`,
  ].join('\n');
}

function cmdShow() {
  const store = readStored();
  const { merged, origins } = resolveAll({}, store.values);
  const body = describeAll({ merged, origins });
  if (store.problems.length === 0) return body;
  return `${body}\n\n注意：${store.problems.join('; ')}`;
}

function cmdSet(key, raw) {
  if (key === undefined || raw === undefined) {
    return `set 需要两个参数：key 和 value\n\n${usage()}`;
  }
  const checked = coerce(key, raw);
  if (!checked.ok) return `错误：${checked.reason}`;

  const current = readStored();
  if (current.problems.length > 0) {
    return `错误：现有设置文件有问题，未改动。${current.problems.join('; ')}`;
  }
  const next = { ...current.values, [key]: checked.value };
  writeStored(next);

  const { merged, origins } = resolveAll({}, next);
  return `已保存：${key} -> ${JSON.stringify(checked.value)}\n\n${describeAll({ merged, origins })}`;
}

function cmdReset() {
  const current = readStored();
  if (Object.keys(current.values).length === 0) return '本来就没有本地覆盖，无需重置。';
  writeStored({});
  const { merged, origins } = resolveAll({}, {});
  return `已清空 ${settingsPath()}\n\n${describeAll({ merged, origins })}`;
}

function main(argv) {
  const [action, a, b] = argv;
  if (action === undefined || action === 'help' || action === '--help' || action === '-h') return usage();
  if (action === 'show') return cmdShow();
  if (action === 'set') return cmdSet(a, b);
  if (action === 'reset') return cmdReset();
  return `不认识的动作 "${action}"\n\n${usage()}`;
}

// Only run when invoked directly, so importing this module never prints.
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').endsWith('lib/settings-cli.js');

if (invokedDirectly) {
  const code = process.argv.slice(2);
  try {
    process.stdout.write(`${main(code)}\n`);
  } catch (error) {
    process.stderr.write(`失败：${String(error)}\n`);
    process.exitCode = 1;
  }
}

export { main };
