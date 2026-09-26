/**
 * Unified data-source catalog: search + direct download for the user's
 * approved sources. Each source exposes:
 *   - search(query): find datasets (title, url, direct download URL)
 *   - download(url): fetch and return {columns, rows}
 *
 * Sources are tried in the user's 8-tier hierarchy order.
 */

import { getText, parseCsv } from '../connectors';
import { logger } from '../runtime';

export interface DatasetHit {
  title: string;
  source: string;       // e.g. 'kaggle', 'owid', 'eurostat'
  pageUrl: string;      // human page
  downloadUrl?: string; // direct CSV/JSON/ZIP
  tier: number;         // 1-8 per user's hierarchy
}

export interface SourceAdapter {
  name: string;
  tier: number;
  search(query: string): Promise<DatasetHit[]>;
}

// ---------------------------------------------------------------------------
// Kaggle (tier 7) — uses KAGGLE_USERNAME / KAGGLE_KEY env (repo secrets)
// ---------------------------------------------------------------------------

async function kaggleAuth(): Promise<string | null> {
  const user = process.env.KAGGLE_USERNAME;
  const key = process.env.KAGGLE_KEY;
  if (!user || !key) return null;
  return 'Basic ' + Buffer.from(`${user}:${key}`).toString('base64');
}

export const kaggleSource: SourceAdapter = {
  name: 'kaggle',
  tier: 7,
  async search(query: string): Promise<DatasetHit[]> {
    const auth = await kaggleAuth();
    const headers: Record<string, string> = { 'User-Agent': 'analysis-video-maker/1.0' };
    if (auth) headers['Authorization'] = auth;
    try {
      const url = `https://www.kaggle.com/api/v1/datasets/list?search=${encodeURIComponent(query)}&page=1`;
      const res = await fetch(url, { headers });
      if (!res.ok) return [];
      const list = (await res.json()) as Array<{ ref: string; title: string; url?: string }>;
      return list.slice(0, 10).map((d) => ({
        title: d.title,
        source: 'kaggle',
        pageUrl: `https://www.kaggle.com/datasets/${d.ref}`,
        downloadUrl: `https://www.kaggle.com/api/v1/datasets/download/${d.ref}`,
        tier: 7,
      }));
    } catch (error) {
      logger.warn('kaggle search failed', { error: String(error) });
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// OWID (tier 2 — official dataset) — search page + grapher ZIP pattern
// User-provided: /search?q=...&resultType=all, then /grapher/{slug}.zip
// ---------------------------------------------------------------------------

export const owidSource: SourceAdapter = {
  name: 'owid',
  tier: 2,
  async search(query: string): Promise<DatasetHit[]> {
    try {
      const { text } = await getText(
        `https://ourworldindata.org/search?q=${encodeURIComponent(query)}&resultType=all`,
        { timeoutMs: 30000 },
      );
      // Extract grapher slugs from the search page HTML
      const slugs = new Set<string>();
      const re = /\/grapher\/([a-z0-9-]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        slugs.add(m[1]);
      }
      return [...slugs].slice(0, 10).map((slug) => ({
        title: slug.replace(/-/g, ' '),
        source: 'owid',
        pageUrl: `https://ourworldindata.org/grapher/${slug}`,
        downloadUrl: `https://ourworldindata.org/grapher/${slug}.zip?v=1&csvType=full&useColumnShortNames=false`,
        tier: 2,
      }));
    } catch (error) {
      logger.warn('owid search failed', { error: String(error) });
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// Data Races (tier 5 — established database)
// User-provided category + country pages; JSON at /data/{category}/{slug}.json
// ---------------------------------------------------------------------------

const DATARACES_CATEGORIES = ['economy', 'technology', 'culture', 'agriculture', 'society', 'environment'];

export const dataRacesSource: SourceAdapter = {
  name: 'data-races',
  tier: 5,
  async search(query: string): Promise<DatasetHit[]> {
    const hits: DatasetHit[] = [];
    const q = query.toLowerCase();
    try {
      // Scrape category pages for dataset slugs matching the query
      for (const cat of DATARACES_CATEGORIES) {
        try {
          const { text } = await getText(`https://data-races.com/en/${cat}/`, { timeoutMs: 20000 });
          // data-id attributes hold slugs
          const re = /data-id="([^"]+)"/gi;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            const slug = m[1];
            if (slug.toLowerCase().includes(q.split(' ')[0]) || q.split(' ').some((w) => w.length > 3 && slug.toLowerCase().includes(w))) {
              hits.push({
                title: slug.replace(/-/g, ' '),
                source: 'data-races',
                pageUrl: `https://data-races.com/en/datasets/${slug}/`,
                downloadUrl: `https://data-races.com/data/${cat}/${slug}.json`,
                tier: 5,
              });
            }
          }
        } catch {
          // category page failed — continue
        }
        if (hits.length >= 10) break;
      }
    } catch (error) {
      logger.warn('data-races search failed', { error: String(error) });
    }
    return hits.slice(0, 10);
  },
};

// ---------------------------------------------------------------------------
// Eurostat (tier 1 — official government source)
// ---------------------------------------------------------------------------

export const eurostatSource: SourceAdapter = {
  name: 'eurostat',
  tier: 1,
  async search(query: string): Promise<DatasetHit[]> {
    // Eurostat has no keyword search API; the AI proposes dataset codes.
    // This adapter validates a code and returns the download URL.
    // Called with a dataset code like 'nama_10_gdp' as the query.
    const code = query.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(code)) return [];
    try {
      const url = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${code}?format=JSON&lang=en`;
      const { text, status } = await getText(url, { timeoutMs: 30000 });
      if (status !== 200) return [];
      const parsed = JSON.parse(text);
      if (!parsed.dimension) return [];
      return [{
        title: code,
        source: 'eurostat',
        pageUrl: `https://ec.europa.eu/eurostat/databrowser/view/default/table?lang=en&category=${code}`,
        downloadUrl: url,
        tier: 1,
      }];
    } catch {
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// Hugging Face (tier 7 — public dataset)
// ---------------------------------------------------------------------------

export const huggingfaceSource: SourceAdapter = {
  name: 'huggingface',
  tier: 7,
  async search(query: string): Promise<DatasetHit[]> {
    try {
      const url = `https://huggingface.co/api/datasets?search=${encodeURIComponent(query)}&limit=10`;
      const res = await fetch(url, { headers: { 'User-Agent': 'analysis-video-maker/1.0' } });
      if (!res.ok) return [];
      const list = (await res.json()) as Array<{ id: string }>;
      return list.map((d) => ({
        title: d.id,
        source: 'huggingface',
        pageUrl: `https://huggingface.co/datasets/${d.id}`,
        // Parquet download; the ingest layer handles parquet via python
        downloadUrl: `https://huggingface.co/api/datasets/${d.id}/parquet`,
        tier: 7,
      }));
    } catch (error) {
      logger.warn('huggingface search failed', { error: String(error) });
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// Data.gov (tier 1 — official government source)
// ---------------------------------------------------------------------------

export const datagovSource: SourceAdapter = {
  name: 'datagov',
  tier: 1,
  async search(query: string): Promise<DatasetHit[]> {
    try {
      const { text, status } = await getText(
        `https://catalog.data.gov/search?q=${encodeURIComponent(query)}&per_page=10`,
        { timeoutMs: 30000 },
      );
      if (status !== 200) return [];
      const parsed = JSON.parse(text);
      const datasets = parsed.datasets ?? parsed.data ?? [];
      const hits: DatasetHit[] = [];
      for (const ds of datasets.slice(0, 10)) {
        const dists = ds.distribution ?? [];
        // Prefer CSV/JSON direct download URLs
        const dl = dists.find((d: { downloadURL?: string; mediaType?: string }) =>
          d.downloadURL && /csv|json/i.test(d.mediaType ?? d.downloadURL ?? ''),
        ) ?? dists[0];
        hits.push({
          title: ds.title ?? 'untitled',
          source: 'datagov',
          pageUrl: ds.landingPage ?? `https://catalog.data.gov/dataset/${ds.identifier ?? ''}`,
          downloadUrl: dl?.downloadURL,
          tier: 1,
        });
      }
      return hits;
    } catch (error) {
      logger.warn('datagov search failed', { error: String(error) });
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// OpenCity (tier 1 — official government source, CKAN)
// ---------------------------------------------------------------------------

export const opencitySource: SourceAdapter = {
  name: 'opencity',
  tier: 1,
  async search(query: string): Promise<DatasetHit[]> {
    try {
      const url = `https://data.opencity.in/api/3/action/package_search?q=${encodeURIComponent(query)}&rows=10`;
      const res = await fetch(url, { headers: { 'User-Agent': 'analysis-video-maker/1.0' } });
      if (!res.ok) return [];
      const data = (await res.json()) as { result?: { results?: Array<{ title: string; name: string; resources: Array<{ url: string; format: string }> }> } };
      const results = data.result?.results ?? [];
      const hits: DatasetHit[] = [];
      for (const ds of results) {
        const dl = ds.resources.find((r) => /csv|json|xlsx?/i.test(r.format)) ?? ds.resources[0];
        if (!dl) continue;
        hits.push({
          title: ds.title,
          source: 'opencity',
          pageUrl: `https://data.opencity.in/dataset/${ds.name}`,
          downloadUrl: dl.url,
          tier: 1,
        });
      }
      return hits;
    } catch (error) {
      logger.warn('opencity search failed', { error: String(error) });
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// visdatasets (tier 5 — established database, GitHub Pages CSVs)
// ---------------------------------------------------------------------------

export const visdatasetsSource: SourceAdapter = {
  name: 'visdatasets',
  tier: 5,
  async search(query: string): Promise<DatasetHit[]> {
    try {
      // Scrape the index page for dataset CSV filenames matching the query
      const { text } = await getText('https://visdatasets.github.io/', { timeoutMs: 20000 });
      const q = query.toLowerCase().split(' ').filter((w) => w.length > 3);
      const re = /datasets\/([a-z0-9-]+\.csv)/gi;
      const seen = new Set<string>();
      const hits: DatasetHit[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const file = m[1];
        if (seen.has(file)) continue;
        seen.add(file);
        const name = file.replace('.csv', '').toLowerCase();
        if (q.some((w) => name.includes(w))) {
          hits.push({
            title: file.replace('.csv', '').replace(/-/g, ' '),
            source: 'visdatasets',
            pageUrl: 'https://visdatasets.github.io/',
            downloadUrl: `https://visdatasets.github.io/datasets/${file}`,
            tier: 5,
          });
        }
        if (hits.length >= 10) break;
      }
      return hits;
    } catch (error) {
      logger.warn('visdatasets search failed', { error: String(error) });
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// OECD (tier 1 — official organization source, SDMX)
// ---------------------------------------------------------------------------

export const oecdSource: SourceAdapter = {
  name: 'oecd',
  tier: 1,
  async search(query: string): Promise<DatasetHit[]> {
    // OECD SDMX has no keyword search; the AI proposes a dataflow code.
    // Validate the code and return the data URL pattern.
    const code = query.trim().toUpperCase();
    if (!/^[A-Z0-9_]+$/.test(code)) return [];
    try {
      // Try to get dataflow metadata
      const url = `https://sdmx.oecd.org/public/rest/v1/dataflow/OECD/${code}/1.0`;
      const res = await fetch(url, { headers: { 'Accept': 'application/vnd.sdmx.data+json', 'User-Agent': 'analysis-video-maker/1.0' } });
      if (!res.ok) return [];
      return [{
        title: code,
        source: 'oecd',
        pageUrl: `https://data.oecd.org/`,
        downloadUrl: `https://sdmx.oecd.org/public/rest/v1/data/OECD,${code},1.0/all?dimensionAtObservation=AllDimensions`,
        tier: 1,
      }];
    } catch {
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// World Bank Catalog (tier 2 — official dataset)
// User-provided: POST /ddhxext/v3/SearchData
// ---------------------------------------------------------------------------

export const wbCatalogSource: SourceAdapter = {
  name: 'wb-catalog',
  tier: 2,
  async search(query: string): Promise<DatasetHit[]> {
    try {
      // Use the public search endpoint (full catalog, filter client-side)
      const url = `https://datacatalogapi.worldbank.org/ddhxext/v3/search?$top=50`;
      const res = await fetch(url, { headers: { 'User-Agent': 'analysis-video-maker/1.0' } });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ dataset_unique_id: string; name: string }> };
      const q = query.toLowerCase().split(' ').filter((w) => w.length > 3);
      const hits: DatasetHit[] = [];
      for (const ds of data.data ?? []) {
        const name = (ds.name ?? '').toLowerCase();
        if (q.some((w) => name.includes(w))) {
          hits.push({
            title: ds.name,
            source: 'wb-catalog',
            pageUrl: `https://datacatalog.worldbank.org/search/dataset/${ds.dataset_unique_id}`,
            // File download URLs are on the dataset page; the extractor will find them
            downloadUrl: undefined,
            tier: 2,
          });
        }
        if (hits.length >= 10) break;
      }
      return hits;
    } catch (error) {
      logger.warn('wb-catalog search failed', { error: String(error) });
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// Registry: all adapters in tier order
// ---------------------------------------------------------------------------

export const ALL_SOURCES: SourceAdapter[] = [
  eurostatSource,   // tier 1
  datagovSource,    // tier 1
  opencitySource,   // tier 1
  oecdSource,       // tier 1
  owidSource,       // tier 2
  wbCatalogSource,  // tier 2
  dataRacesSource,  // tier 5
  visdatasetsSource,// tier 5
  kaggleSource,     // tier 7
  huggingfaceSource,// tier 7
].sort((a, b) => a.tier - b.tier);

/**
 * Search all sources in tier order, return hits sorted by tier then relevance.
 */
export async function searchAllSources(query: string, maxPerSource = 5): Promise<DatasetHit[]> {
  const all: DatasetHit[] = [];
  for (const src of ALL_SOURCES) {
    try {
      const hits = await src.search(query);
      all.push(...hits.slice(0, maxPerSource));
    } catch (error) {
      logger.warn('source search failed', { source: src.name, error: String(error) });
    }
  }
  return all.sort((a, b) => a.tier - b.tier);
}
