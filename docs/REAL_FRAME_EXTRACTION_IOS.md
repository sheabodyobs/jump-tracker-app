# Real Frame Extraction on iOS (AVFoundation)

This project uses an iOS-only native module (`RealFrameProvider`) to extract raw frame pixels with AVFoundation. The output is **real measurement** data only when `measurementStatus === "real"`. Any failures or unsupported paths return `measurementStatus: "synthetic_placeholder"` and must be treated as simulated.

## How to run (dev build)

1. Generate native projects:
   ```sh
   npx expo prebuild -p ios
   ```
2. Build the iOS app:
   ```sh
   npx expo run:ios
   ```
3. On a physical iPhone, pick a local video and tap **Test frames** to run the extraction self-test.

## Expected output

The **Frame extraction self-test** card should show:
- Provider: `ios_avfoundation`
- Measurement: `real`
- Frames: `10`
- Increasing `tMs`
- Non-empty width/height

## Limitations / Known issues

- `ph://` URIs are not supported yet. The native module returns:
  - `measurementStatus: "synthetic_placeholder"`
  - `error.code: "PH_URI_UNSUPPORTED"`
- Android is not supported.
- If the native module is missing (e.g., no dev build), the JS wrapper returns:
  - `measurementStatus: "synthetic_placeholder"`
  - `error.code: "NATIVE_MODULE_UNAVAILABLE"`

## Troubleshooting

- If you see `NATIVE_MODULE_UNAVAILABLE`, make sure you ran `expo prebuild` and `expo run:ios`.
- If you see `NO_FRAMES`, verify the video URI is `file://` and the asset is accessible on-device.
- If frames are zero, ensure the video is stored locally (not streaming or cloud-only).
