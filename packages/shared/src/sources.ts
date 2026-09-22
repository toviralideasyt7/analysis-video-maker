/**
 * Direct-download data sources, shared by the research agent and the tools.
 *
 * Our World in Data needs no key and no browser:
 *   discover  GET https://ourworldindata.org/api/search?q=<query>
 *   download  GET https://ourworldindata.org/grapher/<slug>.csv
 *
 * This is the canonical implementation; tools/sources/owid.ts re-exports it so
 * the two never drift.
 */

export const OWID_BASE = 'https://ourworldindata.org';

/**
 * Whether summing the metric across entities produces a meaningful "total".
 * A share, a percentage, a per-capita value or a rate is a property of each
 * entity, not a quantity that adds up: summing them yields a meaningless number
 * (the earlier bug summed "income share of the richest 1%" and showed 19 as a
 * world total). Such metrics must not get a world-total label.
 */
/**
 * ISO3 -> ISO2 for 217 countries, generated from the World Bank country API with
 * aggregates removed. Data sources identify countries by ISO3 (Owid's Code
 * column, the World Bank id), while flag assets are keyed by ISO2, so the lookup
 * belongs here rather than being guessed by a model.
 */
const ISO3_TO_ISO2_TABLE = 'ABW:aw:Latin America & Caribbean|AFG:af:Middle East, North Africa, Afghanistan & Pakistan|AGO:ao:Sub-Saharan Africa|ALB:al:Europe & Central Asia|AND:ad:Europe & Central Asia|ARE:ae:Middle East, North Africa, Afghanistan & Pakistan|ARG:ar:Latin America & Caribbean|ARM:am:Europe & Central Asia|ASM:as:East Asia & Pacific|ATG:ag:Latin America & Caribbean|AUS:au:East Asia & Pacific|AUT:at:Europe & Central Asia|AZE:az:Europe & Central Asia|BDI:bi:Sub-Saharan Africa|BEL:be:Europe & Central Asia|BEN:bj:Sub-Saharan Africa|BFA:bf:Sub-Saharan Africa|BGD:bd:South Asia|BGR:bg:Europe & Central Asia|BHR:bh:Middle East, North Africa, Afghanistan & Pakistan|BHS:bs:Latin America & Caribbean|BIH:ba:Europe & Central Asia|BLR:by:Europe & Central Asia|BLZ:bz:Latin America & Caribbean|BMU:bm:North America|BOL:bo:Latin America & Caribbean|BRA:br:Latin America & Caribbean|BRB:bb:Latin America & Caribbean|BRN:bn:East Asia & Pacific|BTN:bt:South Asia|BWA:bw:Sub-Saharan Africa|CAF:cf:Sub-Saharan Africa|CAN:ca:North America|CHE:ch:Europe & Central Asia|CHI:jg:Europe & Central Asia|CHL:cl:Latin America & Caribbean|CHN:cn:East Asia & Pacific|CIV:ci:Sub-Saharan Africa|CMR:cm:Sub-Saharan Africa|COD:cd:Sub-Saharan Africa|COG:cg:Sub-Saharan Africa|COL:co:Latin America & Caribbean|COM:km:Sub-Saharan Africa|CPV:cv:Sub-Saharan Africa|CRI:cr:Latin America & Caribbean|CUB:cu:Latin America & Caribbean|CUW:cw:Latin America & Caribbean|CYM:ky:Latin America & Caribbean|CYP:cy:Europe & Central Asia|CZE:cz:Europe & Central Asia|DEU:de:Europe & Central Asia|DJI:dj:Middle East, North Africa, Afghanistan & Pakistan|DMA:dm:Latin America & Caribbean|DNK:dk:Europe & Central Asia|DOM:do:Latin America & Caribbean|DZA:dz:Middle East, North Africa, Afghanistan & Pakistan|ECU:ec:Latin America & Caribbean|EGY:eg:Middle East, North Africa, Afghanistan & Pakistan|ERI:er:Sub-Saharan Africa|ESP:es:Europe & Central Asia|EST:ee:Europe & Central Asia|ETH:et:Sub-Saharan Africa|FIN:fi:Europe & Central Asia|FJI:fj:East Asia & Pacific|FRA:fr:Europe & Central Asia|FRO:fo:Europe & Central Asia|FSM:fm:East Asia & Pacific|GAB:ga:Sub-Saharan Africa|GBR:gb:Europe & Central Asia|GEO:ge:Europe & Central Asia|GHA:gh:Sub-Saharan Africa|GIB:gi:Europe & Central Asia|GIN:gn:Sub-Saharan Africa|GMB:gm:Sub-Saharan Africa|GNB:gw:Sub-Saharan Africa|GNQ:gq:Sub-Saharan Africa|GRC:gr:Europe & Central Asia|GRD:gd:Latin America & Caribbean|GRL:gl:Europe & Central Asia|GTM:gt:Latin America & Caribbean|GUM:gu:East Asia & Pacific|GUY:gy:Latin America & Caribbean|HKG:hk:East Asia & Pacific|HND:hn:Latin America & Caribbean|HRV:hr:Europe & Central Asia|HTI:ht:Latin America & Caribbean|HUN:hu:Europe & Central Asia|IDN:id:East Asia & Pacific|IMN:im:Europe & Central Asia|IND:in:South Asia|IRL:ie:Europe & Central Asia|IRN:ir:Middle East, North Africa, Afghanistan & Pakistan|IRQ:iq:Middle East, North Africa, Afghanistan & Pakistan|ISL:is:Europe & Central Asia|ISR:il:Middle East, North Africa, Afghanistan & Pakistan|ITA:it:Europe & Central Asia|JAM:jm:Latin America & Caribbean|JOR:jo:Middle East, North Africa, Afghanistan & Pakistan|JPN:jp:East Asia & Pacific|KAZ:kz:Europe & Central Asia|KEN:ke:Sub-Saharan Africa|KGZ:kg:Europe & Central Asia|KHM:kh:East Asia & Pacific|KIR:ki:East Asia & Pacific|KNA:kn:Latin America & Caribbean|KOR:kr:East Asia & Pacific|KWT:kw:Middle East, North Africa, Afghanistan & Pakistan|LAO:la:East Asia & Pacific|LBN:lb:Middle East, North Africa, Afghanistan & Pakistan|LBR:lr:Sub-Saharan Africa|LBY:ly:Middle East, North Africa, Afghanistan & Pakistan|LCA:lc:Latin America & Caribbean|LIE:li:Europe & Central Asia|LKA:lk:South Asia|LSO:ls:Sub-Saharan Africa|LTU:lt:Europe & Central Asia|LUX:lu:Europe & Central Asia|LVA:lv:Europe & Central Asia|MAC:mo:East Asia & Pacific|MAF:mf:Latin America & Caribbean|MAR:ma:Middle East, North Africa, Afghanistan & Pakistan|MCO:mc:Europe & Central Asia|MDA:md:Europe & Central Asia|MDG:mg:Sub-Saharan Africa|MDV:mv:South Asia|MEX:mx:Latin America & Caribbean|MHL:mh:East Asia & Pacific|MKD:mk:Europe & Central Asia|MLI:ml:Sub-Saharan Africa|MLT:mt:Middle East, North Africa, Afghanistan & Pakistan|MMR:mm:East Asia & Pacific|MNE:me:Europe & Central Asia|MNG:mn:East Asia & Pacific|MNP:mp:East Asia & Pacific|MOZ:mz:Sub-Saharan Africa|MRT:mr:Sub-Saharan Africa|MUS:mu:Sub-Saharan Africa|MWI:mw:Sub-Saharan Africa|MYS:my:East Asia & Pacific|NAM:na:Sub-Saharan Africa|NCL:nc:East Asia & Pacific|NER:ne:Sub-Saharan Africa|NGA:ng:Sub-Saharan Africa|NIC:ni:Latin America & Caribbean|NLD:nl:Europe & Central Asia|NOR:no:Europe & Central Asia|NPL:np:South Asia|NRU:nr:East Asia & Pacific|NZL:nz:East Asia & Pacific|OMN:om:Middle East, North Africa, Afghanistan & Pakistan|PAK:pk:Middle East, North Africa, Afghanistan & Pakistan|PAN:pa:Latin America & Caribbean|PER:pe:Latin America & Caribbean|PHL:ph:East Asia & Pacific|PLW:pw:East Asia & Pacific|PNG:pg:East Asia & Pacific|POL:pl:Europe & Central Asia|PRI:pr:Latin America & Caribbean|PRK:kp:East Asia & Pacific|PRT:pt:Europe & Central Asia|PRY:py:Latin America & Caribbean|PSE:ps:Middle East, North Africa, Afghanistan & Pakistan|PYF:pf:East Asia & Pacific|QAT:qa:Middle East, North Africa, Afghanistan & Pakistan|ROU:ro:Europe & Central Asia|RUS:ru:Europe & Central Asia|RWA:rw:Sub-Saharan Africa|SAU:sa:Middle East, North Africa, Afghanistan & Pakistan|SDN:sd:Sub-Saharan Africa|SEN:sn:Sub-Saharan Africa|SGP:sg:East Asia & Pacific|SLB:sb:East Asia & Pacific|SLE:sl:Sub-Saharan Africa|SLV:sv:Latin America & Caribbean|SMR:sm:Europe & Central Asia|SOM:so:Sub-Saharan Africa|SRB:rs:Europe & Central Asia|SSD:ss:Sub-Saharan Africa|STP:st:Sub-Saharan Africa|SUR:sr:Latin America & Caribbean|SVK:sk:Europe & Central Asia|SVN:si:Europe & Central Asia|SWE:se:Europe & Central Asia|SWZ:sz:Sub-Saharan Africa|SXM:sx:Latin America & Caribbean|SYC:sc:Sub-Saharan Africa|SYR:sy:Middle East, North Africa, Afghanistan & Pakistan|TCA:tc:Latin America & Caribbean|TCD:td:Sub-Saharan Africa|TGO:tg:Sub-Saharan Africa|THA:th:East Asia & Pacific|TJK:tj:Europe & Central Asia|TKM:tm:Europe & Central Asia|TLS:tl:East Asia & Pacific|TON:to:East Asia & Pacific|TTO:tt:Latin America & Caribbean|TUN:tn:Middle East, North Africa, Afghanistan & Pakistan|TUR:tr:Europe & Central Asia|TUV:tv:East Asia & Pacific|TZA:tz:Sub-Saharan Africa|UGA:ug:Sub-Saharan Africa|UKR:ua:Europe & Central Asia|URY:uy:Latin America & Caribbean|USA:us:North America|UZB:uz:Europe & Central Asia|VCT:vc:Latin America & Caribbean|VEN:ve:Latin America & Caribbean|VGB:vg:Latin America & Caribbean|VIR:vi:Latin America & Caribbean|VNM:vn:East Asia & Pacific|VUT:vu:East Asia & Pacific|WSM:ws:East Asia & Pacific|XKX:xk:Europe & Central Asia|YEM:ye:Middle East, North Africa, Afghanistan & Pakistan|ZAF:za:Sub-Saharan Africa|ZMB:zm:Sub-Saharan Africa|ZWE:zw:Sub-Saharan Africa';

