#!/bin/sh
# 리뷰답글 도우미 실행 (Linux)
cd "$(dirname "$0")/.." || exit 1
exec node --disable-warning=ExperimentalWarning scripts/launch.js "$@"
