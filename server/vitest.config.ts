import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 시간 제한은 넉넉하게: Windows CI 러너는 실행마다 속도가 몇 배씩 달라(이미지 변환 테스트가 6초→53초) 5초 기본값으로는 우연히 터진다
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 30_000, hookTimeout: 30_000 },
});
