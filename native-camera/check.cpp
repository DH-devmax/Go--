#include <windows.h>
#include <dshow.h>
#include <cstdio>
#include "virtualcam-guid.h"

static int report(const char *stage, HRESULT hr, int formats = 0)
{
	std::printf("{\"stage\":\"%s\",\"hresult\":\"0x%08lx\",\"formats\":%d}\n",
		    stage, (unsigned long)hr, formats);
	return FAILED(hr) ? 1 : 0;
}

static void free_type(AM_MEDIA_TYPE *type)
{
	if (!type)
		return;
	CoTaskMemFree(type->pbFormat);
	if (type->pUnk)
		type->pUnk->Release();
	CoTaskMemFree(type);
}

// Check this registered software source only; no physical camera is opened.
static int check()
{
	IClassFactory *factory = nullptr;
	HRESULT hr = CoGetClassObject(CLSID_OBS_VirtualVideo, CLSCTX_INPROC_SERVER, nullptr,
				     IID_IClassFactory, (void **)&factory);
	if (FAILED(hr))
		return report("class-factory", hr);

	void *unsupported = nullptr;
	hr = factory->CreateInstance(nullptr, IID_IDispatch, &unsupported);
	if (hr != E_NOINTERFACE || unsupported) {
		if (unsupported)
			((IUnknown *)unsupported)->Release();
		factory->Release();
		return report("interface-contract", E_NOINTERFACE);
	}
	IAMFilterMiscFlags *flags = nullptr;
	hr = factory->CreateInstance(nullptr, IID_IAMFilterMiscFlags, (void **)&flags);
	if (SUCCEEDED(hr)) {
		if (!flags || !(flags->GetMiscFlags() & AM_FILTER_MISC_FLAGS_IS_SOURCE))
			hr = E_NOINTERFACE;
	}
	if (flags)
		flags->Release();
	factory->Release();
	if (FAILED(hr))
		return report("source-interface", hr);

	ICreateDevEnum *devices = nullptr;
	hr = CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER,
			      IID_ICreateDevEnum, (void **)&devices);
	if (FAILED(hr))
		return report("device-enumerator", hr);
	IEnumMoniker *enumerator = nullptr;
	hr = devices->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &enumerator, 0);
	devices->Release();
	if (hr != S_OK || !enumerator)
		return report("device-category", FAILED(hr) ? hr : HRESULT_FROM_WIN32(ERROR_NOT_FOUND));

	IBaseFilter *filter = nullptr;
	IMoniker *moniker = nullptr;
	HRESULT binding = HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
	while (enumerator->Next(1, &moniker, nullptr) == S_OK) {
		IPropertyBag *bag = nullptr;
		hr = moniker->BindToStorage(nullptr, nullptr, IID_IPropertyBag, (void **)&bag);
		bool own = false;
		if (SUCCEEDED(hr)) {
			VARIANT value;
			VariantInit(&value);
			hr = bag->Read(L"CLSID", &value, nullptr);
			CLSID id = {};
			own = SUCCEEDED(hr) && value.vt == VT_BSTR &&
			      SUCCEEDED(CLSIDFromString(value.bstrVal, &id)) && id == CLSID_OBS_VirtualVideo;
			VariantClear(&value);
			bag->Release();
		}
		if (own)
			binding = moniker->BindToObject(nullptr, nullptr, IID_IBaseFilter, (void **)&filter);
		moniker->Release();
		if (own)
			break;
	}
	enumerator->Release();
	if (FAILED(binding) || !filter)
		return report("device-bind", FAILED(binding) ? binding : E_NOINTERFACE);
	CLSID id = {};
	hr = filter->GetClassID(&id);
	if (SUCCEEDED(hr) && id != CLSID_OBS_VirtualVideo)
		hr = E_NOINTERFACE;
	IEnumPins *pins = nullptr;
	if (SUCCEEDED(hr))
		hr = filter->EnumPins(&pins);
	if (FAILED(hr)) {
		filter->Release();
		return report("enumerate-pins", hr);
	}
	IPin *pin = nullptr;
	hr = pins->Next(1, &pin, nullptr);
	pins->Release();
	if (hr != S_OK || !pin) {
		filter->Release();
		return report("output-pin", FAILED(hr) ? hr : E_NOINTERFACE);
	}
	IAMStreamConfig *config = nullptr;
	hr = pin->QueryInterface(IID_IAMStreamConfig, (void **)&config);
	pin->Release();
	if (FAILED(hr)) {
		filter->Release();
		return report("stream-config", hr);
	}
	int formats = 0, size = 0;
	hr = config->GetNumberOfCapabilities(&formats, &size);
	if (SUCCEEDED(hr) && (formats <= 0 || size != sizeof(VIDEO_STREAM_CONFIG_CAPS)))
		hr = E_INVALIDARG;
	AM_MEDIA_TYPE *type = nullptr;
	VIDEO_STREAM_CONFIG_CAPS caps = {};
	if (SUCCEEDED(hr))
		hr = config->GetStreamCaps(0, &type, (BYTE *)&caps);
	if (SUCCEEDED(hr) && (!type || !type->pbFormat || !type->cbFormat))
		hr = E_INVALIDARG;
	free_type(type);
	config->Release();
	filter->Release();
	return report(FAILED(hr) ? "format-capabilities" : "ready", hr, formats);
}

int main()
{
	HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
	if (FAILED(hr))
		return report("com-init", hr);
	int result = check();
	CoUninitialize();
	return result;
}
