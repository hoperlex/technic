#!/usr/bin/env node
/**
 * `pnpm check:version` — consistency of the portal version across its three places.
 *
 * WHY. A release number lives in three places: the `VERSION` file, an annotated tag `v<version>` on
 * the commit that brought the release migration, and the `app_releases` row that migration inserts.
 * They drift apart silently: the migration is written by hand, the tag is placed by a person after
 * the push, and the file is edited before both. Drift surfaces last and worst — when someone tries
 * to tell from the version what exactly runs in production.
 *
 * WHY MIGRATIONS AND NOT THE DATABASE. The check has to work on any machine and without a database:
 * it compares the repository's intent, not a server's state. The release row in a migration is that
 * intent, and it is exactly what reaches production.
 *
 * MODES.
 *   default   VERSION against the latest release row, release numbers within a line, the decision
 *             tail, and every release at or above `tag.since` that has no tag yet (one warning each,
 *             not only the current one: an old gap is as real as a fresh one). A missing tag is a
 *             warning because the check also runs before the push, when tagging is premature.
 *   --tags    audit of the existing `v*` tags: each must be annotated and peel (`^{commit}`) to
 *             exactly the commit that added its release migration. A mismatch is an error: a tag
 *             that looks like a fact but points elsewhere is worse than no tag (ADR 0191, §4).
 *   --remote  compare local tags with `git ls-remote --tags origin`, read-only. An unpushed tag is a
 *             warning (the push is the next step, not a defect); a tag that differs from origin is
 *             an error, because two machines would then disagree about the same release.
 *
 * WHAT IT DOES NOT DO. It never creates, moves or pushes tags — only the person who pushed the
 * release commit does that, and a script moving a published tag would rewrite what others already
 * fetched. It says nothing about deployment either: a tag means "the release is built", and what is
 * deployed is answered by `deploy-auto --status`. It is not part of `pnpm check`: the gates check
 * code, and a red release state must not block everyday development.
 *
 * The threshold and both exact sets (known number collisions, known shared release commits) are
 * read from the policy rather than copied here: a second copy of an exact set drifts from the first
 * without anyone noticing, which is the very failure this check exists to catch.
 *
 * Rules: architecture/policies/versioning.yaml. Decision: docs/adr/0191-version-numbering.md.
 */
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = 'architecture/policies/versioning.yaml';
// Posix form on purpose: the same string is a filesystem path and a git pathspec.
const DRIZZLE_DIR = 'apps/api/drizzle';
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([0-9]{4})$/;
const RELEASE_TAG = /^v(.+)$/;

/** Parsed number. Versions cannot be compared as strings: "0.1.10" would sort before "0.1.9". */
export function parseVersion(version) {
  const m = VERSION_PATTERN.exec(version);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], release: +m[3], decision: m[4], raw: version };
}

/**
 * Order of releases: line first, then the number within the line. The decision tail is ignored
 * because it only repeats that order (ADR 0191, §1) and the two known collisions share a number.
 */
export function compareReleases(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.release - b.release;
}

function sameSet(a, b) {
  return [...a].sort().join('|') === [...b].sort().join('|');
}

const short = (sha) => sha.slice(0, 8);

/**
 * Policy data the check executes. Exact sets are validated here rather than trusted: a malformed
 * entry would otherwise match nothing and silently turn every known case into a new one.
 */
export function loadPolicy(root) {
  const doc = parseYaml(readFileSync(path.join(root, POLICY_FILE), 'utf8')) ?? {};
  const since = parseVersion(String(doc.sources?.tag?.since ?? ''));
  if (!since) throw new Error(`${POLICY_FILE}: sources.tag.since не разбирается как версия.`);
  const sets = (key) => {
    const list = doc[key] ?? [];
    if (!Array.isArray(list)) throw new Error(`${POLICY_FILE}: ${key} — не список.`);
    return list.map((entry, i) => {
      const versions = Array.isArray(entry?.versions) ? entry.versions.map(String) : [];
      if (versions.length < 2 || !versions.every((v) => parseVersion(v))) {
        throw new Error(`${POLICY_FILE}: ${key}[${i}].versions — нужно не меньше двух версий.`);
      }
      return { versions, commit: entry.commit == null ? null : String(entry.commit) };
    });
  };
  return {
    since,
    knownCollisions: sets('knownCollisions'),
    knownSharedCommits: sets('knownSharedReleaseCommits'),
  };
}