const ISO3_TO_ISO2 = new Map<string, string>(
  ISO3_TO_ISO2_TABLE.split('|').map((entry) => {
    const parts = entry.split(':');
    return [parts[0], parts[1]] as [string, string];
  }),
);

/** ISO2 flag key for an ISO3 code, or null when it is not a country. */
export function iso2FromIso3(code: string | undefined | null): string | null {
  if (!code) return null;
  return ISO3_TO_ISO2.get(code.trim().toUpperCase()) ?? null;
}
export function isAdditiveUnit(unit: string | undefined): boolean {
  const value = (unit ?? '').toLowerCase();
  if (!value) return false;
  const nonAdditive = [
    '%', 'percent', 'share', 'per capita', 'per person', 'per 1', 'per 100',
    'rate', 'ratio', 'index', 'years', 'days', 'hours', 'per woman', 'per child',
  ];
  return !nonAdditive.some((marker) => value.includes(marker));
}

export interface OwidSearchHit {
  title: string;
  slug: string;
  type: string;
  availableEntities?: string[];
}

export interface OwidRow {
  entity: string;
  code: string;
  year: number;
  value: number;
}

const USER_AGENT = 'analysis-video-maker/0.2 (+https://github.com/toviralideasyt8/analysis-video-maker)';

async function getText(url: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Discovery. Returns hits that all carry a grapher slug. */
export async function searchOwid(query: string): Promise<OwidSearchHit[]> {
  const body = JSON.parse(await getText(`${OWID_BASE}/api/search?q=${encodeURIComponent(query)}`)) as {
    results?: OwidSearchHit[];
  };
  return (body.results ?? []).filter((hit) => Boolean(hit.slug));
}

/** Only the hits that have a downloadable grapher CSV. */
export async function searchOwidCharts(query: string): Promise<OwidSearchHit[]> {
  const hits = await searchOwid(query);
  return hits.filter((hit) => hit.type === 'chart' || hit.type === 'explorerView');
}

/**
 * Pull the grapher slug out of any Our World in Data link. The site hands out
 * several download shapes for the same chart - with query strings, and as .csv,
 * .zip or .metadata.json - so the slug is the only stable part:
 *
 *   /grapher/population-growth-rates
 *   /grapher/population-growth-rates.zip?v=1&csvType=full
 *   /grapher/population-growth-rates.csv?v=1&useColumnShortNames=false
 */
export function owidSlugFromUrl(url: string): string | null {
  const match = /ourworldindata\.org\/grapher\/([A-Za-z0-9_-]+)/i.exec(url);
  return match ? match[1] : null;
}

/** Rewrite any Owid grapher link to the plain CSV endpoint. */
export function normaliseOwidUrl(url: string): string {
  const slug = owidSlugFromUrl(url);
  return slug ? owidCsvUrl(slug) : url;
}

export const owidCsvUrl = (slug: string): string => `${OWID_BASE}/grapher/${slug}.csv`;
export const fetchOwidCsv = (slug: string): Promise<string> => getText(owidCsvUrl(slug));
/**
 * How many CSV columns hold a value, rather than identifying a row.
 *
 * A grapher CSV is Entity,Code,Year plus one or more data columns. When there is
 * more than one, the chart is a comparison (for example "income share: WID vs
 * World Bank", which also ships a Population and a World region column). Racing
 * such a file would mean picking one arbitrary column and labelling it with
 * another column's unit, so callers must reject it rather than guess.
 */
export function countValueColumns(text: string): { columns: string[]; valueColumns: string[] } {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 2) return { columns: [], valueColumns: [] };
  const header = lines[0].split(',').map((cell) => cell.trim());
  const lower = header.map((cell) => cell.toLowerCase());
  const skip = (name: string): boolean =>
    name === 'entity' || name === 'code' || name === 'year' || name === 'date' ||
    name === 'iso' || name.includes('region') || name.includes('continent');
  const numericRate = (index: number): number => {
    let seen = 0;
    let numeric = 0;
    for (const line of lines.slice(1, 40)) {
      const raw = (line.split(',')[index] ?? '').trim();
      if (raw === '') continue;
      seen += 1;
      if (Number.isFinite(Number.parseFloat(raw))) numeric += 1;
    }
    return seen === 0 ? 0 : numeric / seen;
  };
  const valueColumns = header.filter((name, index) => !skip(lower[index]) && numericRate(index) >= 0.5);
  return { columns: header, valueColumns };
}

