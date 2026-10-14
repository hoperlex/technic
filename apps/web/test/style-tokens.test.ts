import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { theme as antdTheme } from 'antd';
import { themeFor } from '../src/theme';

/**
 * The :root tokens of styles.css (FSD plan, section 6) against the antd theme they mirror.
 *
 * A token cannot be derived from antd's own CSS variables: antd 6 declares them on the css-var
 * class of its component roots, and a :root property written as var(--ant-…) computes to nothing
 * at :root and is inherited as nothing. So the stylesheet repeats the value, and this test holds
 * it equal to what antd computes for the portal theme. A change of theme.ts, or an antd upgrade
 * that moves a default, fails here instead of leaving the hand-written rules a shade off the antd
 * controls beside them.
 *
 * Every token is either mirrored or declared the portal's own, so a new one cannot slip in without
 * that decision. The file is read from disk: an asset import would hand the test a URL instead
 * (see driver-cabinet.test.tsx).
 */
const src = join(import.meta.dirname, '../src');
const stylesCss = readFileSync(join(src, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type DesignToken = ReturnType<typeof antdTheme.getDesignToken>;

const MIRRORED: Record<string, keyof DesignToken> = {
  '--gap-xxs': 'sizeXXS',
  '--gap-xs': 'sizeXS',
  '--gap-sm': 'sizeSM',
  '--gap': 'size',
  '--gap-lg': 'sizeLG',
  '--gap-xxl': 'sizeXXL',
  '--radius': 'borderRadius',
  '--radius-lg': 'borderRadiusLG',
  '--text-secondary': 'colorTextSecondary',
  '--text-description': 'colorTextDescription',
  '--text-disabled': 'colorTextDisabled',
  '--color-primary': 'colorPrimary',
  '--color-primary-hover': 'colorPrimaryHover',
  '--color-primary-bg': 'colorPrimaryBg',
  '--bg-container': 'colorBgContainer',
  '--fill-tertiary': 'colorFillTertiary',
};

/** No antd counterpart: the reason stands next to each one in styles.css. */
const OWN = [
  '--text-icon',
  '--line-split',
  '--mobile-bar-height',
  '--z-raised',
  '--z-fab',
  '--z-sider-toggle',
];

/** The first capture group of every match: the regexes below always have exactly one. */
function captures(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1] ?? '');
}

function rootTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const block of captures(stylesCss, /(?:^|\})\s*:root\s*\{([^}]*)\}/g))
    for (const declaration of captures(block, /(--[\w-]+\s*:[^;]+);/g)) {
      const colon = declaration.indexOf(':');
      tokens.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
  return tokens;
}

/** `#fff` and `rgba(0, 0, 0, 0.45)` as antd prints them: `#ffffff`, `rgba(0,0,0,0.45)`. */
function canonical(value: string | number): string {
  if (typeof value === 'number') return `${value}px`;
  const v = value.replace(/\s+/g, '').toLowerCase();
  return /^#[0-9a-f]{3}$/.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join('')}` : v;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

describe('style tokens', () => {
  const tokens = rootTokens();
  const declared = [...tokens.keys()].filter((name) => !name.startsWith('--safe-'));

  it('every token is either mirrored from the theme or the portal’s own', () => {
    expect(declared.sort()).toEqual([...Object.keys(MIRRORED), ...OWN].sort());
  });

  it.each([
    { mode: 'desktop', isMobile: false },
    { mode: 'phone', isMobile: true },
  ])('mirrored tokens equal what antd computes for the $mode theme', ({ isMobile }) => {
    const computed = antdTheme.getDesignToken(themeFor(isMobile));
    const pairs = Object.entries(MIRRORED).map(([name, key]) => [
      name,
      canonical(tokens.get(name) ?? '(missing)'),
      canonical(computed[key] as string | number),
    ]);
    expect(pairs.filter(([, css, antd]) => css !== antd)).toEqual([]);
  });

  it('every token a rule or an inline style refers to is declared', () => {
    // A misspelt var() computes to nothing and the property silently falls back, so a reference
    // that no :root declares is an error. antd's own variables and the ones a component sets inline
    // (the driver scale, the view-field columns) are not tokens.
    const files = sources(src).map((path) => readFileSync(path, 'utf8'));
    const setInline = new Set(files.flatMap((f) => captures(f, /['"](--[\w-]+)['"]\s*:/g)));
    const unknown = new Set<string>();
    for (const file of files)
      for (const name of captures(file, /var\((--[\w-]+)/g))
        if (!name.startsWith('--ant-') && !setInline.has(name) && !tokens.has(name))
          unknown.add(name);
    expect([...unknown]).toEqual([]);
  });
});
