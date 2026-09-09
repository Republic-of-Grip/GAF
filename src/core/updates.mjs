/**
 * Manual GAF update check against the GitHub repo.
 *
 * This repo versions itself in manifest.json (and package.json). Releases/tags
 * are preferred when they exist; otherwise we read the default-branch manifest.
 * Update is always user-initiated — no silent auto-install.
 */

export const GITHUB_OWNER = 'Republic-of-Grip';
export const GITHUB_REPO = 'GAF';
export const GITHUB_DEFAULT_BRANCH = 'main';

export const UPDATE_APPLY_HINT =
  'Download the zip, extract it over your GAF folder, then click Reload on the Extensions page.';

const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

export function normalizeVersion(input) {
  return String(input ?? '')
    .trim()
    .replace(/^v/i, '');
}

/** @returns {-1 | 0 | 1} */
export function compareVersions(a, b) {
  const pa = normalizeVersion(a)
    .split('.')
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pb = normalizeVersion(b)
    .split('.')
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const n = Math.max(pa.length, pb.length, 1);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export function isRemoteNewer(installed, remote) {
  const a = normalizeVersion(installed);
  const b = normalizeVersion(remote);
  if (!a || !b) return false;
  return compareVersions(a, b) < 0;
}

export function readInstalledVersion(chromeLike = globalThis.chrome) {
  try {
    const version = chromeLike?.runtime?.getManifest?.()?.version;
    return normalizeVersion(version);
  } catch {
    return '';
  }
}

export function extensionsPageUrl(userAgent = globalThis.navigator?.userAgent || '') {
  return /Helium/i.test(userAgent) ? 'helium://extensions' : 'chrome://extensions';
}

export function formatUpdateStatus(result) {
  if (!result || result.status === 'error') {
    return result?.error || 'Could not check GitHub for a newer GAF version.';
  }
  if (result.status === 'available') {
    return `A newer version is available: ${result.installed} → ${result.remote}.`;
  }
  return `You're on the latest version (${result.installed}).`;
}

export function githubApiUrl(path, { owner = GITHUB_OWNER, repo = GITHUB_REPO } = {}) {
  return `https://api.github.com/repos/${owner}/${repo}${path}`;
}

export function githubArchiveZipUrl(ref, { owner = GITHUB_OWNER, repo = GITHUB_REPO, isBranch = false } = {}) {
  const kind = isBranch ? 'heads' : 'tags';
  return `https://github.com/${owner}/${repo}/archive/refs/${kind}/${encodeURIComponent(ref)}.zip`;
}

export function githubRepoUrl({ owner = GITHUB_OWNER, repo = GITHUB_REPO } = {}) {
  return `https://github.com/${owner}/${repo}`;
}

export function githubManifestUrl({
  owner = GITHUB_OWNER,
  repo = GITHUB_REPO,
  branch = GITHUB_DEFAULT_BRANCH,
} = {}) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/manifest.json`;
}

export function isOfflineError(err) {
  if (!err) return false;
  if (err.offline) return true;
  if (err.name === 'TypeError') return true;
  const msg = String(err.message || err);
  return /failed to fetch|networkerror|err_internet_offline|offline|network request failed/i.test(msg);
}

export function updateCheckErrorMessage(err) {
  if (isOfflineError(err)) {
    return 'Could not reach GitHub. Check your connection and try again.';
  }
  return 'Could not check GitHub for a newer GAF version.';
}

async function fetchNetwork(fetchFn, url, init) {
  try {
    return await fetchFn(url, init);
  } catch (err) {
    const wrapped = new Error(updateCheckErrorMessage(err));
    wrapped.offline = isOfflineError(err);
    wrapped.cause = err;
    throw wrapped;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error('Could not check GitHub for a newer GAF version.');
  }
}

function remoteFromRelease(release, repoOpts) {
  const tag = release?.tag_name || release?.name;
  const version = normalizeVersion(tag);
  if (!version) return null;
  return {
    version,
    source: 'release',
    tag,
    updateUrl: release.html_url || githubRepoUrl(repoOpts),
    zipUrl: githubArchiveZipUrl(tag, repoOpts),
  };
}

function remoteFromTag(tag, repoOpts) {
  const name = tag?.name;
  const version = normalizeVersion(name);
  if (!version) return null;
  return {
    version,
    source: 'tag',
    tag: name,
    updateUrl: `${githubRepoUrl(repoOpts)}/releases/tag/${encodeURIComponent(name)}`,
    zipUrl: githubArchiveZipUrl(name, repoOpts),
  };
}

function remoteFromManifest(manifest, repoOpts) {
  const version = normalizeVersion(manifest?.version);
  if (!version) return null;
  const branch = repoOpts.branch || GITHUB_DEFAULT_BRANCH;
  return {
    version,
    source: 'manifest',
    tag: branch,
    updateUrl: githubRepoUrl(repoOpts),
    zipUrl: githubArchiveZipUrl(branch, { ...repoOpts, isBranch: true }),
  };
}

function highestVersionRemote(remotes) {
  return remotes.reduce((best, cur) => {
    if (!best) return cur;
    return compareVersions(cur.version, best.version) > 0 ? cur : best;
  }, null);
}

/**
 * Prefer a GitHub release, then the highest semver tag, then default-branch manifest.json.
 * A 404 on releases/tags is not a failure — this repo often has neither.
 */
export async function fetchLatestPublishedVersion(fetchFn = globalThis.fetch, repoOpts = {}) {
  const opts = {
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    branch: GITHUB_DEFAULT_BRANCH,
    ...repoOpts,
  };

  const latestReleaseRes = await fetchNetwork(
    fetchFn,
    githubApiUrl('/releases/latest', opts),
    { headers: API_HEADERS }
  );
  if (latestReleaseRes.ok) {
    const remote = remoteFromRelease(await readJson(latestReleaseRes), opts);
    if (remote) return remote;
  } else if (latestReleaseRes.status !== 404) {
    throw new Error('Could not check GitHub for a newer GAF version.');
  }

  const tagsRes = await fetchNetwork(fetchFn, githubApiUrl('/tags?per_page=100', opts), {
    headers: API_HEADERS,
  });
  if (tagsRes.ok) {
    const tags = await readJson(tagsRes);
    if (Array.isArray(tags) && tags.length) {
      const remotes = tags.map((tag) => remoteFromTag(tag, opts)).filter(Boolean);
      const best = highestVersionRemote(remotes);
      if (best) return best;
    }
  } else if (tagsRes.status !== 404) {
    throw new Error('Could not check GitHub for a newer GAF version.');
  }

  const manifestRes = await fetchNetwork(fetchFn, githubManifestUrl(opts));
  if (!manifestRes.ok) {
    throw new Error('Could not check GitHub for a newer GAF version.');
  }
  const remote = remoteFromManifest(await readJson(manifestRes), opts);
  if (!remote) {
    throw new Error('Could not check GitHub for a newer GAF version.');
  }
  return remote;
}

export async function checkForUpdates({
  fetch: fetchFn = globalThis.fetch,
  installed,
  owner = GITHUB_OWNER,
  repo = GITHUB_REPO,
  branch = GITHUB_DEFAULT_BRANCH,
} = {}) {
  const installedVersion = normalizeVersion(installed);
  if (!installedVersion) {
    return {
      status: 'error',
      installed: '',
      error: 'Could not read the installed GAF version.',
    };
  }

  try {
    const remote = await fetchLatestPublishedVersion(fetchFn, { owner, repo, branch });
    if (isRemoteNewer(installedVersion, remote.version)) {
      return {
        status: 'available',
        installed: installedVersion,
        remote: remote.version,
        source: remote.source,
        updateUrl: remote.updateUrl,
        zipUrl: remote.zipUrl,
      };
    }
    return {
      status: 'current',
      installed: installedVersion,
      remote: remote.version,
      source: remote.source,
    };
  } catch (err) {
    return {
      status: 'error',
      installed: installedVersion,
      error: updateCheckErrorMessage(err),
    };
  }
}

export async function openUpdate(result, { openUrl, extensionsUrl } = {}) {
  if (typeof openUrl !== 'function') {
    throw new Error('openUrl is required');
  }
  const target = result?.zipUrl || result?.updateUrl;
  if (target) await openUrl(target);
  if (extensionsUrl) await openUrl(extensionsUrl);
}

/**
 * Shared Options / popup wiring. Injected deps keep this testable.
 */
export function bindUpdateControls({
  checkButton,
  updateButton,
  statusElement,
  installedVersionElements = [],
  getInstalledVersion,
  openUrl,
  getExtensionsPageUrl = extensionsPageUrl,
  check = checkForUpdates,
} = {}) {
  const installed = normalizeVersion(
    typeof getInstalledVersion === 'function' ? getInstalledVersion() : ''
  );
  for (const el of installedVersionElements) {
    if (!el) continue;
    if (el.dataset?.versionTemplate) {
      el.textContent = el.dataset.versionTemplate.replace('{version}', installed || '?');
    } else {
      el.textContent = installed || '—';
    }
  }

  if (updateButton) updateButton.hidden = true;

  let lastResult = null;

  async function runCheck() {
    if (statusElement) statusElement.textContent = 'Checking GitHub…';
    if (updateButton) updateButton.hidden = true;
    lastResult = await check({ installed });
    if (statusElement) statusElement.textContent = formatUpdateStatus(lastResult);
    if (updateButton) updateButton.hidden = lastResult.status !== 'available';
    return lastResult;
  }

  async function runUpdate() {
    if (!lastResult || lastResult.status !== 'available') return lastResult;
    if (statusElement) statusElement.textContent = UPDATE_APPLY_HINT;
    await openUpdate(lastResult, {
      openUrl,
      extensionsUrl: typeof getExtensionsPageUrl === 'function' ? getExtensionsPageUrl() : getExtensionsPageUrl,
    });
    return lastResult;
  }

  checkButton?.addEventListener?.('click', () => {
    runCheck().catch((err) => {
      lastResult = {
        status: 'error',
        installed,
        error: updateCheckErrorMessage(err),
      };
      if (statusElement) statusElement.textContent = lastResult.error;
      if (updateButton) updateButton.hidden = true;
    });
  });

  updateButton?.addEventListener?.('click', () => {
    runUpdate().catch((err) => {
      if (statusElement) {
        statusElement.textContent = updateCheckErrorMessage(err);
      }
    });
  });

  return { runCheck, runUpdate, getLastResult: () => lastResult };
}
