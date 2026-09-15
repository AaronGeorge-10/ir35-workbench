#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IR35 Workbench — per-client build.

There is ONE source file per artefact:
    src/workbench.html        the application
    src/guide_hirer.html      the hirer user guide
    src/guide_contractor.html the contractor user guide

Every client instance is GENERATED from those plus clients/<name>.json.
Never hand-edit a generated folder: your change will be overwritten on the
next build, and the builds will drift apart again (debt register B-03).

The guides are generated for the same reason the application is. They used to
be PDFs sitting in assets/ and copied verbatim into every client folder, so
they carried one client's name, URL and access code into every other client's
build, and went stale the moment the application changed (debt register B-09).

Usage:
    python3 build.py            # rebuild every client in clients/
    python3 build.py orsted     # rebuild one client
    python3 build.py --check    # verify the committed output matches a fresh
                                # build; exit 1 if not. Use this in review.
"""
import base64, io, json, os, re, shutil, sys, hashlib

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src', 'workbench.html')
CLIENTS = os.path.join(ROOT, 'clients')
ASSETS = os.path.join(ROOT, 'assets')
CNAME = os.path.join(ROOT, 'CNAME')
LOGOS = os.path.join(ROOT, 'clients', 'logos')

# WORKER_TERM* is the noun the client uses for the person being assessed.
# Orsted say "consultant"; the default everywhere else is "contractor". It is
# COPY ONLY - the role key, the database columns and the RPC names stay
# 'contractor' in every build, so the term can differ per client without the
# schema or the auth model differing at all.
REQUIRED = ['folder', 'CLIENT_ID', 'TENANT_NAME', 'TENANT_SHORT', 'SECTOR',
            'ADVISER_NAME', 'INTERNAL_REVIEWER', 'SUPABASE_URL',
            'SUPABASE_ANON_KEY', 'ANALYZER_URL',
            'WORKER_TERM', 'WORKER_TERM_CAP', 'WORKER_TERM_PLURAL']

# source file -> path inside the client folder
GUIDES = [('guide_hirer.html', os.path.join('guides', 'hirer.html')),
          ('guide_contractor.html', os.path.join('guides', 'contractor.html'))]

BANNER = ('<!-- GENERATED FILE - DO NOT EDIT.\n'
          '     Source: src/%s + clients/%s.json\n'
          '     Rebuild: python3 build.py %s -->\n')


def site_base():
    """The live origin, taken from CNAME so it cannot drift from what is served."""
    host = io.open(CNAME, encoding='utf-8').read().strip()
    if not host:
        sys.exit('FAIL: CNAME is empty; cannot derive the live URL')
    return 'https://' + host


def ruleset_version():
    """Read the version out of the application, so a guide can never quote a
       ruleset the application is no longer running."""
    s = io.open(SRC, encoding='utf-8').read()
    m = re.search(r"RULESET_VERSION\s*=\s*'([^']+)'", s)
    if not m:
        sys.exit('FAIL: RULESET_VERSION not found in src/workbench.html')
    return m.group(1)


def client_logo(cfg):
    """The END-HIRER's logo as a data URI.

       Under Chapter 10 the CLIENT makes and issues the determination, so the
       statement must read as theirs, not as Ascend's. The mark is inlined
       rather than linked so a printed or saved SDS cannot lose it.

       No silent fallback: a missing logo FAILS the build. A statement that
       quietly loses its issuer's mark is worse than a build that stops."""
    path = os.path.join(LOGOS, '%s.png' % cfg['folder'])
    if not os.path.exists(path):
        sys.exit('FAIL: no client logo at clients/logos/%s.png - the SDS must '
                 'carry the end-hirer mark, so the build will not guess one'
                 % cfg['folder'])
    raw = io.open(path, 'rb').read()
    if not raw.startswith(b'\x89PNG'):
        sys.exit('FAIL: clients/logos/%s.png is not a PNG' % cfg['folder'])
    return 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii')


def tokens(cfg):
    """Every substitutable value: the client config plus derived values."""
    t = dict((k, cfg[k]) for k in REQUIRED if k != 'folder')
    t['CLIENT_URL'] = '%s/%s/' % (site_base(), cfg['folder'])
    t['RULESET_VERSION'] = ruleset_version()
    t['CLIENT_LOGO'] = client_logo(cfg)
    return t


