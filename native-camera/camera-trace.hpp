#pragma once
#include <windows.h>
#include <cstdio>

namespace Dualcast {

inline void trace(const char *event, HRESULT result, int width = 0, int height = 0,
		  long long interval = 0, unsigned long pixel = 0, unsigned long interface_id = 0)
{
	wchar_t base[MAX_PATH];
	DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", base, MAX_PATH);
	if (!length || length + 64 >= MAX_PATH)
		return;
	wchar_t directory[MAX_PATH];
	swprintf(directory, MAX_PATH, L"%ls\\Dualcast Virtual Camera", base);
	CreateDirectoryW(directory, nullptr);
	wchar_t file[MAX_PATH];
	swprintf(file, MAX_PATH, L"%ls\\camera-0.4.3.log", directory);
	HANDLE log = CreateFileW(file, FILE_APPEND_DATA | FILE_READ_ATTRIBUTES,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (log == INVALID_HANDLE_VALUE)
		return;
	LARGE_INTEGER size;
	if (GetFileSizeEx(log, &size) && size.QuadPart > 256 * 1024) {
		CloseHandle(log);
		wchar_t previous[MAX_PATH];
		swprintf(previous, MAX_PATH, L"%ls.1", file);
		if (!MoveFileExW(file, previous, MOVEFILE_REPLACE_EXISTING))
			return;
		log = CreateFileW(file, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				  nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
		if (log == INVALID_HANDLE_VALUE)
			return;
	}
	SYSTEMTIME now;
	GetSystemTime(&now);
	char line[384];
	int count = snprintf(line, sizeof(line),
		"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ component=0.4.3 pid=%lu event=%s hr=0x%08lx size=%dx%d interval=%lld pixel=0x%08lx iid=0x%08lx\r\n",
		now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds,
		GetCurrentProcessId(), event, (unsigned long)result, width, height, interval, pixel, interface_id);
	if (count > 0 && count < (int)sizeof(line)) {
		DWORD written;
		WriteFile(log, line, (DWORD)count, &written, nullptr);
	}
	CloseHandle(log);
}

} // namespace Dualcast
