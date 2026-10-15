// 서버 종료 (신호·다시 켜기 공용). 닫기가 실패하거나 늦어도 반드시 exit(code) 로 끝난다.
export function makeShutdown(o: { close: () => Promise<void> | void; exit: (code: number) => void; timeoutMs: number }): (code: number) => void {
  let stopping = false;
  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    o.exit(code);
  };
  return (code) => {
    if (stopping) return; // 신호와 다시 켜기가 겹쳐도 한 번만
    stopping = true;
    // 진행 중인 요청(예: 폴더 선택 창)이 닫기를 붙잡아도 늦지 않게
    const timer = setTimeout(() => exitOnce(code), o.timeoutMs);
    timer.unref();
    void Promise.resolve()
      .then(o.close)
      .catch(() => {}) // 닫기 실패는 무시하고 끝낸다
      .finally(() => { clearTimeout(timer); exitOnce(code); });
  };
}
