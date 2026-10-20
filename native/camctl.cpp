// camctl: reads and changes a webcam's image controls through the standard
// Windows camera interfaces (DirectShow IAMVideoProcAmp / IAMCameraControl,
// the same UVC controls the cameras' own apps use). Works with any UVC camera.
//
//   camctl list                      -> [{"index":0,"name":"...","path":"..."}]
//   camctl get <index>               -> {"proc":{...},"cam":{...},"plf":{...}}
//   camctl set <index> <group> <prop> <value> <auto> [<group> <prop> <value> <auto> ...]
//       group: proc | cam | plf (anti-flicker: 0 off, 1 50 Hz, 2 60 Hz, 3 auto)
//
// Output is JSON on stdout. Build (MinGW-w64):
//   x86_64-w64-mingw32-g++ -O2 -static -o camctl.exe camctl.cpp -lstrmiids -lole32 -loleaut32 -luuid

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dshow.h>
#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// Declared in the Windows SDK headers but not always exported by MinGW's libraries.
static const GUID PROPSET_VIDEOPROCAMP = { 0xC6E13360, 0x30AC, 0x11d0, { 0xA1, 0x8C, 0x00, 0xA0, 0xC9, 0x11, 0x89, 0x56 } };
static const GUID IID_KsControl = { 0x28F54685, 0x06FD, 0x11D2, { 0xB2, 0x7A, 0x00, 0xA0, 0xC9, 0x22, 0x31, 0x96 } };

static const char *PROC_NAMES[] = {
  "Brightness", "Contrast", "Hue", "Saturation", "Sharpness", "Gamma",
  "ColorEnable", "WhiteBalance", "BacklightCompensation", "Gain",
};
static const char *CAM_NAMES[] = { "Pan", "Tilt", "Roll", "Zoom", "Exposure", "Iris", "Focus" };

static std::string json(const std::wstring &w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, &s[0], n, nullptr, nullptr);
  std::string out = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if ((unsigned char)c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); out += b; }
    else out += c;
  }
  return out + "\"";
}

struct Dev { std::wstring name, path; IMoniker *mon; };

static std::vector<Dev> listDevices() {
  std::vector<Dev> out;
  ICreateDevEnum *de = nullptr;
  if (FAILED(CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER, IID_ICreateDevEnum, (void **)&de))) return out;
  IEnumMoniker *em = nullptr;
  if (de->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &em, 0) == S_OK && em) {
    IMoniker *m = nullptr;
    while (em->Next(1, &m, nullptr) == S_OK) {
      Dev d; d.mon = m;
      IPropertyBag *bag = nullptr;
      if (SUCCEEDED(m->BindToStorage(nullptr, nullptr, IID_IPropertyBag, (void **)&bag))) {
        VARIANT v; VariantInit(&v);
        if (SUCCEEDED(bag->Read(L"FriendlyName", &v, nullptr)) && v.vt == VT_BSTR) d.name = v.bstrVal;
        VariantClear(&v);
        if (SUCCEEDED(bag->Read(L"DevicePath", &v, nullptr)) && v.vt == VT_BSTR) d.path = v.bstrVal;
        VariantClear(&v);
        bag->Release();
      }
      out.push_back(d);
    }
    em->Release();
  }
  de->Release();
  return out;
}

static IBaseFilter *open(std::vector<Dev> &devs, int idx) {
  if (idx < 0 || idx >= (int)devs.size()) return nullptr;
  IBaseFilter *f = nullptr;
  if (FAILED(devs[idx].mon->BindToObject(nullptr, nullptr, IID_IBaseFilter, (void **)&f))) return nullptr;
  return f;
}

// Anti-flicker (power line frequency) is a KS property, outside the IAMVideoProcAmp enum.
static bool plf(IBaseFilter *f, bool set, long &val) {
  IKsControl *ks = nullptr;
  if (FAILED(f->QueryInterface(IID_KsControl, (void **)&ks))) return false;
  KSPROPERTY_VIDEOPROCAMP_S p = {};
  p.Property.Set = PROPSET_VIDEOPROCAMP;
  p.Property.Id = KSPROPERTY_VIDEOPROCAMP_POWERLINE_FREQUENCY;
  p.Property.Flags = set ? KSPROPERTY_TYPE_SET : KSPROPERTY_TYPE_GET;
  p.Value = val;
  p.Flags = KSPROPERTY_VIDEOPROCAMP_FLAGS_MANUAL;
  ULONG ret = 0;
  HRESULT hr = ks->KsProperty((PKSPROPERTY)&p, sizeof p, &p, sizeof p, &ret);
  ks->Release();
  if (FAILED(hr)) return false;
  if (!set) val = p.Value;
  return true;
}

