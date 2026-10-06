#!/bin/sh
# 리뷰답글 도우미 첫 설치 (Linux): 구성 요소 설치 + 앱 메뉴/바탕화면 아이콘 만들기
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 22.13 이상을 먼저 설치해 주세요: https://nodejs.org"; exit 1; }
node --disable-warning=ExperimentalWarning scripts/launch.js --install
