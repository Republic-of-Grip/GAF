import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVersion,
  compareVersions,
  isRemoteNewer,
  readInstalledVersion,
  extensionsPageUrl,
  formatUpdateStatus,
  githubApiUrl,
  githubArchiveZipUrl,
  githubManifestUrl,
  isOfflineError,
  updateCheckErrorMessage,
  fetchLatestPublishedVersion,
  checkForUpdates,
  openUpdate,
  bindUpdateControls,
  UPDATE_APPLY_HINT,
  GITHUB_OWNER,
  GITHUB_REPO,
} from '../src/core/updates.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockFetch(table) {
  return async (url) => {
    const href = String(url);
    for (const [match, impl] of table) {
      if (href.includes(match)) {
        return typeof impl === 'function' ? impl(href) : impl;
      }
    }
    throw new TypeError('Failed to fetch');
  };
}

test('normalizeVersion strips v prefix and whitespace', () => {
  assert.equal(normalizeVersion('v0.2.26'), '0.2.26');
  assert.equal(normalizeVersion(' 0.2.26 '), '0.2.26');
  assert.equal(normalizeVersion('V1.0.0'), '1.0.0');
});

test('compareVersions orders dotted integers', () => {
  assert.equal(compareVersions('0.2.25', '0.2.26'), -1);
  assert.equal(compareVersions('0.2.26', '0.2.26'), 0);
  assert.equal(compareVersions('0.3.0', '0.2.26'), 1);
  assert.equal(compareVersions('v0.2.26', '0.2.26'), 0);
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.9', '0.2.10'), -1);
});

test('isRemoteNewer requires a strictly greater remote', () => {
  assert.equal(isRemoteNewer('0.2.26', '0.2.27'), true);
  assert.equal(isRemoteNewer('0.2.26', '0.2.26'), false);
  assert.equal(isRemoteNewer('0.2.27', '0.2.26'), false);
  assert.equal(isRemoteNewer('', '0.2.26'), false);
});

test('readInstalledVersion uses chrome.runtime.getManifest', () => {
  assert.equal(readInstalledVersion({ runtime: { getManifest: () => ({ version: '0.2.26' }) } }), '0.2.26');
  assert.equal(readInstalledVersion({}), '');
});

test('extensionsPageUrl prefers helium:// on Helium', () => {
  assert.equal(extensionsPageUrl('Mozilla/5.0 Helium/1.0'), 'helium://extensions');
  assert.equal(extensionsPageUrl('Mozilla/5.0 Chrome/128'), 'chrome://extensions');
});

test('GitHub URLs point at Republic-of-Grip/GAF', () => {
  assert.equal(GITHUB_OWNER, 'Republic-of-Grip');
  assert.equal(GITHUB_REPO, 'GAF');
  assert.equal(githubApiUrl('/releases/latest'), 'https://api.github.com/repos/Republic-of-Grip/GAF/releases/latest');
  assert.equal(
    githubArchiveZipUrl('v0.2.27'),
    'https://github.com/Republic-of-Grip/GAF/archive/refs/tags/v0.2.27.zip'
  );
  assert.equal(
    githubArchiveZipUrl('main', { isBranch: true }),
    'https://github.com/Republic-of-Grip/GAF/archive/refs/heads/main.zip'
  );
  assert.equal(
    githubManifestUrl(),
    'https://raw.githubusercontent.com/Republic-of-Grip/GAF/main/manifest.json'
  );
});

test('fetchLatestPublishedVersion prefers a GitHub release', async () => {
  const fetchFn = mockFetch([
    ['/releases/latest', jsonResponse({ tag_name: 'v0.2.27', html_url: 'https://github.com/Republic-of-Grip/GAF/releases/tag/v0.2.27' })],
    ['/tags', jsonResponse([{ name: 'v0.2.1' }])],
    ['manifest.json', jsonResponse({ version: '0.2.0' })],
  ]);
  const remote = await fetchLatestPublishedVersion(fetchFn);
  assert.equal(remote.version, '0.2.27');
  assert.equal(remote.source, 'release');
  assert.equal(remote.zipUrl, 'https://github.com/Republic-of-Grip/GAF/archive/refs/tags/v0.2.27.zip');
});

test('fetchLatestPublishedVersion falls through 404 releases to highest tag', async () => {
  const fetchFn = mockFetch([
    ['/releases/latest', jsonResponse({ message: 'Not Found' }, 404)],
    ['/tags', jsonResponse([{ name: 'v0.2.10' }, { name: 'v0.2.9' }, { name: 'v0.1.99' }])],
  ]);
  const remote = await fetchLatestPublishedVersion(fetchFn);
  assert.equal(remote.version, '0.2.10');
  assert.equal(remote.source, 'tag');
});

test('fetchLatestPublishedVersion reads default-branch manifest when no tags', async () => {
  const fetchFn = mockFetch([
    ['/releases/latest', jsonResponse({ message: 'Not Found' }, 404)],
    ['/tags', jsonResponse([])],
    ['manifest.json', jsonResponse({ version: '0.2.26' })],
  ]);
  const remote = await fetchLatestPublishedVersion(fetchFn);
  assert.equal(remote.version, '0.2.26');
  assert.equal(remote.source, 'manifest');
  assert.equal(remote.zipUrl, 'https://github.com/Republic-of-Grip/GAF/archive/refs/heads/main.zip');
});

