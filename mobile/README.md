# 모바일 앱(스토어 배포) 만들기

이 폴더는 **리뷰답글 도우미**를 Google Play / App Store 에 올리기 위한 앱 껍데기입니다.
앱은 클라우드 서버의 화면을 그대로 불러오므로, 기능을 고칠 때마다 앱을 다시 심사받지 않고 **서버만 배포하면** 모든 사용자에게 반영됩니다.
(같은 계정으로 로그인하면 PC 와 그대로 연동됩니다.)

## 0. 먼저 할 일

1. 서버를 HTTPS 주소로 배포합니다 (루트 `README.md` 4번).
2. `capacitor.config.json` 의 `server.url` 을 그 주소로 바꿉니다. 예: `https://review.example.com`

## 1. Android (Google Play)

준비물: [Android Studio](https://developer.android.com/studio)

```bash
cd mobile
npm install
npm run android        # android 프로젝트 생성 → Android Studio 열림
```

Android Studio 에서 **Build → Generate Signed App Bundle** 로 `.aab` 를 만들어 Play Console 에 올립니다.
앱 아이콘은 `../public/icons/icon-512.png`, `maskable-512.png` 를 Image Asset 도구로 넣으세요.

### 더 간단한 대안: TWA(Trusted Web Activity)

PWA 를 그대로 Play 스토어 앱으로 감싸는 방법입니다.

```bash
npx @bubblewrap/cli init --manifest https://내도메인/manifest.webmanifest
npx @bubblewrap/cli build
```

생성된 `assetlinks.json` 을 `../public/.well-known/assetlinks.json` 에 넣어 서버에 배포하면 주소창 없이 전체 화면 앱으로 실행됩니다.

## 2. iOS (App Store)

준비물: Mac + Xcode, Apple Developer 계정

```bash
cd mobile
npm install
npm run ios
```

> Apple 은 단순히 웹사이트를 감싼 앱을 거절할 수 있습니다(가이드라인 4.2). 심사 전에 푸시 알림(새 리뷰 알림) 같은 기기 기능을 추가하는 것을 권장합니다.

## 3. 결제 정책 메모

앱 **안에서** 구독을 판매하면 각 스토어의 결제 정책(Google Play 결제 또는 한국의 대체 결제 제도, Apple 인앱 결제)을 따라야 합니다.
초기에는 앱에서는 사용만 하고, 구독 결제는 웹/계좌이체로 받은 뒤 관리자 화면에서 요금제를 적용하는 방식으로 시작할 수 있습니다. 출시 전에 최신 스토어 정책을 꼭 확인하세요.
