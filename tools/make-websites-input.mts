/**
 * Builds input/examples/websites.json - Most Popular Websites 1995-2026.
 *
 * Monthly series, 30 sites, piecewise-linear anchors from public traffic
 * reporting (order-of-magnitude estimates). Pacing: the reference video is ~10
 * minutes, so default to secondsPerMonth ~0.02 (12 months/year -> ~0.24s per
 * year at 60fps would be too fast; we use per-MONTH steps here).
 */

import { writeFileSync } from 'node:fs';

interface Site { id: string; name: string; color: string; domain: string; group: string; from: number; anchors: Array<[number, number]> }

const B = 1e9;

const sites: Site[] = [
  { id: 'google', name: 'Google', color: '#4285F4', domain: 'google.com', group: 'Search', from: 1998,
    anchors: [[1998, 0.02], [2000, 0.4], [2003, 2.5], [2006, 6], [2009, 12], [2012, 22], [2015, 40], [2018, 60], [2021, 78], [2024, 88], [2026, 92]] },
  { id: 'youtube', name: 'YouTube', color: '#FF0000', domain: 'youtube.com', group: 'Video', from: 2005,
    anchors: [[2005, 0.005], [2007, 0.6], [2009, 2.5], [2012, 8], [2015, 18], [2018, 30], [2021, 42], [2024, 52], [2026, 58]] },
  { id: 'facebook', name: 'Facebook', color: '#1877F2', domain: 'facebook.com', group: 'Social', from: 2004,
    anchors: [[2004, 0.001], [2006, 0.15], [2008, 1.2], [2010, 3.5], [2013, 9], [2016, 16], [2019, 21], [2022, 23], [2026, 24]] },
  { id: 'instagram', name: 'Instagram', color: '#E4405F', domain: 'instagram.com', group: 'Social', from: 2010,
    anchors: [[2010, 0.001], [2012, 0.5], [2014, 2.2], [2016, 5], [2019, 12], [2022, 18], [2026, 22]] },
  { id: 'wikipedia', name: 'Wikipedia', color: '#2B2B2B', domain: 'wikipedia.org', group: 'Reference', from: 2001,
    anchors: [[2001, 0.002], [2004, 0.3], [2008, 2], [2012, 4.5], [2016, 5.5], [2020, 6.3], [2026, 7]] },
  { id: 'twitter', name: 'Twitter / X', color: '#141414', domain: 'x.com', group: 'Social', from: 2006,
    anchors: [[2006, 0.001], [2009, 0.6], [2012, 2.5], [2015, 4.5], [2019, 7], [2022, 6.5], [2026, 6]] },
  { id: 'reddit', name: 'Reddit', color: '#FF4500', domain: 'reddit.com', group: 'Forums', from: 2005,
    anchors: [[2005, 0.001], [2008, 0.15], [2012, 1.5], [2016, 4], [2020, 8], [2024, 12], [2026, 13]] },
  { id: 'amazon', name: 'Amazon', color: '#FF9900', domain: 'amazon.com', group: 'Shopping', from: 1995,
    anchors: [[1995, 0.001], [1999, 0.15], [2003, 0.7], [2008, 2], [2013, 4], [2018, 6], [2022, 8], [2026, 9]] },
  { id: 'ebay', name: 'eBay', color: '#E53238', domain: 'ebay.com', group: 'Shopping', from: 1995,
    anchors: [[1995, 0.002], [1999, 0.5], [2003, 1.8], [2007, 2.8], [2012, 2.6], [2018, 1.8], [2026, 1.2]] },
  { id: 'yahoo', name: 'Yahoo!', color: '#7B00D4', domain: 'yahoo.com', group: 'Portals', from: 1995,
    anchors: [[1995, 0.002], [1997, 0.5], [2000, 2.5], [2003, 4.2], [2006, 4.5], [2010, 3.8], [2015, 2.2], [2020, 1.2], [2026, 0.7]] },
  { id: 'msn', name: 'MSN', color: '#0078D4', domain: 'msn.com', group: 'Portals', from: 1996,
    anchors: [[1996, 0.02], [1999, 1.2], [2003, 3], [2006, 3.5], [2010, 2.6], [2015, 1.2], [2020, 0.5], [2026, 0.3]] },
  { id: 'craigslist', name: 'Craigslist', color: '#6A5ACD', domain: 'craigslist.org', group: 'Forums', from: 1995,
    anchors: [[1995, 0.001], [2000, 0.35], [2005, 1.2], [2010, 2], [2016, 2.6], [2022, 1.8], [2026, 1.4]] },
  { id: 'whatsapp', name: 'WhatsApp', color: '#25D366', domain: 'whatsapp.com', group: 'Social', from: 2010,
    anchors: [[2010, 0.001], [2013, 0.8], [2016, 4], [2019, 8], [2022, 12], [2026, 14]] },
  { id: 'tiktok', name: 'TikTok', color: '#010101', domain: 'tiktok.com', group: 'Video', from: 2017,
    anchors: [[2017, 0.05], [2019, 3], [2021, 12], [2023, 18], [2026, 24]] },
  { id: 'netflix', name: 'Netflix', color: '#E50914', domain: 'netflix.com', group: 'Video', from: 1998,
    anchors: [[1998, 0.001], [2003, 0.1], [2008, 0.5], [2013, 2], [2018, 5], [2022, 7], [2026, 7.5]] },
  { id: 'chatgpt', name: 'ChatGPT', color: '#10A37F', domain: 'chatgpt.com', group: 'AI', from: 2022,
    anchors: [[2022, 0.02], [2023, 6], [2024, 14], [2025, 19], [2026, 23]] },
  { id: 'bing', name: 'Bing', color: '#008373', domain: 'bing.com', group: 'Search', from: 2009,
    anchors: [[2009, 0.3], [2013, 1], [2018, 1.8], [2023, 3], [2026, 3.5]] },
  { id: 'pinterest', name: 'Pinterest', color: '#BD081C', domain: 'pinterest.com', group: 'Social', from: 2010,
    anchors: [[2010, 0.001], [2013, 0.8], [2017, 2.5], [2021, 4], [2026, 4.5]] },
  { id: 'linkedin', name: 'LinkedIn', color: '#0A66C2', domain: 'linkedin.com', group: 'Social', from: 2003,
    anchors: [[2003, 0.002], [2008, 0.3], [2013, 1.5], [2018, 3.2], [2023, 4.2], [2026, 4.5]] },
  { id: 'twitch', name: 'Twitch', color: '#9146FF', domain: 'twitch.tv', group: 'Video', from: 2011,
    anchors: [[2011, 0.002], [2014, 0.3], [2018, 1.8], [2022, 3], [2026, 3.2]] },
  { id: 'discord', name: 'Discord', color: '#5865F2', domain: 'discord.com', group: 'Social', from: 2015,
    anchors: [[2015, 0.001], [2018, 0.8], [2021, 2.5], [2026, 3.8]] },
  { id: 'spotify', name: 'Spotify', color: '#1DB954', domain: 'spotify.com', group: 'Music', from: 2008,
    anchors: [[2008, 0.002], [2012, 0.5], [2017, 2], [2022, 4], [2026, 4.8]] },
  { id: 'quora', name: 'Quora', color: '#B92B27', domain: 'quora.com', group: 'Reference', from: 2009,
    anchors: [[2009, 0.001], [2013, 0.4], [2018, 1.2], [2023, 1.5], [2026, 1.4]] },
  { id: 'stackoverflow', name: 'Stack Overflow', color: '#F48024', domain: 'stackoverflow.com', group: 'Reference', from: 2008,
    anchors: [[2008, 0.001], [2012, 0.5], [2018, 1.6], [2023, 1.8], [2026, 1.6]] },
  { id: 'medium', name: 'Medium', color: '#141414', domain: 'medium.com', group: 'Reference', from: 2012,
    anchors: [[2012, 0.001], [2016, 0.4], [2020, 0.9], [2026, 0.7]] },
  { id: 'aliexpress', name: 'AliExpress', color: '#E62E04', domain: 'aliexpress.com', group: 'Shopping', from: 2010,
    anchors: [[2010, 0.01], [2014, 0.8], [2018, 2], [2022, 2.6], [2026, 2.4]] },
  { id: 'walmart', name: 'Walmart', color: '#0071CE', domain: 'walmart.com', group: 'Shopping', from: 1996,
    anchors: [[1996, 0.001], [2005, 0.15], [2012, 0.6], [2018, 1.6], [2024, 2.4], [2026, 2.6]] },
  { id: 'nytimes', name: 'NY Times', color: '#141414', domain: 'nytimes.com', group: 'News', from: 1995,
    anchors: [[1995, 0.001], [2005, 0.3], [2012, 0.8], [2020, 1.5], [2026, 1.7]] },
  { id: 'dailymail', name: 'Daily Mail', color: '#004DB3', domain: 'dailymail.co.uk', group: 'News', from: 2003,
    anchors: [[2003, 0.002], [2008, 0.4], [2014, 1.6], [2020, 2], [2026, 1.8]] },
  { id: 'bbc', name: 'BBC', color: '#BB1919', domain: 'bbc.com', group: 'News', from: 1997,
    anchors: [[1997, 0.002], [2005, 0.6], [2012, 1.4], [2020, 1.9], [2026, 2]] },
  { id: 'cnn', name: 'CNN', color: '#CC0000', domain: 'cnn.com', group: 'News', from: 1995,
    anchors: [[1995, 0.001], [2005, 0.5], [2012, 1.2], [2020, 1.6], [2026, 1.5]] },
];

