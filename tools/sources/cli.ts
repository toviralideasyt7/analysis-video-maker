#!/usr/bin/env tsx
/**
 * Probe the direct-download sources from the shell. No API keys needed except
 * for Kaggle (KAGGLE_USERNAME / KAGGLE_KEY).
 *
 *   npx tsx tools/sources/cli.ts probe                 # status of every source
 *   npx tsx tools/sources/cli.ts owid "co2 emissions"  # search + download a CSV
 *   npx tsx tools/sources/cli.ts owid-slug annual-co2-emissions-per-country
 *   npx tsx tools/sources/cli.ts dataraces             # list catalog datasets
 *   npx tsx tools/sources/cli.ts dataraces-slug global-co2
 *   npx tsx tools/sources/cli.ts dataraces-images https://data-races.com/en/datasets/global-co2/
 *   npx tsx tools/sources/cli.ts kaggle "co2 emissions"
 *   npx tsx tools/sources/cli.ts wb "CO2 emissions"
 *   npx tsx tools/sources/cli.ts wb-dataset 0037712
 *   npx tsx tools/sources/cli.ts flag IND
 */

import { searchOwid, resolveOwidSeries, fetchOwidMetadata, owidCsvUrl, owidMetadataUrl } from './owid';
import { listDataRaceDatasets, fetchDataRaceBySlug, scrapeDataRaceImages } from './dataraces';
import { searchKaggleDatasets, kaggleCredentials, listKaggleFiles } from './kaggle';
import { ddhSearch, ddhDataset, ddhDownloadableResources } from './worldbank';
import { circleFlagUrl, fetchCircleFlagSvg, toFlagCode } from './flags';

function out(line = '') { process.stdout.write(line + '\n'); }
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : String(value));

