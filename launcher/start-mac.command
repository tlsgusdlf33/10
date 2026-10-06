#!/bin/sh
# 리뷰답글 도우미 실행 (macOS) - 더블클릭
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 필요합니다. 설치 페이지를 엽니다 (LTS 버전 설치 후 다시 실행하세요)."
  open "https://nodejs.org/ko/download"
  exit 1
fi
exec node --disable-warning=ExperimentalWarning scripts/launch.js "$@"
