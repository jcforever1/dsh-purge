#!/usr/bin/env node
/**
 * Generate the DSH plugin market index (format 1) for the dsh-purge bundle from this mirror
 * repository, and validate it with the validator DSH itself ships.
 *
 *   node make-index.mjs [--repo OWNER/NAME] [--ref BRANCH] [--out FILE] [--no-write]
 *
 * Defaults: --repo jcforever1/dsh-purge --ref master --out ./index.json
 *
 * What the generated document says:
 *   - `source.url` + `source.commit`  -> this mirror, the tree a market install actually fetches
 *   - `repository.url` + `author`     -> YuJunZhiXue/dsh-purge, the upstream the code comes from
 *
 * That split is deliberate: the install target must be the mirror, because the mirror is the
 * tree that carries the change below, while attribution must point at the upstream author,
 * because the upstream NOTICE requires it.
 *
 * Which commit gets pinned
 * ------------------------
 * The newest commit that touched the plugin's code, not the newest commit on the branch. The
 * branch also carries this repository's own files (this generator, the index, the mirror
 * notice), and commits that only touch those would otherwise be pinned, which would make the
 * index rewrite itself every run and would report a publish time that is really the time the
 * index was last refreshed. Pinning the newest code commit means the index changes when the
 * plugin changes, and not otherwise.
 *
 * The repository is read through a blobless partial clone, so the full history is available
 * for that lookup without downloading any file contents, and the GitHub API's per-IP rate
 * limit is not involved.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseMarketIndex, marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index';

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? fallback : args[at + 1];
};
const repo = option('repo', 'jcforever1/dsh-purge');
const ref = option('ref', 'master');
const outFile = path.resolve(option('out', path.join(process.cwd(), 'index.json')));
const dryRun = args.includes('--no-write');

/** The paths that hold the plugin's code. A commit that touches none of them is not a release. */
const codePaths = (option('code-paths', 'lib bin presets cordis.patch.yml client.js package.json'))
    .split(/\s+/)
    .filter(Boolean);

const raw = `https://raw.githubusercontent.com/${repo}/${ref}`;

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/**
 * A blobless clone of the whole history: file contents are fetched only for the few paths this
 * script reads, and the commit lookup below needs the history, not the working tree.
 */
function cloneRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-market-index-'));
    execFileSync('git', [
        'clone', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', ref,
        '--quiet', `https://github.com/${repo}.git`, dir,
    ], { stdio: 'ignore' });
    return dir;
}

console.log(`source: ${repo}@${ref}`);

const dir = cloneRepo();
try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    // The newest commit that actually changed the plugin. `git log` with pathspecs needs the
    // history, which the blobless clone has.
    const pinned = git(dir, ['log', '-1', '--format=%H', '--', ...codePaths]);
    if (!pinned) throw new Error(`no commit touches the plugin code in ${repo}@${ref}`);
    const date = git(dir, ['show', '-s', '--format=%cI', pinned]);
    const publishTimestamp = Math.floor(new Date(date).getTime() / 1000);
    console.log(`branch head : ${head}`);
    console.log(`pinned      : ${pinned}  (${date})`);

    /** A file from the pinned commit, which is the tree an install actually gets. */
    const readAt = (relative) => {
        try {
            return git(dir, ['show', `${pinned}:${relative}`]);
        } catch {
            return undefined;
        }
    };

    const manifest = JSON.parse(readAt('package.json'));
    const name = manifest.name;
    const version = manifest.version;
    const description = manifest.description ?? name;

    /** The market's git source needs a canonical https URL; npm's `git+https://….git` is not one. */
    function canonicalGitUrl(value) {
        const url = value.replace(/^git\+/, '').replace(/\.git$/, '').replace(/#.*$/, '');
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') throw new Error(`repository.url must be https: ${value}`);
        return parsed.href;
    }

    /** Where the install actually comes from: this mirror. */
    const installUrl = canonicalGitUrl(`https://github.com/${repo}`);
    /** Where the code originally comes from: the upstream author, per the upstream NOTICE. */
    const repositoryUrl = canonicalGitUrl(manifest.repository?.url ?? installUrl);
    const owner = new URL(repositoryUrl).pathname.split('/').filter(Boolean)[0] ?? 'unknown';
    const author = (typeof manifest.author === 'string' ? manifest.author : manifest.author?.name) ?? owner;

    /**
     * A relative icon resolves against the index URL, so it breaks when the index moves hosts.
     * Use an absolute https URL. The asset comes from the upstream repository, so the artwork
     * stays with the author's own copy.
     */
    const assetRepo = new URL(repositoryUrl).pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    let icon;
    for (const candidate of ['docs/banner.svg', 'icon.svg', 'docs/icon.svg']) {
        const probe = await fetch(`https://raw.githubusercontent.com/${assetRepo}/${ref}/${candidate}`, {
            method: 'HEAD', headers: { 'user-agent': 'dsh-market-index' },
        });
        if (probe.ok) { icon = `https://raw.githubusercontent.com/${assetRepo}/${ref}/${candidate}`; break; }
    }
    if (icon === undefined) console.log('note: no icon found upstream; the entry will use the default artwork');

    const dshRange = manifest.dshTarget ? `>=${manifest.dshTarget}` : undefined;

    const index = {
        format: 1,
        title: name,
        description: { en: description, zh: description },
        metadata: {
            categories: { general: { title: { en: 'General', zh: '通用' } } },
            labels: {},
            sortKeys: {},
        },
        plugins: [
            {
                name,
                title: { en: name, zh: name },
                description: { en: description, zh: description },
                author,
                ...(icon === undefined ? {} : { icon }),
                homepage: manifest.homepage ?? repositoryUrl,
                repository: { url: repositoryUrl },
                metadata: {
                    category: 'general',
                    keywords: [...new Set(['dsh', 'plugin', ...(manifest.keywords ?? [])])].slice(0, 12),
                    labels: [],
                },
                versions: [
                    {
                        version,
                        publishTimestamp,
                        source: { type: 'git', url: installUrl, commit: pinned },
                        ...(dshRange === undefined ? {} : { engines: { dsh: dshRange } }),
                    },
                ],
            },
        ],
    };

    // Validate with the validator DSH ships; refuse to emit an invalid index.
    const validated = parseMarketIndex(index, 'https://raw.githubusercontent.com/OWNER/REPO/main/index.json');

    const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    const next = `${JSON.stringify(index, null, 2)}\n`;
    if (current === next) {
        console.log(`${outFile} is already current — nothing to write`);
    } else if (!dryRun) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, next);
        console.log(`wrote ${outFile}`);
    }
    console.log(`  format   : ${validated.format}`);
    console.log(`  plugin   : ${name} v${version}`);
    console.log(`  install  : ${marketInstallTarget(name, validated.plugins[0].versions[0]).spec}`);
    console.log(`  source   : ${installUrl} @ ${pinned}`);
    console.log(`  upstream : ${repositoryUrl} (author ${author})`);
    console.log(`  engines  : ${JSON.stringify(validated.plugins[0].versions[0].engines.dsh)}`);
    console.log('  VALID against @deepseek-ai/dsh-plugin-market-index');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