async function cmdProbe() {
  out('SOURCE            STATUS');
  const rows: Array<[string, string]> = [];
  try { const hits = await searchOwid('co2 emissions'); rows.push(['owid search', 'OK  hits=' + hits.length + ' first=' + (hits[0] ? hits[0].slug : '-')]); }
  catch (error) { rows.push(['owid search', 'FAIL ' + (error as Error).message]); }
  try { const md = await fetchOwidMetadata('annual-co2-emissions-per-country'); rows.push(['owid metadata', 'OK  title=' + (md.chart?.title ?? '-')]); }
  catch (error) { rows.push(['owid metadata', 'FAIL ' + (error as Error).message]); }
  try { const list = await listDataRaceDatasets(); rows.push(['data-races', 'OK  datasets=' + list.length + ' first=' + (list[0] ? list[0].slug : '-')]); }
  catch (error) { rows.push(['data-races', 'FAIL ' + (error as Error).message]); }
  try { const found = await fetchDataRaceBySlug('global-co2'); rows.push(['data-races json', found ? 'OK  periods=' + Object.keys(found.payload.data).length + ' unit=' + found.payload.periodUnit : 'FAIL not resolved']); }
  catch (error) { rows.push(['data-races json', 'FAIL ' + (error as Error).message]); }
  try {
    const creds = kaggleCredentials();
    if (!creds) rows.push(['kaggle', 'SKIP credentials missing']);
    else { const list = await searchKaggleDatasets('co2 emissions', { pageSize: 3, credentials: creds }); rows.push(['kaggle', 'OK  hits=' + list.length + ' first=' + (list[0] ? list[0].ref : '-')]); }
  } catch (error) { rows.push(['kaggle', 'FAIL ' + (error as Error).message]); }
  try { const s = await ddhSearch('CO2 emissions', { top: 3 }); rows.push(['worldbank search', 'OK  count=' + s.count + ' first=' + (s.data[0] ? s.data[0].dataset_unique_id : '-')]); }
  catch (error) { rows.push(['worldbank search', 'FAIL ' + (error as Error).message]); }
  try { const flag = await fetchCircleFlagSvg('IND'); rows.push(['circle-flags', flag ? 'OK  bytes=' + flag.length + ' url=' + circleFlagUrl('IND') : 'FAIL']); }
  catch (error) { rows.push(['circle-flags', 'FAIL ' + (error as Error).message]); }
  for (const [name, status] of rows) out(name.padEnd(18) + status);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ');
  switch (command) {
    case 'probe': return cmdProbe();
    case 'owid': {
      const hits = await searchOwid(arg);
      out('owid search "' + arg + '": ' + hits.length + ' hits');
      hits.slice(0, 8).forEach((hit) => out('  [' + hit.type + '] ' + hit.title + '  slug=' + hit.slug + '  entities=' + (hit.availableEntities?.length ?? 0)));
      const series = await resolveOwidSeries(arg);
      if (!series) { out('no chart resolved'); return; }
      out('resolved slug=' + series.slug);
      out('  title=' + (series.title ?? '-') + ' unit=' + (series.unit ?? '-') + ' span=' + (series.timespan ?? '-'));
      out('  csv=' + owidCsvUrl(series.slug));
      out('  meta=' + owidMetadataUrl(series.slug));
      out('  entities=' + series.entities.length + ' observations=' + series.observations.length + ' skipped=' + series.skipped);
      const sample = series.observations.slice(0, 3);
      sample.forEach((row) => out('  ' + row.entity + ' (' + row.code + ') ' + row.year + ' = ' + num(row.value)));
      return;
    }
    case 'owid-slug': {
      const series = await resolveOwidSeries('', { slug: arg });
      if (!series) { out('could not fetch slug ' + arg); process.exitCode = 1; return; }
      out('slug=' + series.slug + ' unit=' + (series.unit ?? '-') + ' entities=' + series.entities.length + ' rows=' + series.observations.length);
      out('years: ' + Math.min(...series.observations.map((o) => o.year)) + '..' + Math.max(...series.observations.map((o) => o.year)));
      return;
    }
    case 'dataraces': {
      const list = await listDataRaceDatasets();
      out('data-races datasets: ' + list.length);
      list.slice(0, 40).forEach((item) => out('  ' + item.slug));
      return;
    }
    case 'dataraces-slug': {
      const found = await fetchDataRaceBySlug(arg);
      if (!found) { out('no json for ' + arg); process.exitCode = 1; return; }
      out('json=' + found.jsonUrl + ' unit=' + found.payload.periodUnit + ' periods=' + Object.keys(found.payload.data).length);
      out('schema: ' + found.payload.schema.join(', '));
      return;
    }
    case 'dataraces-images': {
      const urls = await scrapeDataRaceImages(arg);
      out('images: ' + urls.length);
      urls.slice(0, 30).forEach((url) => out('  ' + url));
      return;
    }
    case 'kaggle': {
      const creds = kaggleCredentials();
      if (!creds) { out('KAGGLE_USERNAME / KAGGLE_KEY missing'); process.exitCode = 2; return; }
      const list = await searchKaggleDatasets(arg, { pageSize: 8, credentials: creds });
      out('kaggle "' + arg + '": ' + list.length + ' datasets');
      list.forEach((item) => out('  ' + item.ref + '  (' + num(item.downloadCount) + ' downloads) ' + item.title));
      if (list[0]) {
        const files = await listKaggleFiles(list[0].ref, creds);
        out('files in ' + list[0].ref + ': ' + files.length);
        files.slice(0, 8).forEach((file) => out('  ' + file.name));
      }
      return;
    }
    case 'wb': {
      const result = await ddhSearch(arg, { top: 8 });
      out('worldbank "' + arg + '": count=' + result.count);
      result.data.forEach((hit) => out('  [' + hit.dataset_unique_id + '] ' + hit.name));
      return;
    }
    case 'wb-dataset': {
      const dataset = await ddhDataset(arg);
      out('dataset ' + dataset.dataset_unique_id + ': ' + dataset.name);
      const resources = await ddhDownloadableResources(arg);
      out('downloadable resources: ' + resources.length);
      resources.slice(0, 10).forEach((resource) => out('  ' + resource.resource_unique_id + ' [' + (resource.format ?? '?') + '] ' + resource.name + ' -> ' + resource.url));
      return;
    }
    case 'flag': {
      out('toFlagCode(' + arg + ') = ' + toFlagCode(arg));
      out('url=' + (circleFlagUrl(arg) ?? '-'));
      return;
    }
    default:
      out('commands: probe | owid | owid-slug | dataraces | dataraces-slug | dataraces-images | kaggle | wb | wb-dataset | flag');
      process.exitCode = 2;
  }
}

main().catch((error) => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exitCode = 1; });