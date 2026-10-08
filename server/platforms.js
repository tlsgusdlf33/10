// 리뷰 플랫폼 정보와 악성·허위 의심 리뷰 신고 안내.
// 각 플랫폼의 세부 메뉴 이름과 기준은 수시로 바뀌므로, 안내 문구는 공통 기준 위주로 쓰고 최신 운영정책 확인을 권한다.

export const PLATFORMS = {
  baemin: { name: '배달의민족', center: 'https://self.baemin.com', where: '배민셀프서비스(사장님 사이트·앱) 리뷰 관리' },
  coupangeats: { name: '쿠팡이츠', center: 'https://store.coupangeats.com', where: '쿠팡이츠 스토어(사장님 사이트·앱) 리뷰 관리' },
  yogiyo: { name: '요기요', center: 'https://ceo.yogiyo.co.kr', where: '요기요 사장님 사이트 리뷰 관리' },
  naver: { name: '네이버 지도(플레이스)', center: 'https://new.smartplace.naver.com', where: '네이버 스마트플레이스 리뷰 관리' },
  kakao: { name: '카카오맵', center: '', where: '카카오맵 매장 관리(사장님) 메뉴' },
  google: { name: '구글 지도', center: 'https://business.google.com', where: 'Google 비즈니스 프로필의 리뷰 관리' },
  etc: { name: '기타', center: '', where: '해당 플랫폼의 사장님(판매자) 관리 화면' },
};

export function platformName(id) {
  return PLATFORMS[id]?.name || id;
}

/** 악성·허위 의심 리뷰에 대한 사장님 조치 안내 (AI 판단과 상관없이 일정한 기준을 보여 준다). */
export function reportGuide(platformId) {
  const p = PLATFORMS[platformId] || PLATFORMS.etc;
  return [
    `1) 신고 위치: ${p.where}에서 해당 리뷰의 "신고" 또는 "게시 중단 요청" 메뉴를 이용하세요.`,
    '2) 대부분의 플랫폼이 신고를 받는 기준: 욕설·비속어, 허위 사실·명예훼손, 개인정보 노출, 광고·홍보, 주문·이용과 무관한 내용, 보상(서비스·환불)을 조건으로 한 별점 압박, 경쟁업체로 의심되는 반복 비방.',
    '3) 권리 침해(명예훼손 등)가 명백하면 정보통신망법에 따른 임시조치(게시 중단)를 플랫폼에 요청할 수 있습니다.',
    '4) 주문 내역·통화 기록·사진·CCTV 등 증빙을 캡처해 날짜와 함께 보관하세요.',
    '5) 답글에서는 감정적인 반박, 고객 개인정보, 주문 상세를 언급하지 마세요.',
    '※ 이 안내는 일반적인 정보이며 법률 조언이 아닙니다. 세부 기준은 각 플랫폼의 최신 운영정책을 확인하고, 분쟁이 커지면 전문가와 상담하세요.',
  ].join('\n');
}