/**
 * Every release row from migrations, one entry per version and file. All rows are read, not the
 * last file by name: migration numbers and release numbers are separate streams, and the
 * alphabetically last file need not carry the latest release.
 */
export function readReleases(root) {
  const dir = path.join(root, DRIZZLE_DIR);
  const releases = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(path.join(dir, name), 'utf8');
    if (!/INSERT\s+INTO\s+app_releases/i.test(sql)) continue;
    // A rollback hint in a comment repeats the version; counting it twice would fake a collision.
    const versions = new Set([...sql.matchAll(/'(\d+\.\d+\.\d+\.\d{4})'/g)].map((m) => m[1]));
    for (const version of versions) {
      const parsed = parseVersion(version);
      if (parsed) releases.push({ ...parsed, file: name });
    }
  }
  return releases;
}

function git(root, args, extra = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      ...extra,
    });
    return { ok: true, out };
  } catch (error) {
    const err = String(error.stderr || error.message || '').trim();
    return { ok: false, out: '', err: err.split('\n')[0] || 'без сообщения' };
  }
}

/**
 * The commit that added each migration file, from one walk of HEAD's history.
 *
 * The oldest adding commit wins, matching `git log --diff-filter=A -- <file> | tail -1`, the
 * command the tags were restored with. `--no-renames` keeps the answer independent of local diff
 * settings. `null` means git did not answer (not a repository), which the caller reports instead
 * of treating every tag as wrong.
 */
export function migrationAddCommits(root) {
  const res = git(root, [
    'log',
    '--diff-filter=A',
    '--no-renames',
    '--format=@%H',
    '--name-only',
    '--',
    DRIZZLE_DIR,
  ]);
  if (!res.ok) return null;
  const map = new Map();
  let commit = null;
  for (const line of res.out.split('\n')) {
    if (line.startsWith('@')) commit = line.slice(1);
    // The log runs newest first, so a later line overwrites with an older commit.
    else if (line.trim() !== '' && commit) map.set(path.posix.basename(line.trim()), commit);
  }
  return map;
}

/**
 * Local `v*` tags. `commit` is the peeled target; `annotated` is false for a lightweight tag, whose
 * ref points straight at the commit and carries neither author nor date nor message.
 */
export function localTags(root) {
  const res = git(root, [
    'for-each-ref',
    '--format=%(refname:strip=2)%09%(objecttype)%09%(objectname)%09%(*objecttype)%09%(*objectname)',
    'refs/tags/v*',
  ]);
  if (!res.ok) return null;
  const tags = new Map();
  for (const line of res.out.split('\n')) {
    if (line.trim() === '') continue;
    const [name, type, object, peeledType, peeled] = line.split('\t');
    let commit = null;
    if (type === 'commit') commit = object;
    else if (type === 'tag' && peeledType === 'commit') commit = peeled;
    tags.set(name, { name, object, commit, annotated: type === 'tag' });
  }
  return tags;
}

