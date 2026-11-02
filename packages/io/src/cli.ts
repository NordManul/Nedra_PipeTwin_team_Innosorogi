/**
 * CLI импорта (WP-C2):
 *   npm run import -- data/scada.csv --mapping example-scada [--config configs/pipeline.default.json] [--out frames.csv]
 * Без --mapping строится черновик профиля по автоугадыванию: он сохраняется в configs/mappings/<имя>.draft.json,
 * вопросы печатаются, кадры всё равно пишутся (по угаданному).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { assertValid, resolveConfig, type MappingProfile } from '@pipetwin/core';
import { framesFromFile } from './import';
import { writeFramesCsv } from './sources';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a, i, arr) => !a.startsWith('--') && !arr[i - 1]?.startsWith('--'));
  if (!file) {
    console.error('использование: npm run import -- <файл> [--mapping <имя>] [--config <pipeline.json>] [--out <frames.csv>]');
    process.exit(2);
  }
  const root = process.env.INIT_CWD ?? process.cwd();
  const mappingName = arg('mapping');
  let profile: MappingProfile | undefined;
  if (mappingName) {
    const path = mappingName.endsWith('.json') ? resolve(root, mappingName) : resolve(root, 'configs/mappings', `${mappingName}.json`);
    profile = JSON.parse(readFileSync(path, 'utf8')) as MappingProfile;
    assertValid('mapping', profile, `профиль ${mappingName}`);
  }
  const cfgPath = arg('config');
  const config = cfgPath ? resolveConfig(JSON.parse(readFileSync(resolve(root, cfgPath), 'utf8'))).config : undefined;
  const bytes = new Uint8Array(readFileSync(resolve(root, file)));
  const res = await framesFromFile(bytes, basename(file), { profile, config });
  const im = res.imported;
  console.error(`формат: ${im.format}${im.encoding ? `, кодировка ${im.encoding}` : ''}${im.delimiter ? `, разделитель «${im.delimiter === '\t' ? 'TAB' : im.delimiter}»` : ''}, десятичный «${im.decimal}»`);
  console.error(`строк: ${im.table.t.length}, колонок данных: ${im.table.columns.length}, время: ${im.timeColumns.join(' + ')}${im.table.t0 ? `, начало ${im.table.t0}` : ''}`);
  for (const w of im.table.warnings) console.error(`предупреждение: ${w}`);
  if (res.draft) {
    const out = resolve(root, 'configs/mappings', `${res.profile.name}.draft.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ $schema: '../../schemas/mapping.schema.json', ...res.profile }, null, 2) + '\n');
    console.error(`черновик профиля: ${out} (угадано без вопросов: ${(res.draft.autoShare * 100).toFixed(0)}%)`);
    for (const q of res.draft.questions) console.error(`  ? ${q.column}: ${q.question}`);
  }
  const csv = writeFramesCsv(res.frames, res.profile.columns.map((c) => c.sensorId));
  const outPath = arg('out');
  if (outPath) {
    writeFileSync(resolve(root, outPath), csv);
    console.error(`кадры: ${resolve(root, outPath)}`);
  } else process.stdout.write(csv);
}

main().catch((e: unknown) => {
  console.error(`ошибка: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