/**
 * Common phrasings mapped to the official series that answers them. Owid's search
 * cannot bridge this gap: "richest countries" does not contain the words
 * "gdp per capita", and the search happily returns an income-*share* chart
 * instead, which is a different question with different numbers.
 */
const INTENT_SLUGS: Array<{ match: RegExp; slugs: string[] }> = [
  // The historical rule must come first: the World Bank series only starts in 1990,
  // so a request for deep history has to be answered by the Maddison series (1700+).
  { match: /\b(ancient|historical|history|long run|over the centuries|since antiquity)\b/i, slugs: ['gdp-per-capita-maddison-project-database', 'gdp-per-capita-worldbank'] },
  
  { match: /\b(richest|wealthiest|most prosperous|highest income|best off)\b/i, slugs: ['gdp-per-capita-worldbank', 'gdp-per-capita-maddison-project-database'] },
  { match: /\b(poorest|least developed|lowest income)\b/i, slugs: ['gdp-per-capita-worldbank', 'gdp-per-capita-maddison-project-database'] },
  { match: /\b(largest|biggest|largest)\s+(econom|economy|economies|gdp)/i, slugs: ['gross-domestic-product', 'gdp-world-regions'] },
  { match: /\b(most populous|population)\b/i, slugs: ['population'] },
  { match: /\b(richest|wealth|wealthiest)\b.*\b(ancient|history|historical|old)\b/i, slugs: ['gdp-per-capita-maddison-project-database'] },
];

