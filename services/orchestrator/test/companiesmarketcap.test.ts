import { describe, expect, it } from 'vitest';
import {
  companiesMarketCapYearEnds,
  parseCompaniesMarketCapHtml,
} from '../src/connectors';

// Regression test for the 2026-10-02 "World's Largest Companies by Market Cap"
// research failures: every CSV candidate was a point-in-time snapshot with no
// date column, so no time series could form. companiesmarketcap.com
// per-company /marketcap/ pages embed the full daily history as
// {"d":<unix ts>,"m":<value>} points; m is in units of USD 1e5 (verified live
// against Apple's page: 1997-03-31 m=23075 -> ~$2.31B, 2020-12 m=20864611 ->
// ~$2.09T).
describe('companiesmarketcap.com history parsing', () => {
  const html = `<html><head><title>Apple (AAPL) - Market capitalization</title></head><body>
<script>var chart = [{"d":859766400,"m":23075},{"d":1606780800,"m":20864611},{"d":1607472000,"m":20704794},{"d":1790949128,"m":48408895}];</script>
</body></html>`;

  it('extracts the company name and history points', () => {
    const { company, points } = parseCompaniesMarketCapHtml(html);
    expect(company).toBe('Apple');
    expect(points.length).toBe(4);
    expect(points[0]).toEqual({ ts: 859766400, m: 23075 });
  });

  it('aggregates to year-end USD values at the right scale', () => {
    const { points } = parseCompaniesMarketCapHtml(html);
    const years = companiesMarketCapYearEnds(points);
    expect(years.map((y) => y.year)).toEqual([1997, 2020, 2026]);
    // year-end = last point of the year; m * 1e5 USD
    const y2020 = years.find((y) => y.year === 2020)!;
    expect(y2020.valueUsd).toBe(20704794 * 1e5);
    const y1997 = years.find((y) => y.year === 1997)!;
    expect(y1997.valueUsd).toBe(23075 * 1e5);
    // sanity: 2020 Apple year-end ~$2.07T
    expect(y2020.valueUsd).toBeGreaterThan(2e12);
    expect(y2020.valueUsd).toBeLessThan(2.2e12);
  });

  it('handles pages without a title or points gracefully', () => {
    const { company, points } = parseCompaniesMarketCapHtml('<html><body>no data</body></html>');
    expect(company).toBe('company');
    expect(points).toEqual([]);
    expect(companiesMarketCapYearEnds(points)).toEqual([]);
  });
});