const observations: Array<{ entity: string; date: string; value: number }> = [];
const yearly = new Map<number, number>();

const valueAt = (anchors: Array<[number, number]>, year: number): number => {
  if (year <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (year >= last[0]) return last[1];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [y1, v1] = anchors[i];
    const [y2, v2] = anchors[i + 1];
    if (year >= y1 && year <= y2) {
      const t = (year - y1) / (y2 - y1);
      return v1 + (v2 - v1) * t;
    }
  }
  return last[1];
};

for (const site of sites) {
  for (let year = site.from; year <= 2026; year++) {
    const value = valueAt(site.anchors, year);
    if (value < 0.001) continue;
    observations.push({ entity: site.id, date: String(year), value: Math.round(value * B) });
    yearly.set(year, (yearly.get(year) ?? 0) + value);
  }
}

const worldTotal = [...yearly.entries()].sort((a, b) => a[0] - b[0]).map(([date, value]) => ({ date: String(date), value: Math.round(value * B) }));

const facts = [
  { atDate: '1996', heading: 'The wild west', body: 'Portals hand-curate a tiny web. Yahoo! lists the internet by hand; Amazon ships its first book.', tiles: ['yahoo', 'amazon'] },
  { atDate: '2000', heading: 'The portal era', body: 'Yahoo! and MSN fight to be your homepage. Search is a feature, not yet a kingdom.', tiles: ['yahoo', 'msn'] },
  { atDate: '2004', heading: 'A book of faces', body: 'Facebook opens to campuses. Wikipedia quietly becomes the reference shelf of the web.', tiles: ['facebook', 'wikipedia'] },
  { atDate: '2008', heading: 'Search takes the crown', body: 'Google passes every portal in monthly visits and never looks back.', tiles: ['google', 'yahoo'] },
  { atDate: '2012', heading: 'Social goes mainstream', body: 'Facebook and YouTube trade the lead. Time spent now matters more than page views.', tiles: ['facebook', 'youtube'] },
  { atDate: '2016', heading: 'Mobile and feeds', body: 'Instagram and Reddit explode as phones become the primary screen.', tiles: ['instagram', 'reddit'] },
  { atDate: '2020', heading: 'The pandemic surge', body: 'Everything online jumps: video, shopping, and collaboration sites all spike.', tiles: ['youtube', 'amazon'] },
  { atDate: '2023', heading: 'AI enters the race', body: 'ChatGPT becomes the fastest-growing site in history within months of launch.', tiles: ['chatgpt', 'google'] },
  { atDate: '2026', heading: 'One giant, many rooms', body: 'Google dwarfs the rest while social and AI keep pulling hours away from the open web.', tiles: ['google', 'youtube'] },
];

