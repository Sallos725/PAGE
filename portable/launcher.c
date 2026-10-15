/* portable/launcher.c — PAGE Windows 포터블 런처 (스펙 §3.1).
 * 빌드: windres launcher.rc -O coff -o launcher.res && gcc -municode -O2 -o PAGE.exe launcher.c launcher.res
 * 하는 일: 자기 폴더에서 bin\node.exe app\launch.mjs 를 실행하고 끝날 때까지 기다린다. 그 밖의 로직은 launch 에 있다. */
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>

/* 오류를 보여 주고 키 입력을 기다린 뒤 1 */
static int fail(const WCHAR *msg) {
    wprintf(L"%ls\n", msg);
    fflush(stdout);
    system("pause");
    return 1;
}

/* Ctrl+C·Ctrl+Break 는 삼키고 자식(node)이 스스로 정리하고 끝나길 기다린다. 창 닫기 등은 기본 처리. */
static BOOL WINAPI on_ctrl(DWORD type) {
    return type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT;
}

int wmain(void) {
    /* wprintf 의 한글이 CRT 로케일 변환에서 깨지지 않게 UTF-16 으로 바로 쓴다 */
    _setmode(_fileno(stdout), _O_U16TEXT);
    SetConsoleTitleW(L"PAGE");

    WCHAR dir[MAX_PATH], node[MAX_PATH], cmd[MAX_PATH * 3];
    const WCHAR *too_long = L"[PAGE] 실행 경로가 너무 길어요. 짧은 경로로 옮겨 주세요.";
    DWORD n = GetModuleFileNameW(NULL, dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return fail(too_long);
    WCHAR *sep = wcsrchr(dir, L'\\');
    if (sep) *sep = L'\0';

    /* 자식(node)의 UTF-8 출력용 */
    SetConsoleOutputCP(CP_UTF8);
    SetCurrentDirectoryW(dir);

    if (swprintf(node, MAX_PATH, L"%ls\\bin\\node.exe", dir) < 0) return fail(too_long);
    if (GetFileAttributesW(node) == INVALID_FILE_ATTRIBUTES)
        return fail(L"[PAGE] bin\\node.exe 가 없어요. zip 을 통째로 다시 풀어 주세요.");
    if (swprintf(cmd, MAX_PATH * 3, L"\"%ls\" \"%ls\\app\\launch.mjs\"", node, dir) < 0) return fail(too_long);

    SetConsoleCtrlHandler(on_ctrl, TRUE); /* 함수 핸들러는 자식에 상속되지 않는다 (NULL,TRUE 와 달리) */
    STARTUPINFOW si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si); ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, 0, NULL, dir, &si, &pi)) {
        WCHAR msg[128];
        swprintf(msg, 128, L"[PAGE] 시작하지 못했어요 (오류 %lu).", GetLastError());
        return fail(msg);
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    if (code != 0) { fflush(stdout); system("pause"); } /* 오류를 읽을 수 있게 */
    return (int)code;
}