static void get(IBaseFilter *f) {
  printf("{\"proc\":{");
  IAMVideoProcAmp *pa = nullptr;
  bool first = true;
  if (SUCCEEDED(f->QueryInterface(IID_IAMVideoProcAmp, (void **)&pa))) {
    for (long i = 0; i < 10; i++) {
      long mn, mx, st, df, caps, v, fl;
      if (FAILED(pa->GetRange(i, &mn, &mx, &st, &df, &caps))) continue;
      if (FAILED(pa->Get(i, &v, &fl))) continue;
      printf("%s\"%s\":{\"min\":%ld,\"max\":%ld,\"step\":%ld,\"def\":%ld,\"val\":%ld,\"canAuto\":%s,\"auto\":%s}",
        first ? "" : ",", PROC_NAMES[i], mn, mx, st, df, v,
        (caps & VideoProcAmp_Flags_Auto) ? "true" : "false", (fl & VideoProcAmp_Flags_Auto) ? "true" : "false");
      first = false;
    }
    pa->Release();
  }
  printf("},\"cam\":{");
  IAMCameraControl *cc = nullptr;
  first = true;
  if (SUCCEEDED(f->QueryInterface(IID_IAMCameraControl, (void **)&cc))) {
    for (long i = 0; i < 7; i++) {
      long mn, mx, st, df, caps, v, fl;
      if (FAILED(cc->GetRange(i, &mn, &mx, &st, &df, &caps))) continue;
      if (FAILED(cc->Get(i, &v, &fl))) continue;
      printf("%s\"%s\":{\"min\":%ld,\"max\":%ld,\"step\":%ld,\"def\":%ld,\"val\":%ld,\"canAuto\":%s,\"auto\":%s}",
        first ? "" : ",", CAM_NAMES[i], mn, mx, st, df, v,
        (caps & CameraControl_Flags_Auto) ? "true" : "false", (fl & CameraControl_Flags_Auto) ? "true" : "false");
      first = false;
    }
    cc->Release();
  }
  long pv = 0;
  if (plf(f, false, pv)) printf("},\"plf\":{\"val\":%ld}}\n", pv);
  else printf("},\"plf\":null}\n");
}

static int indexOf(const char **names, int n, const char *s) {
  for (int i = 0; i < n; i++) if (!_stricmp(names[i], s)) return i;
  return -1;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "uso: camctl list | get <i> | set <i> <grupo> <prop> <valor> <auto> ...\n"); return 2; }
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
  std::vector<Dev> devs = listDevices();
  int rc = 0;
  if (!strcmp(argv[1], "list")) {
    printf("[");
    for (size_t i = 0; i < devs.size(); i++) {
      printf("%s{\"index\":%u,\"name\":%s,\"path\":%s}", i ? "," : "", (unsigned)i, json(devs[i].name).c_str(), json(devs[i].path).c_str());
    }
    printf("]\n");
  } else if (!strcmp(argv[1], "get") && argc >= 3) {
    IBaseFilter *f = open(devs, atoi(argv[2]));
    if (!f) { printf("null\n"); rc = 1; }
    else { get(f); f->Release(); }
  } else if (!strcmp(argv[1], "set") && argc >= 7) {
    IBaseFilter *f = open(devs, atoi(argv[2]));
    if (!f) { printf("{\"ok\":false}\n"); rc = 1; }
    else {
      IAMVideoProcAmp *pa = nullptr;
      IAMCameraControl *cc = nullptr;
      f->QueryInterface(IID_IAMVideoProcAmp, (void **)&pa);
      f->QueryInterface(IID_IAMCameraControl, (void **)&cc);
      int ok = 0, fail = 0;
      for (int a = 3; a + 3 < argc; a += 4) {
        const char *g = argv[a];
        long v = atol(argv[a + 2]);
        bool aut = atoi(argv[a + 3]) != 0;
        HRESULT hr = E_FAIL;
        if (!strcmp(g, "proc") && pa) {
          int i = indexOf(PROC_NAMES, 10, argv[a + 1]);
          if (i >= 0) hr = pa->Set(i, v, aut ? VideoProcAmp_Flags_Auto : VideoProcAmp_Flags_Manual);
        } else if (!strcmp(g, "cam") && cc) {
          int i = indexOf(CAM_NAMES, 7, argv[a + 1]);
          if (i >= 0) hr = cc->Set(i, v, aut ? CameraControl_Flags_Auto : CameraControl_Flags_Manual);
        } else if (!strcmp(g, "plf")) {
          hr = plf(f, true, v) ? S_OK : E_FAIL;
        }
        if (SUCCEEDED(hr)) ok++; else fail++;
      }
      if (pa) pa->Release();
      if (cc) cc->Release();
      f->Release();
      printf("{\"ok\":%s,\"applied\":%d,\"failed\":%d}\n", fail ? "false" : "true", ok, fail);
    }
  } else {
    fprintf(stderr, "comando desconhecido\n");
    rc = 2;
  }
  for (auto &d : devs) d.mon->Release();
  CoUninitialize();
  return rc;
}