def subst(text, t, where):
    for key, val in t.items():
        text = text.replace('{{%s}}' % key, val)
    left = [ln for ln in text.split('\n') if '{{' in ln and '}}' in ln]
    if left:
        sys.exit('FAIL: unsubstituted token remains in %s: %s' % (where, left[0].strip()[:120]))
    return text


def render_app(cfg, name):
    s = io.open(SRC, encoding='utf-8').read()
    for key in REQUIRED:
        if key == 'folder':
            continue
        if '{{%s}}' % key not in s:
            sys.exit('FAIL: token {{%s}} not present in src/workbench.html' % key)
    body = subst(s, tokens(cfg), 'src/workbench.html')
    return BANNER % ('workbench.html', name, name) + body


def render_guide(cfg, name, src_name):
    path = os.path.join(ROOT, 'src', src_name)
    body = subst(io.open(path, encoding='utf-8').read(), tokens(cfg), 'src/' + src_name)
    return BANNER % (src_name, name, name) + body


def outputs(cfg, name):
    """[(path relative to the client folder, expected content), ...]"""
    out = [('index.html', render_app(cfg, name))]
    for src_name, rel in GUIDES:
        out.append((rel, render_guide(cfg, name, src_name)))
    return out


def load(name):
    path = os.path.join(CLIENTS, name + '.json')
    cfg = json.load(io.open(path, encoding='utf-8'))
    missing = [k for k in REQUIRED if k not in cfg or not str(cfg[k]).strip()]
    if missing:
        sys.exit('FAIL: %s.json missing required keys: %s' % (name, missing))
    if cfg['folder'] != cfg['folder'].lower():
        sys.exit('FAIL: %s.json folder must be lowercase (GitHub Pages paths '
                 'are case-sensitive; see debt register B-03)' % name)
    return cfg


def clients():
    return sorted(f[:-5] for f in os.listdir(CLIENTS)
                  if f.endswith('.json') and not f.startswith('_'))


def build(name, check=False):
    cfg = load(name)
    out_dir = os.path.join(ROOT, cfg['folder'])
    files = outputs(cfg, name)

    if check:
        ok = True
        for rel, html in files:
            p = os.path.join(out_dir, rel)
            if not os.path.exists(p):
                print('  MISSING  %s/%s' % (cfg['folder'], rel.replace(os.sep, '/')))
                ok = False
                continue
            same = (io.open(p, encoding='utf-8').read() == html)
            print('  %s  %s/%s' % ('OK      ' if same else 'STALE   ',
                                   cfg['folder'], rel.replace(os.sep, '/')))
            ok = ok and same
        return ok

    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    # assets first: a directory in assets/ replaces its counterpart wholesale,
    # so generated output must be written after it, not before.
    for item in sorted(os.listdir(ASSETS)):
        src_p = os.path.join(ASSETS, item)
        dst_p = os.path.join(out_dir, item)
        if os.path.isdir(src_p):
            if os.path.isdir(dst_p):
                shutil.rmtree(dst_p)
            shutil.copytree(src_p, dst_p)
        else:
            shutil.copy2(src_p, dst_p)
    for rel, html in files:
        p = os.path.join(out_dir, rel)
        d = os.path.dirname(p)
        if d and not os.path.isdir(d):
            os.makedirs(d)
        io.open(p, 'w', encoding='utf-8', newline='').write(html)
        digest = hashlib.sha256(html.encode('utf-8')).hexdigest()[:12]
        print('  built    %s/%s  (%d bytes, sha256 %s)'
              % (cfg['folder'], rel.replace(os.sep, '/'),
                 len(html.encode('utf-8')), digest))
    return True


if __name__ == '__main__':
    args = [a for a in sys.argv[1:]]
    check = '--check' in args
    args = [a for a in args if a != '--check']
    names = args or clients()
    print('%s %d client build(s): %s'
          % ('Checking' if check else 'Building', len(names), ', '.join(names)))
    results = [build(n, check) for n in names]
    if check and not all(results):
        sys.exit('\nFAIL: committed output does not match a fresh build. '
                 'Run: python3 build.py')
    print('Done.')
