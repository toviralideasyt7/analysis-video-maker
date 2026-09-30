import { describe, expect, it } from 'vitest';
import { sniffTableUnit } from '../src/research';

// Regression: run 36777819736 (largest-economies-gdp) failed validation because
// the Kaggle CSV ingestion path hard-coded 'count', discarding the agent's
// correct 'USD' decision for a GDP dataset. All table-ingestion paths now
// resolve the unit through sniffTableUnit: agent unit > header/prompt sniffing
// > 'count'.
describe('sniffTableUnit', () => {
  it('prefers the agent unit over the count default (GDP scenario)', () => {
    expect(
      sniffTableUnit(
        ['Country Name', '1960', '1961'],
        'Largest economies by GDP (current US dollars) GDP',
        'USD',
      ),
    ).toBe('USD');
  });

  it('sniffs monetary topics from the prompt when the agent gave no unit', () => {
    expect(
      sniffTableUnit(['Country Name', '1960'], 'Largest economies by GDP GDP', undefined),
    ).toBe('USD');
    expect(
      sniffTableUnit(['title', 'revenue'], 'box office earnings', undefined),
    ).toBe('USD');
  });

  it('sniffs percent topics', () => {
    expect(
      sniffTableUnit(['browser', '2020'], 'browser market share', undefined),
    ).toBe('percent');
  });

  it('falls back to count for plain count topics', () => {
    expect(
      sniffTableUnit(['platform', '2020'], 'most popular social media platforms monthly active users', undefined),
    ).toBe('count');
  });
});
