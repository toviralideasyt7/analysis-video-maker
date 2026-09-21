/**
 * Direct-download data sources: discover a topic, then fetch its table with no
 * browser and no AI in the loop. See docs/DATA-SOURCES.md for the live probe
 * results behind each endpoint.
 *
 *   OWID          search -> slug -> grapher CSV + metadata JSON
 *   data-races    sitemap -> dataset page -> /data/<cat>/<slug>.json race tape
 *   Kaggle        datasets/list -> datasets/view -> datasets/download/<file>
 *   World Bank    DDH /search -> /datasets/<id> -> resources[].url / data rows
 *   circle-flags  ISO3/ISO2 -> high-quality circular flag SVG
 */

export * from './http';
export * from './owid';
export * from './dataraces';
export * from './kaggle';
export * from './worldbank';
export * from './flags';
export * from './regions';

