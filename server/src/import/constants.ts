// 가져온 채팅 원본의 id. 설정에서 이 이름은 쓸 수 없다(예약). 완전히 지우기는 이 원본에만 허용한다.
export const IMPORTED_SOURCE = 'imported';

export function assertImported(source: string): void {
  if (source !== IMPORTED_SOURCE) throw new Error('purge is only for the imported source');
}