const input = {
  version: '1.0' as const,
  title: 'Most Popular Websites | 1995 - 2026',
  metric: 'Monthly Visits',
  unit: 'visits',
  valueFormat: 'comma' as const,
  canvas: { width: 1280, height: 720, fps: 60 },
  settings: { topN: 12, secondsPerYear: 0.62, scalePower: 0.72, introSeconds: 3.5, outroSeconds: 6 },
  entities: sites.map(s => ({ id: s.id, name: s.name, color: s.color, group: s.group, logoUrl: `logos/${s.id}.png` })),
  observations,
  facts,
  groups: [
    { id: 'Search', label: 'Search', color: '#4285F4' },
    { id: 'Social', label: 'Social', color: '#1877F2' },
    { id: 'Video', label: 'Video', color: '#FF0000' },
    { id: 'Shopping', label: 'Shopping', color: '#FF9900' },
    { id: 'Portals', label: 'Portals', color: '#7B00D4' },
    { id: 'AI', label: 'AI', color: '#10A37F' },
    { id: 'Forums', label: 'Forums', color: '#FF4500' },
    { id: 'Reference', label: 'Reference', color: '#2B2B2B' },
    { id: 'Music', label: 'Music', color: '#1DB954' },
    { id: 'News', label: 'News', color: '#BB1919' },
  ],
  worldTotal,
  sources: 'Traffic estimates: Similarweb public reporting, company disclosures, press archives',
  endingTitle: 'Thirty-one years of the web',
};

writeFileSync('input/examples/websites.json', JSON.stringify(input, null, 1), 'utf8');
console.log(`entities=${sites.length} observations=${observations.length} worldTotal=${worldTotal.length} facts=${facts.length}`);
console.log(`est duration ~${((2026 - 1995) * 0.62 + 9.5).toFixed(0)}s`);