#!/usr/bin/env python3
"""
jig's three fixes for Python-Markdown #1651 (results/) next to upstream's (upstream/fix.patch), beyond the three
hidden tests: every fix, the pre-fix code and upstream's render the same generated corpus (seed 1651) with no
extensions, with md_in_html and with extra, and the outputs are compared; then each variant's whole suite,
upstream's three tests on each, and each attempt's own added tests on the pre-fix code and on upstream's fix.

  python3 compare.py          everything; needs what setup.sh needs (GitHub and PyPI) the first time

  compare.py render ROOT CORPUS OUT     (internal) render CORPUS with the markdown package under ROOT
  compare.py coverage ROOT CORPUS OUT   (internal) count inputs reaching each branch of parse_endtag
  compare.py asserts ROOT OUT           (internal) check each assertion of attempt 2's added test separately

Its work goes to $COMPARE_DIR, by default .compare/ beside this script: inside the folder run.sh hides from jig,
since it holds upstream's fix and tests, and ignored by git.
  base/                       setup.sh's project: Python-Markdown at 7a29324 with .venv (dev install)
  v/<variant>                 a `git archive HEAD` copy of base with only the markdown/ part of a patch applied
                              (prefix: none, upstream: upstream/fix.patch, jig1..3: each attempt's diff.patch)
  t/<attempt>_on_<variant>    a copy of a variant with only the tests/ part of the attempt's diff.patch applied
  out/                        corpus.json, render-<variant>.json, report.json, suite-*.txt, cross-*.txt

Every subprocess runs the base .venv's python with cwd and PYTHONPATH set to the variant's root, and the render
step asserts that markdown.__file__ is inside that root.
"""
import json
import os
import random
import re
import shutil
import signal
import subprocess
import sys

CASE = os.path.dirname(os.path.abspath(__file__))
DIR = os.environ.get('COMPARE_DIR') or os.path.join(CASE, '.compare')
BASE = os.path.join(DIR, 'base')
PY = os.path.join(BASE, '.venv', 'bin', 'python')
ATTEMPTS = {
    'jig1': '2026-10-14T18-55-21-jig',
    'jig2': '2026-10-14T18-57-52-jig',
    'jig3': '2026-10-14T19-01-07-jig',
}
PATCHES = {'upstream': os.path.join(CASE, 'upstream', 'fix.patch')}
PATCHES.update({k: os.path.join(CASE, 'results', v, 'diff.patch') for k, v in ATTEMPTS.items()})
VARIANTS = ['prefix', 'upstream', 'jig1', 'jig2', 'jig3']
CONFIGS = {'none': [], 'md_in_html': ['md_in_html'], 'extra': ['extra']}
SEED = 1651


# ----------------------------------------------------------------------------------------------- corpus

# Things around `</` and `<` that the parser treats specially.
CORE = [
    '</', '<', '</>', '</ >', '</a', '</A', '</z', '</dev', '</dev/', '</dev/null', '</ab c', '</ab c>',
    '</a>', '</div>', '</div', '</p', '</p>', '</span', '</1', '</-', '</!', '</?', '</"', "</'", '</ ',
    '</\n', '</`', '</=', '</a/', '</a/>', '</a b="c', '</a b="c>"', '</a`', '</a`b>', '</a\n>', '</a >',
    '</ a>', '<a', '<a/', '<a>', '<div', '<div>', '<b>', '<!--', '-->', '<!-- x -->', '<!--</a-->',
    '<![CDATA[', ']]>', '<![CDATA[x]]>', '<![CDATA[</a]]>', '<?', '?>', '<?x ?>', '<!', '<!x>',
    '<!DOCTYPE', '<!DOCTYPE html>', '</script', '<script>', '</style', '<style>', '</textarea',
    '<textarea>', '&lt;/a', '&#60;/a', '2</dev/null', 'cat </etc/hosts', '</a</b', '<</a', '<//a',
]

