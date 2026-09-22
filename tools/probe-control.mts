#!/usr/bin/env tsx
/**
 * Smoke-test the deployed control plane.
 *
 *   npx tsx tools/probe-control.mts <baseUrl> [password]
 */

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const password = process.argv[3] ?? '';
if (!base) {
  process.stderr.write('usage: tsx tools/probe-control.mts <baseUrl> [password]\n');
  process.exit(2);
}

const out = (line = ''): void => process.stdout.write(line + '\n');

async function main(): Promise<void> {
  const health = await fetch(`${base}/api/health`);
  out(`health   ${health.status} ${await health.text()}`);

  const wrong = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'definitely-wrong' }),
  });
  out(`bad login ${wrong.status} (expected 401) ${(await wrong.text()).slice(0, 80)}`);

  if (!password) {
    out('no password passed; stopping before the authenticated checks');
    return;
  }
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  out(`login    ${login.status} cookie=${cookie ? 'yes' : 'no'} (expected 200)`);

  const me = await fetch(`${base}/api/me`, { headers: { cookie } });
  out(`me       ${me.status} ${await me.text()}`);

  const jobs = await fetch(`${base}/api/jobs`, { headers: { cookie } });
  out(`jobs     ${jobs.status} ${(await jobs.text()).slice(0, 300)}`);

  const unauth = await fetch(`${base}/api/jobs`);
  out(`no cookie ${unauth.status} (expected 401)`);
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  process.exit(1);
});