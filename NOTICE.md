# NOTICE — 포함된 서드파티 구성 요소

PAGE 는 [GPL-3.0](LICENSE) 으로 배포돼요. 아래 구성 요소는 각자의 라이선스를 따르며, 모두 GPL-3.0 과 함께 배포할 수 있어요.

## 저장소에 포함된 코드

| 경로 | 출처 | 라이선스 | 비고 |
|---|---|---|---|
| `server/vendor/pocketrisu/utils.cjs` | [PocketRisu](https://github.com/PocketRisu/PocketRisu) v1.14.0 의 `server/node/utils.cjs` ([RisuAI](https://github.com/kwaroran/Risuai) 기반) | GPL-3.0 | save 형식(`database.bin`) 해독. 코드는 수정하지 않았고 파일 머리에 출처 주석만 더했어요. |
| `server/vendor/pocketrisu/logs.cjs` | PAGE 자체 작성 | GPL-3.0 (PAGE) | 위 파일이 요구하는 logger 를 아무것도 기록하지 않는 대체물로 제공. |

## 저장소에 포함된 글꼴

| 경로 | 출처 | 라이선스 |
|---|---|---|
| `web/src/assets/fonts/MaruBuri-*.subset.woff2` | 마루 부리 © NAVER Corp. © NAVER Cultural Foundation Corp. — KS X 1001 한글·라틴 서브셋 (`web/tools/subset-fonts.py`) | SIL Open Font License 1.1 — [`web/src/assets/fonts/OFL.txt`](web/src/assets/fonts/OFL.txt) |
| `pdf/fonts/MaruBuri-Regular.woff2`, `pdf/fonts/MaruBuri-SemiBold.woff2` | 마루 부리 © NAVER Corp. © NAVER Cultural Foundation Corp. — **전체 글자판**(서브셋 아님). PDF 사이드카가 본문 글꼴로 임베드해요. | SIL Open Font License 1.1 — [`pdf/fonts/OFL.txt`](pdf/fonts/OFL.txt) |

## PDF 사이드카 이미지에 설치되는 구성 요소 (저장소에는 포함하지 않음)

| 구성 요소 | 출처 | 라이선스 |
|---|---|---|
| Noto CJK (`fonts-noto-cjk`), Noto Color Emoji (`fonts-noto-color-emoji`) | Debian 패키지 — 이미지를 빌드할 때 `apt` 로 설치돼요. 마루 부리에 없는 한자·일본어·이모지의 폴백 글꼴. | SIL Open Font License 1.1 |
| DejaVu 글꼴 (`fonts-dejavu-core`) | Debian 패키지(Chromium 의존성으로 같이 설치). 쪽 번호 바닥글에 쓰여 PDF 에 임베드돼요 — 바닥글은 Chromium 이 문서 밖에서 그려서 마루 부리를 쓸 수 없어요. | Bitstream Vera / DejaVu 글꼴 라이선스 (허용적) |
| Chromium headless shell (`chromium-headless-shell`) | Debian 패키지 | BSD-3-Clause 외 (Chromium 프로젝트 라이선스) |

## 실행 시 의존성 (npm, 저장소에는 포함하지 않음)

| 패키지 | 라이선스 |
|---|---|
| fastify, @fastify/helmet, @fastify/static | MIT |
| msgpackr, fflate | MIT |
| playwright-core (PDF 사이드카) | Apache-2.0 |
| svelte (빌드 결과에 런타임 포함) | MIT |

개발 의존성(TypeScript, Vite, Vitest, Playwright 등)은 각 패키지의 라이선스를 따라요.

PAGE 는 PocketRisu·RisuAI 와 공식적인 관계가 없는 개인 프로젝트예요.