# Short strings placed before / after a core token.
AFFIX = ['', 'a', 'Z', '2', '/', '>', ' ', '\n', '"', "'", '-', '!', '?', '`', '<', '&', ' >', '\n\n',
         'x y', '/null', '> q']

# A smaller core for the full prefix x core x suffix product.
CORE_SMALL = ['</', '<', '</a', '</dev/null', '</ab c', '</>', '</ >', '</1', '</-', '</!', '</?', '<a',
              '<!', '<?', '</a>']
AFFIX_SMALL = ['', 'a', '2', '/', '>', ' ', '\n', '"', "'", '-', '!', '?', '`', '<']

# Contexts; {X} is replaced by the material.
CONTEXTS = [
    '{X}',
    'foo {X}',
    'foo {X}\n\nbar',
    '{X}\n\nbar',
    '`{X}`',
    '`{X}` z > q\n\nbar',
    'a `b {X}` c\n\nd',
    'a `b {X}` c `e > f`\n\nd',
    '``{X}``\n\nd',
    '<div>\n{X}\n</div>\n\nafter',
    '<div>{X}</div>\n\nafter',
    '<div>\n{X}',
    '<div>\n`{X}`\n</div>\n\nafter',
    '<div markdown="1">\n{X}\n</div>\n\nafter',
    '<div markdown="1">\n`{X}`\n\nmore\n</div>\n\nafter',
    '<div markdown="block">{X}</div>\nafter',
    '<p>{X}</p>\n\nz',
    '<span>{X}</span> z\n\nq',
    '* item {X}\n* next\n\nend',
    '> quote {X}\n\npara',
    '# H {X}\n\npara',
    '    code {X}\n\npara',
    '```\n{X}\n```\n\npara',
    '{X}\n<div>x</div>\n\ny',
    'x {X}\n\n<div>\ny\n</div>\n\nz',
    'text {X} <b>bold</b> more\n\nend',
    '{X}{X}\n\n{X}',
    '<!-- c -->\n{X}\n\nz',
    '{X} <!-- c --> z\n\nq',
    '<![CDATA[ {X} ]]>\n\nz',
    'a\n{X}\nb\n\nc',
    '*em {X}*\n\nz',
    '[l]({X}) z\n\nq',
    '<script>{X}</script>\n\nz',
    '<style>\n{X}\n</style>\n\nz',
    '&amp; {X} &#60; &\n\nz',
    'F[^1]\n\n[^1]: {X}\n\nz',
    '| a | b |\n|---|---|\n| {X} | c |\n\nz',
    '*[HTML]: {X}\n\nHTML z',
    'Term\n:   {X}\n\nz',
    '{X}\n\n<div>\n</div>\n\nz',
    '<div>\n<div>\n{X}\n</div>\n</div>\n\nz',
]

# Material for multiple / nested occurrences.
MULTI = [
    '`</a` `</b` `</c`', '</a </b </c', '</a> </b', '</a </b>', '`</a` </b> `</c`', '<a </b', '</a <b>',
    '</dev/null`\n\n`</etc/hosts', '</a\n\n</b\n\n</c', '<div></a</div>', '</a<!-- x -->', '<!-- </a -->',
    '<![CDATA[</a]]> </b', '</a ]]> -->', '<!--\n</a\n-->', '<?php </a ?>', '</a <?x', '</a <!x', '</ </ </',
    '</></ ></>', '</ >x</>y', '<</a>>', '</a>>', '<</a', '``</a``', '`` ` </a ` ``',
]

FUZZ_CHARS = (['<'] * 8 + ['/'] * 6 + ['>'] * 5 + ['`'] * 4 + ['\n'] * 4 + [' '] * 4
              + list('abdzAB') * 2 + list('-!?"\'=&;1*#[]():') + list('xyq'))
FUZZ_TOKENS = ['</', '<', '>', '`', '\n', '\n\n', ' ', 'a', 'dev', '/null', '</dev/null', '<div>', '</div>',
               '<div markdown="1">', '<!--', '-->', '<![CDATA[', ']]>', '<?', '?>', '<!', '</>', '</ >',
               '<b>', '</b>', '<script>', '</script', 'z', ' > ', '"', "'", '-', '!', '&', '* ', '> ',
               '    ', '```', '2', 'x']


