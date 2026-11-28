"""시안 화면 html → JSX · css (기계적 옮기기 · 11-28 팀장 「시안 html 을 그대로 앱으로」).

쓰기: python3 scripts/proto2jsx.py <시안 화면.html> <화면 클래스> <out.tsx> <out.css>
- body 를 JSX 로: class→className · style 문자열→객체 · svg 속성 camelCase · 닫는 태그. 태그 · 클래스 · 순서 · 글은 그대로.
- <script> 는 버린다 (동작은 앱 코드가 붙인다). head · body 의 <style> 은 out.css 로 (선택자 앞에 화면 클래스 한 겹).
- 공용 shared/*.css 는 scripts/protocss.mjs 가 따로 씌운다.
만든 tsx 는 출발점이다: 고정 글 자리를 서버 값으로 바꾸는 손질은 만든 뒤 그 파일에서 한다.
"""
import json
import re
import sys
from html.parser import HTMLParser

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
RENAME = {'class': 'className', 'for': 'htmlFor', 'tabindex': 'tabIndex', 'readonly': 'readOnly', 'maxlength': 'maxLength',
          'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace', 'autocomplete': 'autoComplete', 'colspan': 'colSpan', 'rowspan': 'rowSpan',
          # html.parser 가 속성 이름을 소문자로 바꾸므로 svg 의 낙타 이름은 되돌린다
          'viewbox': 'viewBox', 'preserveaspectratio': 'preserveAspectRatio', 'gradientunits': 'gradientUnits',
          'gradienttransform': 'gradientTransform', 'patternunits': 'patternUnits', 'stddeviation': 'stdDeviation',
          'markerwidth': 'markerWidth', 'markerheight': 'markerHeight', 'refx': 'refX', 'refy': 'refY'}
KEEP = re.compile(r'^(data-|aria-)')


def camel(name):
    return re.sub(r'[-:]([a-z])', lambda m: m.group(1).upper(), name)


def style_obj(s):
    out = []
    for decl in [d for d in re.split(r';(?![^(]*\))', s) if d.strip()]:
        k, _, v = decl.partition(':')
        k, v = k.strip(), v.strip()
        key = k if k.startswith('--') else re.sub(r'^-(webkit|moz|ms)-', lambda m: m.group(1) + '-', k)
        key = json.dumps(key) if key.startswith('--') else camel(key)
        if key.startswith('ms'):
            key = 'ms' + key[2:]
        out.append(f'{key}: {json.dumps(v, ensure_ascii=False)}')
    return '{{ ' + ', '.join(out) + ' }}'


def attr(k, v):
    if KEEP.match(k):
        name = k
    elif k in RENAME:
        name = RENAME[k]
    elif k == 'style':
        return f'style={style_obj(v or "")}'
    else:
        name = camel(k)
    if v is None:
        return name
    return f'{name}={json.dumps(v, ensure_ascii=False)}'


def text(t):
    t = re.sub(r'\s+', ' ', t)
    if not t:
        return ''
    if t == ' ' or t != t.strip() or re.search(r'[{}<>&]', t):
        return '{' + json.dumps(t, ensure_ascii=False) + '}'
    return t


class P(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.css, self.depth, self.skip, self.body = [], [], 0, None, False

    def handle_starttag(self, tag, attrs):
        if tag == 'body':
            self.body = True
            return
        if tag in ('script', 'style'):
            self.skip = tag
            return
        if not self.body or self.skip:
            return
        a = ' '.join(attr(k, v) for k, v in attrs)
        a = ' ' + a if a else ''
        if tag in VOID:
            self.out.append('  ' * self.depth + f'<{tag}{a} />')
        else:
            self.out.append('  ' * self.depth + f'<{tag}{a}>')
            self.depth += 1

    def handle_startendtag(self, tag, attrs):
        if not self.body or self.skip:
            return
        a = ' '.join(attr(k, v) for k, v in attrs)
        self.out.append('  ' * self.depth + f'<{tag}{" " + a if a else ""} />')

    def handle_endtag(self, tag):
        if tag in ('script', 'style') and self.skip == tag:
            self.skip = None
            return
        if tag == 'body':
            self.body = False
            return
        if not self.body or self.skip or tag in VOID:
            return
        self.depth -= 1
        self.out.append('  ' * self.depth + f'</{tag}>')

    def handle_data(self, data):
        if self.skip == 'style':
            self.css.append(data)
            return
        if not self.body or self.skip:
            return
        t = text(data)
        if t:
            self.out.append('  ' * self.depth + t)


def main(src, scope, out_tsx, out_css):
    p = P()
    p.feed(open(src, encoding='utf-8').read())
    name = re.sub(r'\W', '_', scope)
    body = '\n'.join('      ' + line for line in p.out)
    open(out_tsx, 'w', encoding='utf-8').write(
        f'// {src.split("/")[-1]} body 를 scripts/proto2jsx.py 로 옮긴 것\n'
        f'export function {name}() {{\n  return (\n    <>\n{body}\n    </>\n  );\n}}\n')
    open(out_css, 'w', encoding='utf-8').write('\n'.join(p.css))


if __name__ == '__main__':
    main(*sys.argv[1:5])