/** Tags on origin, read-only. `commit` is the peeled line (`^{}`) when the tag is annotated. */
export function remoteTags(root, remote = 'origin') {
  const res = git(root, ['ls-remote', '--tags', remote], {
    timeout: 60_000,
    // A credential prompt would hang an unattended run instead of failing it.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (!res.ok) return { error: res.err, tags: null };
  const tags = new Map();
  for (const line of res.out.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!ref?.startsWith('refs/tags/')) continue;
    const peeled = ref.endsWith('^{}');
    const name = ref.slice('refs/tags/'.length, peeled ? -3 : undefined);
    const entry = tags.get(name) ?? { object: null, commit: null };
    if (peeled) entry.commit = sha;
    else {
      entry.object = sha;
      entry.commit ??= sha;
    }
    tags.set(name, entry);
  }
  return { error: null, tags };
}

function isAncestorOfHead(root, commit) {
  return git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']).ok;
}

function versionAt(root, commit) {
  const res = git(root, ['show', `${commit}:VERSION`]);
  return res.ok ? res.out.trim() : null;
}

/**
 * The whole check as data. `process.exit` stays out of here so the rules can be exercised on
 * fixture repositories (`scripts/check-version.test.mjs`) instead of only on the live tree.
 */
export function checkVersion({ root = ROOT, tags: auditTags = false, remote = false } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const summary = [];
  const result = { declared: null, releases: [], errors, warnings, notes, summary };

  // ── 1. VERSION ─────────────────────────────────────────────────────────────
  const versionFile = path.join(root, 'VERSION');
  if (!existsSync(versionFile)) {
    errors.push('нет файла VERSION — единственного источника версии в репозитории.');
    return result;
  }
  const declared = parseVersion(readFileSync(versionFile, 'utf8').trim());
  if (!declared) {
    errors.push(
      'VERSION не соответствует формату <линия>.<выпуск>.<решение>, например 0.1.82.0190.',
    );
    return result;
  }
  result.declared = declared;

  let policy;
  try {
    policy = loadPolicy(root);
  } catch (error) {
    errors.push(`политика версий не прочитана: ${error.message}`);
    return result;
  }

  // ── 2. Release rows from migrations ────────────────────────────────────────
  const releases = readReleases(root);
  result.releases = releases;
  if (releases.length === 0) {
    errors.push('в миграциях нет ни одной записи выпуска — сверять версию не с чем.');
    return result;
  }

  const latest = releases.reduce((best, cur) => (compareReleases(cur, best) > 0 ? cur : best));
  if (latest.raw !== declared.raw) {
    errors.push(
      `VERSION (${declared.raw}) расходится с последней записью выпуска в миграциях ` +
        `(${latest.raw}, ${latest.file}).`,
    );
  }

  // ── 3. Release numbers within a line ───────────────────────────────────────
  const isKnownCollision = (a, b) =>
    policy.knownCollisions.some((k) => sameSet(k.versions, [a, b]));
  const byLine = new Map();
  for (const r of releases) {
    const key = `${r.major}.${r.minor}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(r);
  }
  for (const [line, list] of byLine) {
    const seen = new Map();
    for (const r of list) {
      const prev = seen.get(r.release);
      if (prev && prev.raw !== r.raw) {
        if (isKnownCollision(prev.raw, r.raw)) {
          warnings.push(
            `Линия ${line}: номер выпуска ${r.release} занят дважды (${prev.raw} и ${r.raw}) — ` +
              'известная коллизия, перенумеровать поздно.',
          );
        } else {
          errors.push(
            `Линия ${line}: номер выпуска ${r.release} занят дважды — ${prev.raw} и ${r.raw}.`,
          );
        }
      } else if (prev && prev.file !== r.file) {
        // Two migrations inserting one version would also leave the tag audit two candidate
        // commits for one tag.
        errors.push(`Версия ${r.raw} записана двумя миграциями: ${prev.file} и ${r.file}.`);
      }
      seen.set(r.release, r);
    }
  }

  // ── 4. The decision in the tail exists ─────────────────────────────────────
  const adrNumbers = new Set(
    readdirSync(path.join(root, 'docs', 'adr'))
      .map((f) => /^(\d{4})-/.exec(f)?.[1])
      .filter(Boolean),
  );
  if (!adrNumbers.has(declared.decision)) {
    errors.push(
      `Хвост версии ${declared.decision} не соответствует ни одному решению в docs/adr — ` +
        'хвост обязан называть решение, вошедшее в выпуск, либо повторять хвост предыдущего.',
    );
  }

  // ── 5. Release tags ────────────────────────────────────────────────────────
  const since = policy.since;
  const atOrAfterSince = (v) => compareReleases(v, since) >= 0;
  const tagged = releases.filter(atOrAfterSince).sort(compareReleases);
  const releaseByRaw = new Map(releases.map((r) => [r.raw, r]));

  const tags = localTags(root);
  const addCommits = migrationAddCommits(root);
  if (!tags || !addCommits) {
    // A plain run may happen outside a clone; an explicitly requested audit that could not run
    // must not end green.
    (auditTags || remote ? errors : warnings).push(
      'git не ответил — теги выпусков не сверены (дерево не репозиторий?).',
    );
    return result;
  }
  const commitOf = (r) => addCommits.get(r.file) ?? null;

  const untagged = tagged.filter((r) => !tags.has(`v${r.raw}`));
  for (const r of untagged) {
    const commit = commitOf(r);
    warnings.push(
      commit
        ? `Выпуск ${r.raw} не помечен тегом v${r.raw}; его место — ${short(commit)}, коммит, ` +
            `который привёз ${r.file}.`
        : `Выпуск ${r.raw} не помечен тегом v${r.raw}; миграция ${r.file} ещё не закоммичена — ` +
            'тег ставится после пуша её коммита.',
    );
  }
  summary.push(
    `Выпусков с тегом по политике (с ${since.raw}): ${tagged.length}, помечено: ` +
      `${tagged.length - untagged.length}.`,
  );

  // ── 6. Several releases brought by one commit ──────────────────────────────
  // Legal (the commit gets one tag per release), but every new case is named, like collisions:
  // otherwise "two tags on one commit" could no longer be told from a tag placed by mistake.
  const byCommit = new Map();
  for (const r of tagged) {
    const commit = commitOf(r);
    if (!commit) continue;
    if (!byCommit.has(commit)) byCommit.set(commit, []);
    byCommit.get(commit).push(r);
  }
  const knownShared = [];
  for (const [commit, list] of byCommit) {
    if (list.length < 2) continue;
    const versions = list.map((r) => r.raw);
    const known = policy.knownSharedCommits.find((k) => sameSet(k.versions, versions));
    if (known) {
      knownShared.push({ commit, versions });
      if (known.commit && !commit.startsWith(known.commit)) {
        warnings.push(
          `knownSharedReleaseCommits: у выпусков ${versions.join(', ')} записан коммит ` +
            `${known.commit}, а в истории это ${short(commit)} — запись политики устарела.`,
        );
      }
    } else {
      warnings.push(
        `Выпуски ${versions.join(', ')} приехали одним коммитом ${short(commit)}: на нём будет ` +
          'по тегу на каждый выпуск, а VERSION в нём обязан показывать старший. Если так и ' +
          'задумано, впишите множество в knownSharedReleaseCommits политики.',
      );
    }
  }
  for (const k of policy.knownSharedCommits) {
    const members = k.versions.map((v) => releaseByRaw.get(v));
    if (members.some((r) => !r || !commitOf(r))) continue;
    if (new Set(members.map(commitOf)).size > 1) {
      warnings.push(
        `knownSharedReleaseCommits: выпуски ${k.versions.join(', ')} в истории приехали разными ` +
          'коммитами — запись политики устарела.',
      );
    }
  }

  // ── 7. Tag audit (--tags) ──────────────────────────────────────────────────
  if (auditTags) {
    let audited = 0;
    let matched = 0;
    const tagsByCommit = new Map();
    // Numeric collation, or v0.1.100 would be reported before v0.1.83.
    const ordered = [...tags.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'en', { numeric: true }),
    );
    for (const tag of ordered) {
      const version = parseVersion(RELEASE_TAG.exec(tag.name)?.[1] ?? '');
      if (!version) {
        warnings.push(
          `Тег ${tag.name} похож на тег выпуска, но не разбирается как версия — не сверен.`,
        );
        continue;
      }
      if (!atOrAfterSince(version)) {
        warnings.push(
          `Тег ${tag.name} ниже порога ${since.raw}: выпуски до порога тегами не помечаются ` +
            '(retroactive: false), сверять его не с чем.',
        );
        continue;
      }
      audited += 1;
      if (!tag.annotated) {
        errors.push(
          `Тег ${tag.name} лёгкий, а выпуск помечается аннотированным тегом (git tag -a): у лёгкого ` +
            'нет ни автора, ни даты, ни сообщения.',
        );
      }
      if (!tag.commit) {
        errors.push(`Тег ${tag.name} указывает не на коммит.`);
        continue;
      }
      const release = releaseByRaw.get(version.raw);
      if (!release) {
        if (isAncestorOfHead(root, tag.commit)) {
          errors.push(
            `Тег ${tag.name} стоит на ${short(tag.commit)}, но записи выпуска ${version.raw} ` +
              'в миграциях нет.',
          );
        } else {
          notes.push(
            `Тег ${tag.name} стоит вне истории HEAD, и выпуска ${version.raw} в дереве ещё нет — ` +
              'дерево старше тега, сверка пропущена.',
          );
        }
        continue;
      }
      const expected = commitOf(release);
      if (!expected) {
        errors.push(
          `Тег ${tag.name} уже есть, а коммит, который привёз ${release.file}, в истории HEAD не ` +
            'найден: тег поставлен раньше коммита выпуска.',
        );
        continue;
      }
      if (tag.commit !== expected) {
        errors.push(
          `Тег ${tag.name} указывает на ${short(tag.commit)}, а миграцию выпуска ${release.file} ` +
            `привёз ${short(expected)}: тег обязан стоять на коммите миграции.`,
        );
        continue;
      }
      if (tag.annotated) matched += 1;
      if (!tagsByCommit.has(expected)) tagsByCommit.set(expected, []);
      tagsByCommit.get(expected).push(release);
    }

    // At a tagged commit VERSION shows the eldest release that commit brought; a different value
    // means the three places disagreed already at the moment the release was built.
    for (const commit of tagsByCommit.keys()) {
      const brought = (byCommit.get(commit) ?? []).sort(compareReleases);
      const eldest = brought.at(-1);
      const actual = versionAt(root, commit);
      if (eldest && actual !== eldest.raw) {
        warnings.push(
          `На коммите ${short(commit)} VERSION = ${actual ?? 'нет файла'}, а старший выпуск, ` +
            `который он привёз, — ${eldest.raw}.`,
        );
      }
    }
    for (const { commit, versions } of knownShared) {
      notes.push(
        `Выпуски ${versions.join(', ')} приехали одним коммитом ${short(commit)} — по тегу на ` +
          'каждый выпуск на одном коммите, известный случай (knownSharedReleaseCommits).',
      );
    }
    summary.push(
      `Сверено тегов выпуска (--tags): ${audited}, аннотированных на коммитах миграций: ${matched}.`,
    );
  }

  // ── 8. Origin (--remote) ───────────────────────────────────────────────────
  if (remote) {
    const { error, tags: onOrigin } = remoteTags(root);
    if (error) {
      // An explicit request that could not be answered must not look like a clean answer.
      errors.push(`сверка с origin не выполнена: ${error}`);
    } else {
      const isReleaseTag = (name) => {
        const version = parseVersion(RELEASE_TAG.exec(name)?.[1] ?? '');
        return version !== null && atOrAfterSince(version);
      };
      let pushed = 0;
      let local = 0;
      for (const tag of tags.values()) {
        if (!isReleaseTag(tag.name)) continue;
        local += 1;
        const there = onOrigin.get(tag.name);
        if (!there) {
          warnings.push(`Тег ${tag.name} не запушен в origin: git push origin ${tag.name}.`);
        } else if (there.commit !== tag.commit) {
          errors.push(
            `Тег ${tag.name} в origin указывает на ${short(there.commit ?? '?')}, а локально — на ` +
              `${short(tag.commit ?? '?')}: две машины называют этим выпуском разные коммиты.`,
          );
        } else {
          pushed += 1;
          if (there.object !== tag.object) {
            warnings.push(
              `Тег ${tag.name} в origin — другой объект тега на том же коммите: тег пересоздан ` +
                'локально после пуша.',
            );
          }
        }
      }
      for (const name of onOrigin.keys()) {
        if (isReleaseTag(name) && !tags.has(name)) {
          warnings.push(`Тег ${name} есть в origin, но не локально: git fetch origin tag ${name}.`);
        }
      }
      summary.push(`Origin (--remote): запушено ${pushed} из ${local} локальных тегов выпуска.`);
    }
  }

  return result;
}

// ── Command line ─────────────────────────────────────────────────────────────
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const out = (text) => process.stdout.write(`${text}\n`);
  const KNOWN_FLAGS = new Set(['--tags', '--remote']);
  // pnpm may forward the `--` separator itself; it carries no meaning here.
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const unknown = args.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    process.stderr.write(
      `Неизвестные аргументы: ${unknown.join(' ')}.\n` +
        'Использование: node scripts/check-version.mjs [--tags] [--remote]\n',
    );
    process.exit(2);
  }
  const result = checkVersion({ tags: args.includes('--tags'), remote: args.includes('--remote') });
  if (result.declared) {
    out(`Версия: ${result.declared.raw}. Записей выпуска в миграциях: ${result.releases.length}.`);
  }
  for (const line of result.summary) out(line);
  for (const n of result.notes) out(`  примечание: ${n}`);
  for (const w of result.warnings) out(`  предупреждение: ${w}`);
  for (const e of result.errors) out(`  ОШИБКА: ${e}`);
  out(`Ошибок: ${result.errors.length}. Предупреждений: ${result.warnings.length}.`);
  process.exit(result.errors.length > 0 ? 1 : 0);
}