def build_corpus():
    rnd = random.Random(SEED)
    seen = set()
    corpus = []

    def add(s, kind):
        if s not in seen:
            seen.add(s)
            corpus.append({'kind': kind, 'text': s})

    # A: prefix x core x suffix, in a paragraph followed by another, and in a code span.
    for pre in AFFIX_SMALL:
        for core in CORE_SMALL:
            for suf in AFFIX_SMALL:
                x = pre + core + suf
                add('p' + x + 'q\n\nnext', 'A-plain')
                add('a `' + x + '` b\n\nnext', 'A-code')
                add(x, 'A-alone')
    # B: every core token with every affix pair in a few contexts, and every core token in every context.
    for core in CORE:
        for ctx in CONTEXTS:
            add(ctx.replace('{X}', core), 'B-context')
        for pre in AFFIX:
            for suf in AFFIX:
                x = pre + core + suf
                add('t ' + x + ' u\n\nlast', 'B-affix')
    # C: pairs of core tokens, and multi-occurrence material, in contexts.
    for a in CORE_SMALL:
        for b in CORE_SMALL:
            add(a + ' x ' + b + '\n\nz', 'C-pair')
            add('`' + a + '` y `' + b + '`\n\nz', 'C-pair-code')
            add('<div>\n' + a + b + '\n</div>\n\nz', 'C-pair-div')
    for m in MULTI:
        for ctx in CONTEXTS:
            add(ctx.replace('{X}', m), 'C-multi')
    # D: random fuzz, char-level and token-level.
    for _ in range(3000):
        n = rnd.randint(1, 40)
        add(''.join(rnd.choice(FUZZ_CHARS) for _ in range(n)), 'D-fuzz-chars')
    for _ in range(3000):
        n = rnd.randint(1, 14)
        add(''.join(rnd.choice(FUZZ_TOKENS) for _ in range(n)), 'D-fuzz-tokens')
    return corpus


# ----------------------------------------------------------------------------------------------- render

class _Timeout(Exception):
    pass


def render(root, corpus_path, out_path):
    import markdown
    mfile = os.path.abspath(markdown.__file__)
    assert mfile.startswith(os.path.abspath(root) + os.sep), (mfile, root)

    def on_alarm(*_):
        raise _Timeout()
    signal.signal(signal.SIGALRM, on_alarm)

    with open(corpus_path) as f:
        corpus = json.load(f)
    out = {}
    for name, exts in CONFIGS.items():
        res = []
        for item in corpus:
            signal.alarm(10)
            try:
                res.append(markdown.markdown(item['text'], extensions=exts))
            except _Timeout:
                res.append('!!TIMEOUT')
            except Exception as e:  # noqa: BLE001
                res.append('!!EXC %s: %s' % (type(e).__name__, e))
            finally:
                signal.alarm(0)
        out[name] = res
    with open(out_path, 'w') as f:
        json.dump({'markdown_file': mfile, 'outputs': out}, f)
    print(mfile)


def coverage(root, corpus_path, out_path):
    """Instrument the overridden parse_endtag (in ROOT's markdown) and record, per config, how many inputs reach
    each branch: the non-letter early return, base parse_endtag returning -1 (the branch the fixes change), base
    returning another negative value (would separate `< 0` from `== -1`), and base returning a position."""
    import markdown
    from markdown import htmlparser as mh
    assert os.path.abspath(markdown.__file__).startswith(os.path.abspath(root) + os.sep)
    base_cls = mh._HTMLParser.__bases__[0]
    orig_base = base_cls.parse_endtag
    orig_over = mh._HTMLParser.parse_endtag
    hits = set()
    rets = {}

    def base_wrap(self, i):
        r = orig_base(self, i)
        hits.add('base_minus1' if r == -1 else ('base_other_negative' if r < 0 else 'base_position'))
        rets[r if r < 0 else 'pos'] = rets.get(r if r < 0 else 'pos', 0) + 1
        return r

    def over_wrap(self, i):
        n_before = sum(rets.values())
        r = orig_over(self, i)
        if sum(rets.values()) == n_before:
            hits.add('non_letter_early_return')
        return r
    base_cls.parse_endtag = base_wrap
    mh._HTMLParser.parse_endtag = over_wrap
    with open(corpus_path) as f:
        corpus = json.load(f)
    out = {}
    for name, exts in CONFIGS.items():
        counts = {}
        for item in corpus:
            hits.clear()
            markdown.markdown(item['text'], extensions=exts)
            for h in hits:
                counts[h] = counts.get(h, 0) + 1
        out[name] = counts
    out['base_return_values'] = {str(k): v for k, v in rets.items()}
    with open(out_path, 'w') as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out))