/** The official series to use for a phrasing, when one is recognised. */
export function intentSlugs(topic: string): string[] {
  for (const entry of INTENT_SLUGS) {
    if (entry.match.test(topic)) return entry.slugs;
  }
  return [];
}

export interface OwidColumnMeta {
  titleShort?: string;
  unit?: string;
  shortUnit?: string;
  timespan?: string;
  shortName?: string;
}

export interface OwidMetadata {
  chart?: { title?: string; subtitle?: string; citation?: string };
  columns?: Record<string, OwidColumnMeta>;
}

export const owidMetadataUrl = (slug: string): string => `${OWID_BASE}/grapher/${slug}.metadata.json`;

/** Chart metadata: the unit, title and citation that describe the series. */
export async function fetchOwidMetadata(slug: string): Promise<OwidMetadata> {
  return JSON.parse(await getText(owidMetadataUrl(slug))) as OwidMetadata;
}


/**
 * Parse a grapher CSV. The header is always Entity,Code,Year,<value column>; the
 * value column is whatever is left once entity/code/year are accounted for.
 */
export function parseOwidCsv(text: string): OwidRow[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((cell) => cell.trim().toLowerCase());
  const entityIndex = header.findIndex((cell) => cell.includes('entity') || cell.includes('country') || cell === 'name');
  const codeIndex = header.findIndex((cell) => cell === 'code' || cell.includes('iso'));
  const yearIndex = header.findIndex((cell) => cell.includes('year') || cell === 'date');
  const valueIndex = header.findIndex((_, index) => index !== entityIndex && index !== codeIndex && index !== yearIndex);
  if (entityIndex < 0 || yearIndex < 0 || valueIndex < 0) return [];

  const rows: OwidRow[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    const entity = (parts[entityIndex] ?? '').trim();
    const year = Number.parseInt((parts[yearIndex] ?? '').trim(), 10);
    const value = Number.parseFloat((parts[valueIndex] ?? '').trim().replace(/[",\s]/g, ''));
    if (!entity || !Number.isFinite(year) || !Number.isFinite(value)) continue;
    rows.push({ entity, code: codeIndex >= 0 ? (parts[codeIndex] ?? '').trim() : '', year, value });
  }
  return rows;
}

/** OWID aggregates are coded OWID_* (OWID_WRL is World) and are not countries. */
export const isOwidAggregate = (code: string): boolean => code.startsWith('OWID_');

/**
 * Resolve a topic straight to a table: search, take the best chart, download and
 * parse. Returns null when nothing usable is found, so the caller can fall back.
 */
/**
 * Resolve a topic to a grapher table.
 *
 * Owid's search only behaves on short queries: "population" finds the Population
 * chart, while "world population by country" returns health-access charts and the
 * wordier the request the worse it gets. So walk a ladder of progressively
 * simpler queries and prefer a chart whose title is exactly what was asked for.
 */
export async function resolveOwidTable(
  topic: string,
  options: { maxEntities?: number } = {},
): Promise<{ slug: string; title: string; rows: OwidRow[]; countries: OwidRow[] } | null> {
  const DROP = new Set([
    'world', 'global', 'countries', 'country', 'by', 'all', 'top', 'over', 'across',
    'since', 'total', 'list', 'ranking', 'rank', 'chart', 'video', 'data', 'the', 'of', 'in', 'a',
  ]);
  const split = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const words = (value: string): string[] => split(value).filter((word) => word.length > 2);
  const simplify = (value: string): string => split(value).filter((word) => !DROP.has(word)).join(' ');
  const stop = new Set(['the', 'and', 'per', 'for', 'with', 'from', 'by', 'of', 'in', 'to', 'a', 'total']);

  const core = simplify(topic);
  const ladder = Array.from(new Set([
    topic.trim(),
    core,
    core.split(' ').slice(0, 2).join(' '),
  ].filter((query) => query.length > 2)));

  const topicPhrase = words(topic).join(' ');
  const tokens = words(topic).filter((token) => !stop.has(token));
  const score = (title: string): [number, number, number] => {
    const titleWords = words(title);
    const titlePhrase = titleWords.join(' ');
    const exact = topicPhrase.includes(titlePhrase) || titlePhrase.includes(topicPhrase) ? 1 : 0;
    const overlap = tokens.reduce((sum, token) => sum + (titleWords.includes(token) ? 1 : 0), 0);
    return [exact, overlap, -titleWords.length];
  };

  const exactHits: OwidSearchHit[] = [];
  const otherHits: OwidSearchHit[] = [];
  const seen = new Set<string>();
  for (const query of ladder) {
    let hits: OwidSearchHit[] = [];
    try {
      hits = await searchOwidCharts(query);
    } catch {
      continue;
    }
    const queryPhrase = words(query).join(' ');
    for (const hit of hits) {
      if (seen.has(hit.slug)) continue;
      seen.add(hit.slug);
      const titleWords = words(hit.title);
      const isExact = hit.type === 'chart'
        && (titleWords.join(' ') === queryPhrase || titleWords.join(' ') === topicPhrase);
      if (isExact) exactHits.push(hit);
      else otherHits.push(hit);
    }
  }
  otherHits.sort((a, b) => {
    const left = score(a.title);
    const right = score(b.title);
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
  });

  const tryChart = async (chart: OwidSearchHit): Promise<{ slug: string; title: string; rows: OwidRow[]; countries: OwidRow[] } | null> => {
    try {
      const text = await fetchOwidCsv(chart.slug);
      // A comparison chart (two or more value columns) cannot be raced: picking one
      // column and labelling it with another column's unit is exactly how a video
      // shows the wrong number under the wrong name.
      const shape = countValueColumns(text);
      if (shape.valueColumns.length !== 1) return null;
      const rows = parseOwidCsv(text);
      if (rows.length < 20) return null;
      const countries = rows.filter((row) => row.code !== '' && !isOwidAggregate(row.code));
      let usable = countries.length >= 10 ? countries : rows;
      if (options.maxEntities) {
        const kept = new Set<string>();
        const trimmed: OwidRow[] = [];
        for (const row of usable) {
          const key = row.code || row.entity;
          if (!kept.has(key)) {
            if (kept.size >= options.maxEntities) continue;
            kept.add(key);
          }
          trimmed.push(row);
        }
        usable = trimmed;
      }
      return { slug: chart.slug, title: chart.title, rows: usable, countries: usable };
    } catch {
      return null;
    }
  };

  // The phrasing may name an intent that search cannot bridge, so try the mapped
  // official series first.
  const intent = intentSlugs(topic).map((slug) => ({ title: slug, slug, type: 'chart' }));
  for (const chart of [...intent, ...exactHits, ...otherHits.slice(0, 8)]) {
    const resolved = await tryChart(chart);
    if (resolved) return resolved;
  }
  return null;
}
