#pragma once
#include <windows.h>
#include <intrin.h>
#include <stdint.h>
#ifdef __cplusplus
#include <objidl.h>
static const GUID MEDIASUBTYPE_P010 = {0x30313050, 0x0000, 0x0010,
    {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
#endif

#if defined(__GNUC__) && !defined(__clang__)
#define __iso_volatile_load32(ptr) __atomic_load_n((ptr), __ATOMIC_ACQUIRE)
#define __iso_volatile_load8(ptr) __atomic_load_n((ptr), __ATOMIC_ACQUIRE)
#define _InterlockedExchange8(ptr, value) __atomic_exchange_n((ptr), (value), __ATOMIC_SEQ_CST)
#endif