# Each assertion of jig2's single added test method, rendered separately (quoted from jig2's diff.patch).
JIG2_ASSERTS = [
    ('Discard errors with `cmd 2</dev/null` and keep going.\n\nThis second paragraph must survive.',
     '<p>Discard errors with <code>cmd 2&lt;/dev/null</code> and keep going.</p>\n'
     '<p>This second paragraph must survive.</p>'),
    ('Use `cat </etc/hosts` and `echo hi > out`.',
     '<p>Use <code>cat &lt;/etc/hosts</code> and <code>echo hi &gt; out</code>.</p>'),
    ('A </unclosed tag.', '<p>A &lt;/unclosed tag.</p>'),
]


def asserts(root, out_path):
    import markdown
    assert os.path.abspath(markdown.__file__).startswith(os.path.abspath(root) + os.sep)
    res = [{'input': i, 'expected': e, 'got': markdown.markdown(i), 'ok': markdown.markdown(i) == e}
           for i, e in JIG2_ASSERTS]
    with open(out_path, 'w') as f:
        json.dump(res, f, indent=1)
    print(json.dumps([r['ok'] for r in res]))


# ----------------------------------------------------------------------------------------------- driver

def sh(cmd, cwd=None, env=None, check=True):
    p = subprocess.run(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if check and p.returncode != 0:
        raise SystemExit('command failed (%d): %s\n%s' % (p.returncode, ' '.join(cmd), p.stdout))
    return p


def export_base(dest):
    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    arch = subprocess.run(['git', 'archive', 'HEAD'], cwd=BASE, stdout=subprocess.PIPE, check=True).stdout
    subprocess.run(['tar', '-x', '-C', dest], input=arch, check=True)


def apply_part(dest, patch, part):
    sh(['git', 'apply', '--include=%s/*' % part, patch], cwd=dest)


def venv_env(root):
    env = dict(os.environ)
    env['PYTHONPATH'] = root
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env.pop('PYTHONSTARTUP', None)
    return env


def make_variants():
    roots = {}
    for v in VARIANTS:
        dest = os.path.join(DIR, 'v', v)
        export_base(dest)
        if v in PATCHES:
            apply_part(dest, PATCHES[v], 'markdown')
        roots[v] = dest
    return roots


def added_tests(patch):
    """(class, method) names a patch adds to tests/."""
    names = []
    cls = None
    with open(patch) as f:
        lines = f.read().splitlines()
    in_tests = False
    path = None
    for ln in lines:
        if ln.startswith('diff --git'):
            path = ln.split(' b/')[-1]
            in_tests = path.startswith('tests/')
            continue
        if not in_tests:
            continue
        m = re.match(r'^@@ .* @@ class (\w+)', ln)
        if m:
            cls = m.group(1)
        m = re.match(r'^\+    def (test_\w+)\(', ln)
        if m:
            names.append((path, cls, m.group(1)))
    return names


def test_id(path, cls, meth):
    return path[:-3].replace('/', '.') + '.' + cls + '.' + meth


def tail(text, n=4):
    return '\n'.join([ln for ln in text.strip().splitlines() if ln.strip()][-n:])


def main():
    if not os.path.exists(PY):
        subprocess.run([os.path.join(CASE, 'setup.sh'), BASE], check=True)
    out_dir = os.path.join(DIR, 'out')
    os.makedirs(out_dir, exist_ok=True)
    print(sh([PY, '--version']).stdout.strip())

    # 1-2. variants
    roots = make_variants()

    # 3. corpus + render (variants in parallel)
    corpus = build_corpus()
    corpus_path = os.path.join(out_dir, 'corpus.json')
    with open(corpus_path, 'w') as f:
        json.dump(corpus, f)
    kinds = {}
    for c in corpus:
        kinds[c['kind']] = kinds.get(c['kind'], 0) + 1
    print('corpus: %d inputs %s' % (len(corpus), json.dumps(kinds)))
    procs = {}
    for v, root in roots.items():
        procs[v] = subprocess.Popen(
            [PY, os.path.abspath(__file__), 'render', root, corpus_path, os.path.join(out_dir, 'render-%s.json' % v)],
            cwd=root, env=venv_env(root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    renders = {}
    for v, p in procs.items():
        so, _ = p.communicate()
        if p.returncode != 0:
            raise SystemExit('render %s failed:\n%s' % (v, so))
        with open(os.path.join(out_dir, 'render-%s.json' % v)) as f:
            renders[v] = json.load(f)
        print('render %-8s markdown.__file__ = %s' % (v, renders[v]['markdown_file']))

    up = renders['upstream']['outputs']
    report = {'corpus_size': len(corpus), 'kinds': kinds, 'variants': {}}
    for v in VARIANTS:
        if v == 'upstream':
            continue
        outs = renders[v]['outputs']
        diff_idx = set()
        per_config = {}
        examples = []
        for cfg in CONFIGS:
            idx = [i for i in range(len(corpus)) if outs[cfg][i] != up[cfg][i]]
            per_config[cfg] = len(idx)
            diff_idx.update(idx)
        for i in sorted(diff_idx, key=lambda i: (len(corpus[i]['text']), i))[:5]:
            cfg = next(c for c in CONFIGS if outs[c][i] != up[c][i])
            examples.append({'input': corpus[i]['text'], 'config': cfg, 'kind': corpus[i]['kind'],
                             'upstream': up[cfg][i], 'variant': outs[cfg][i]})
        report['variants'][v] = {'differs_inputs': len(diff_idx), 'differs_per_config': per_config,
                                 'examples': examples}
        print('%-8s differs from upstream on %d inputs %s' % (v, len(diff_idx), per_config))
        for e in examples:
            print('    [%s] %r\n       upstream: %r\n       %s: %r' % (e['config'], e['input'], e['upstream'], v,
                                                                     e['variant']))
    exc = {v: sum(1 for cfg in CONFIGS for o in renders[v]['outputs'][cfg] if o.startswith('!!'))
           for v in VARIANTS}
    report['exceptions_or_timeouts'] = exc
    print('exceptions/timeouts per variant:', exc)

    # 4. full suites
    report['suites'] = {}
    for v, root in roots.items():
        p = sh([PY, '-m', 'unittest', 'discover', 'tests'], cwd=root, env=venv_env(root), check=False)
        with open(os.path.join(out_dir, 'suite-%s.txt' % v), 'w') as f:
            f.write(p.stdout)
        summary = tail(p.stdout, 3).replace('\n', ' | ')
        report['suites'][v] = {'returncode': p.returncode, 'summary': summary}
        print('suite %-8s rc=%d %s' % (v, p.returncode, summary))

    # Upstream's hidden tests against every variant.
    report['hidden'] = {}
    hid_dir = os.path.join(DIR, 'hidden')
    os.makedirs(hid_dir, exist_ok=True)
    shutil.copy(os.path.join(CASE, 'upstream', 'test_issue_1651.py'), hid_dir)
    for v, root in roots.items():
        env = venv_env(root)
        env['PYTHONPATH'] = root + os.pathsep + hid_dir
        p = sh([PY, '-m', 'unittest', 'test_issue_1651'], cwd=root, env=env, check=False)
        summary = tail(p.stdout, 2).replace('\n', ' | ')
        report['hidden'][v] = {'returncode': p.returncode, 'summary': summary}
        print('hidden %-8s rc=%d %s' % (v, p.returncode, summary))

    # 5. jig's own added tests on pre-fix, upstream, and its own fix.
    report['cross'] = {}
    for a in ATTEMPTS:
        names = added_tests(PATCHES[a])
        report['cross'][a] = {'tests': [n[2] for n in names]}
        for target in ['prefix', 'upstream', a]:
            dest = os.path.join(DIR, 't', '%s_on_%s' % (a, target))
            if os.path.exists(dest):
                shutil.rmtree(dest)
            shutil.copytree(roots[target], dest)
            apply_part(dest, PATCHES[a], 'tests')
            per_test = {}
            for path, cls, meth in names:
                ids = [test_id(path, cls, meth)]
                if cls == 'TestHTMLBlocks':
                    # tests/test_syntax/extensions/test_md_in_html.py reruns every TestHTMLBlocks test with
                    # md_in_html enabled (class TestDefaultwMdInHTML), so the suite runs each added method twice.
                    ids.append('tests.test_syntax.extensions.test_md_in_html.TestDefaultwMdInHTML.' + meth)
                for tid in ids:
                    p = sh([PY, '-m', 'unittest', '-v', tid], cwd=dest, env=venv_env(dest), check=False)
                    short = tid.split('.')[-2] + '.' + meth
                    with open(os.path.join(out_dir, 'cross-%s-on-%s-%s.txt' % (a, target, short)), 'w') as f:
                        f.write(p.stdout)
                    per_test[short] = 'pass' if p.returncode == 0 else 'FAIL'
            report['cross'][a][target] = per_test
            print('cross %s tests on %-8s %s' % (a, target, per_test))
            if target == a:
                # The attempt's whole suite with its own tests, as check.txt ran it (minus upstream's 3).
                p = sh([PY, '-m', 'unittest', 'discover', 'tests'], cwd=dest, env=venv_env(dest), check=False)
                summary = tail(p.stdout, 3).replace('\n', ' | ')
                report['cross'][a]['own_suite_with_own_tests'] = {'returncode': p.returncode, 'summary': summary}
                print('suite %s + its own tests rc=%d %s' % (a, p.returncode, summary))

    # jig2 put three assertions in one method; check each on prefix and upstream.
    report['jig2_asserts'] = {}
    for target in ['prefix', 'upstream', 'jig2']:
        o = os.path.join(out_dir, 'jig2-asserts-%s.json' % target)
        sh([PY, os.path.abspath(__file__), 'asserts', roots[target], o], cwd=roots[target],
           env=venv_env(roots[target]))
        with open(o) as f:
            report['jig2_asserts'][target] = [r['ok'] for r in json.load(f)]
        print('jig2 assertions on %-8s %s' % (target, report['jig2_asserts'][target]))

    # Branch coverage of the corpus, measured on upstream's fix.
    o = os.path.join(out_dir, 'coverage-upstream.json')
    sh([PY, os.path.abspath(__file__), 'coverage', roots['upstream'], corpus_path, o], cwd=roots['upstream'],
       env=venv_env(roots['upstream']))
    with open(o) as f:
        report['coverage_upstream'] = json.load(f)
    print('coverage (inputs reaching each branch, upstream):', json.dumps(report['coverage_upstream']))

    with open(os.path.join(out_dir, 'report.json'), 'w') as f:
        json.dump(report, f, indent=1)
    print('report:', os.path.join(out_dir, 'report.json'))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'render':
        render(*sys.argv[2:5])
    elif len(sys.argv) > 1 and sys.argv[1] == 'coverage':
        coverage(*sys.argv[2:5])
    elif len(sys.argv) > 1 and sys.argv[1] == 'asserts':
        asserts(*sys.argv[2:4])
    else:
        main()
