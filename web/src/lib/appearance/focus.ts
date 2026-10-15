/** 나타날 때 포커스를 준다 (삭제 확인·이름 바꾸기처럼 방금 바뀐 컨트롤로 키보드 사용자를 옮긴다). */
export function focusOnMount(node: HTMLElement) {
  node.focus();
}
