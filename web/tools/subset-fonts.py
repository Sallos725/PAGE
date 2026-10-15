"""MaruBuri 서브셋 생성 (단계 3-0, 스펙 D23). 일회성 — 결과 woff2 를 커밋한다.

사용 (저장소 루트에서):
  uv run --with 'fonttools[woff]' python -I web/tools/subset-fonts.py web/tools/fonts-src web/src/assets/fonts

남기는 글자: 기본 라틴, 라틴-1 기호, 일반 구두점, 화살표·도형·기호 일부, CJK 기호, 한글 호환 자모(ㅋ·ㅠ 등),
전각 ASCII, KS X 1001 완성형 한글 2,350자. 서브셋에 없는 글자는 브라우저가 기기 폰트로 글리프 단위 폴백한다.
출력에는 파일명·바이트 크기만 찍는다.
"""
import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

WEIGHTS = ('Regular', 'SemiBold')
RANGES = [
    (0x0020, 0x007E), (0x00A0, 0x00FF), (0x2010, 0x206F), (0x2190, 0x21FF), (0x2460, 0x24FF),
    (0x25A0, 0x25FF), (0x2600, 0x26FF), (0x3000, 0x303F), (0x3131, 0x318E), (0xFF01, 0xFF5E),
]


def charset() -> set[int]:
    cps: set[int] = set()
    for a, b in RANGES:
        cps.update(range(a, b + 1))
    hangul = 0
    for cp in range(0xAC00, 0xD7A4):
        # KS X 1001 완성형 = euc_kr 로 2바이트가 되는 음절. (CPython 은 나머지를 8바이트 조합 시퀀스로 인코딩하므로 길이로 거른다.)
        try:
            if len(chr(cp).encode('euc_kr')) != 2:
                continue
        except UnicodeEncodeError:
            continue
        cps.add(cp)
        hangul += 1
    if hangul != 2350:
        sys.exit(f'KS X 1001 한글 수가 2350 이 아니다: {hangul}')
    return cps


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit('usage: subset-fonts.py <src-dir> <out-dir>')
    src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    cps = charset()
    for w in WEIGHTS:
        opts = subset.Options()
        opts.flavor = 'woff2'
        opts.layout_features = ['*']
        opts.name_IDs = ['*']
        opts.name_languages = ['*']
        opts.notdef_outline = True
        font = TTFont(src / f'MaruBuri-{w}.woff2')
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=cps)
        sub.subset(font)
        font.flavor = 'woff2'
        dest = out / f'MaruBuri-{w}.subset.woff2'
        font.save(dest)
        print(f'{dest.name}: {dest.stat().st_size} bytes')


if __name__ == '__main__':
    main()