test('checkForUpdates shows Update only when remote is newer', async () => {
  const fetchFn = mockFetch([
    ['/releases/latest', jsonResponse({ message: 'Not Found' }, 404)],
    ['/tags', jsonResponse([])],
    ['manifest.json', jsonResponse({ version: '0.2.27' })],
  ]);
  const available = await checkForUpdates({ fetch: fetchFn, installed: '0.2.26' });
  assert.equal(available.status, 'available');
  assert.equal(available.installed, '0.2.26');
  assert.equal(available.remote, '0.2.27');

  const current = await checkForUpdates({ fetch: fetchFn, installed: '0.2.27' });
  assert.equal(current.status, 'current');
  assert.equal(current.remote, '0.2.27');
});

test('checkForUpdates treats equal versions as current', async () => {
  const fetchFn = mockFetch([
    ['/releases/latest', jsonResponse({ tag_name: '0.2.26' })],
  ]);
  const result = await checkForUpdates({ fetch: fetchFn, installed: '0.2.26' });
  assert.equal(result.status, 'current');
});

test('checkForUpdates reports a plain offline error', async () => {
  const result = await checkForUpdates({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
    installed: '0.2.26',
  });
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'Could not reach GitHub. Check your connection and try again.');
});

test('checkForUpdates reports a plain GitHub failure', async () => {
  const result = await checkForUpdates({
    fetch: async () => jsonResponse({ message: 'boom' }, 500),
    installed: '0.2.26',
  });
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'Could not check GitHub for a newer GAF version.');
});

test('formatUpdateStatus hides Update copy when current or failed', () => {
  assert.equal(
    formatUpdateStatus({ status: 'available', installed: '0.2.26', remote: '0.2.27' }),
    'A newer version is available: 0.2.26 → 0.2.27.'
  );
  assert.equal(
    formatUpdateStatus({ status: 'current', installed: '0.2.26' }),
    "You're on the latest version (0.2.26)."
  );
  assert.equal(
    formatUpdateStatus({ status: 'error', error: 'Could not reach GitHub. Check your connection and try again.' }),
    'Could not reach GitHub. Check your connection and try again.'
  );
});

test('isOfflineError and updateCheckErrorMessage', () => {
  assert.equal(isOfflineError(new TypeError('Failed to fetch')), true);
  assert.equal(isOfflineError(new Error('nope')), false);
  assert.equal(updateCheckErrorMessage(new TypeError('Failed to fetch')), 'Could not reach GitHub. Check your connection and try again.');
  assert.equal(updateCheckErrorMessage(new Error('500')), 'Could not check GitHub for a newer GAF version.');
});

test('openUpdate opens the zip then the extensions page', async () => {
  const opened = [];
  await openUpdate(
    { zipUrl: 'https://example.test/gaf.zip', updateUrl: 'https://example.test/gaf' },
    { openUrl: async (url) => opened.push(url), extensionsUrl: 'chrome://extensions' }
  );
  assert.deepEqual(opened, ['https://example.test/gaf.zip', 'chrome://extensions']);
});

test('bindUpdateControls checks, shows Update only when newer, and applies on click', async () => {
  const status = { textContent: '' };
  const updateButton = { hidden: true, addEventListener() {} };
  const eyebrow = { textContent: '', dataset: { versionTemplate: 'GAF v{version}' } };
  let checks = 0;
  const opened = [];

  const ui = bindUpdateControls({
    checkButton: { addEventListener() {} },
    updateButton,
    statusElement: status,
    installedVersionElements: [eyebrow],
    getInstalledVersion: () => '0.2.26',
    openUrl: async (url) => opened.push(url),
    getExtensionsPageUrl: () => 'chrome://extensions',
    check: async ({ installed }) => {
      checks += 1;
      assert.equal(installed, '0.2.26');
      return {
        status: 'available',
        installed,
        remote: '0.2.27',
        zipUrl: 'https://github.com/Republic-of-Grip/GAF/archive/refs/heads/main.zip',
      };
    },
  });

  assert.equal(eyebrow.textContent, 'GAF v0.2.26');
  assert.equal(updateButton.hidden, true);

  const available = await ui.runCheck();
  assert.equal(checks, 1);
  assert.equal(available.status, 'available');
  assert.equal(status.textContent, 'A newer version is available: 0.2.26 → 0.2.27.');
  assert.equal(updateButton.hidden, false);

  await ui.runUpdate();
  assert.equal(status.textContent, UPDATE_APPLY_HINT);
  assert.deepEqual(opened, [
    'https://github.com/Republic-of-Grip/GAF/archive/refs/heads/main.zip',
    'chrome://extensions',
  ]);
});

test('bindUpdateControls keeps Update hidden when already current', async () => {
  const status = { textContent: '' };
  const updateButton = { hidden: true, addEventListener() {} };
  const ui = bindUpdateControls({
    checkButton: { addEventListener() {} },
    updateButton,
    statusElement: status,
    getInstalledVersion: () => '0.2.26',
    openUrl: async () => {},
    check: async () => ({ status: 'current', installed: '0.2.26', remote: '0.2.26' }),
  });
  await ui.runCheck();
  assert.equal(status.textContent, "You're on the latest version (0.2.26).");
  assert.equal(updateButton.hidden, true);
});
