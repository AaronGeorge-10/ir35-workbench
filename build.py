#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IR35 Workbench — per-client build.

There is ONE source file: src/workbench.html.
Every client instance is GENERATED from it plus clients/<name>.json.
Never hand-edit a generated folder: your change will be overwritten on the
next build, and the three builds will drift apart again (debt register B-03).

Usage:
    python3 build.py            # rebuild every client in clients/
    python3 build.py orsted     # rebuild one client
    python3 build.py --check    # verify the committed output matches a fresh
                                # build; exit 1 if not. Use this in review.
"""
import io, json, os, shutil, sys, hashlib

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src', 'workbench.html')
CLIENTS = os.path.join(ROOT, 'clients')
ASSETS = os.path.join(ROOT, 'assets')

REQUIRED = ['folder', 'CLIENT_ID', 'TENANT_NAME', 'TENANT_SHORT', 'SECTOR',
            'ADVISER_NAME', 'INTERNAL_REVIEWER', 'SUPABASE_URL',
            'SUPABASE_ANON_KEY', 'ANALYZER_URL']

BANNER = ('<!-- GENERATED FILE - DO NOT EDIT.\n'
          '     Source: src/workbench.html + clients/%s.json\n'
          '     Rebuild: python3 build.py %s -->\n')


def render(cfg, name):
    s = io.open(SRC, encoding='utf-8').read()
    for key in REQUIRED:
        if key == 'folder':
            continue
        token = '{{%s}}' % key
        if token not in s:
            sys.exit('FAIL: token %s not present in src/workbench.html' % token)
        s = s.replace(token, cfg[key])
    left = [ln for ln in s.split('\n') if '{{' in ln and '}}' in ln]
    if left:
        sys.exit('FAIL: unsubstituted token remains: %s' % left[0][:120])
    return BANNER % (name, name) + s


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
    out_file = os.path.join(out_dir, 'index.html')
    html = render(cfg, name)

    if check:
        if not os.path.exists(out_file):
            print('  MISSING  %s' % out_file); return False
        cur = io.open(out_file, encoding='utf-8').read()
        ok = (cur == html)
        print('  %s  %s' % ('OK      ' if ok else 'STALE   ', cfg['folder'] + '/index.html'))
        return ok

    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    io.open(out_file, 'w', encoding='utf-8', newline='').write(html)
    for item in sorted(os.listdir(ASSETS)):
        src_p = os.path.join(ASSETS, item)
        dst_p = os.path.join(out_dir, item)
        if os.path.isdir(src_p):
            if os.path.isdir(dst_p):
                shutil.rmtree(dst_p)
            shutil.copytree(src_p, dst_p)
        else:
            shutil.copy2(src_p, dst_p)
    digest = hashlib.sha256(html.encode('utf-8')).hexdigest()[:12]
    print('  built    %s/index.html  (%d bytes, sha256 %s)'
          % (cfg['folder'], len(html.encode('utf-8')), digest))
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
