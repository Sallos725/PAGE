'use strict';
// utils.cjs 가 `require('./logs.cjs')` 로 logger 를 가져온다. 스파이크에선 조용히 버린다
// (디코드 에러 메시지에 데이터 조각이 섞일 가능성을 원천 차단).
const noop = () => {};
module.exports = { logger: { info: noop, warn: noop, error: noop, debug: noop } };
