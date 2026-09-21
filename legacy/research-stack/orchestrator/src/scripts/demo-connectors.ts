/**
 * Live connector smoke test.
 *
 * Runs every connector that can answer without a credential, prints what really
 * came back, and reports failures verbatim. Nothing is faked: an unavailable or
 * blocked endpoint shows up as FAIL.
 *
 * Usage: npm run demo:connectors
 */

import {
  awsOpenDataSearch,
  ckanCandidates,
  ckanSearch,
  dataCommonsObservation,
  directoryLinks,
  getText,
  huggingFaceRows,
  kaggleCandidates,
  kaggleSearch,
  owidFetch,
  worldBankFetch,
} from '../connectors';
import { createSearchProvider } from '../providers/search';
import { env, limits } from '../runtime';

type Row = { connector: string; ok: boolean; detail: string };

const rows: Row[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    rows.push({ connector: name, ok: true, detail: `${detail} (${Date.now() - started}ms)` });
  } catch (error) {
    rows.push({ connector: name, ok: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
  }
}

async function main(): Promise<void> {
  await check('OWID grapher CSV', async () => {
    const result = await owidFetch('life-expectancy');
    if (result.rows.length === 0) throw new Error('parsed 0 rows');
    return `${result.rows.length} rows, columns=[${result.columns.join(', ')}], metadata=${result.metadata ? 'yes' : 'no'}`;
  });

  await check('World Bank indicator', async () => {
    const result = await worldBankFetch('SP.POP.TOTL', ['IN', 'CN'], { start: 2000, end: 2024 });
    const nonNull = result.rows.filter((r) => r.value !== null).length;
    return `${result.rows.length} rows (${nonNull} with values)`;
  });

  await check('Data Commons observation', async () => {
    const result = await dataCommonsObservation(['country/USA'], ['Count_Person'], { date: '2020' });
    return `byVariable keys=${Object.keys(result.byVariable as object).length}`;
  });

  await check('Data.gov CKAN', async () => {
    const resources = await ckanSearch('airport passengers', { rows: 3 });
    return `${resources.length} resources; first=${resources[0]?.format ?? 'n/a'}`;
  });

  await check('Hugging Face datasets-server', async () => {
    const result = await huggingFaceRows('lhoestq/demo1', { length: 5 });
    return `${result.rows.length} rows, columns=[${result.columns.join(', ')}]`;
  });

  await check('AWS Open Data registry', async () => {
    const hits = await awsOpenDataSearch('climate', { limit: 3 });
    return `${hits.length} matching datasets`;
  });

  await check('Discovery directory links', async () => {
    const links = await directoryLinks('https://visdatasets.github.io/', { limit: 5 });
    return `${links.length} links; first=${links[0]?.url ?? 'n/a'}`;
  });

  await check('Kaggle dataset search', async () => {
    if (!env('KAGGLE_USERNAME') || !env('KAGGLE_KEY')) throw new Error('KAGGLE_USERNAME / KAGGLE_KEY not configured');
    const datasets = await kaggleSearch('cell phone brands', { limit: 3 });
    const candidates = kaggleCandidates(datasets);
    return `${datasets.length} datasets; first=${candidates[0]?.title ?? 'n/a'} (license=${candidates[0]?.license ?? 'unknown'})`;
  });

  await check('Monid / TinyFish search', async () => {
    if (!env('MONID_API_KEY')) throw new Error('MONID_API_KEY not configured');
    const search = createSearchProvider();
    const results = await search.search('world population by country dataset csv', { limit: 3 });
    return `${results.length} results; first=${results[0]?.url ?? 'n/a'}`;
  });

  await check('Generic CSV fetch', async () => {
    const result = await getText('https://raw.githubusercontent.com/datasets/population/main/data/population.csv', { timeoutMs: 30_000 });
    return `HTTP ${result.status}, ${result.text.length} bytes`;
  });

  const width = Math.max(...rows.map((r) => r.connector.length));
  for (const row of rows) {
    const mark = row.ok ? 'OK  ' : 'FAIL';
    process.stdout.write(`${mark} ${row.connector.padEnd(width)}  ${row.detail}\n`);
  }
  const okCount = rows.filter((r) => r.ok).length;
  process.stdout.write(`\n${okCount}/${rows.length} connectors answered. Limits: ${JSON.stringify(limits())}\n`);
}

void main();