Jump Tracker (MVP)
Jump Tracker is an iPhone app that analyzes jump and plyometric movements from video.
The goal is to measure ground contact time (GCT) and basic jump events using accessible hardware (an iPhone camera), then summarize results in plain language.
This is an early MVP focused on correctness, clarity, and iteration speed — not polish.
What it does
Lets you pick a video from your iPhone Photos library
Detects takeoff and landing events (mocked or real analysis)
Computes key metrics:
Ground Contact Time (GCT)
Flight time
Displays results safely even when analysis is pending
Generates a simple AI-style summary from the computed metrics
Supports a mock analysis mode for fast UI iteration
Core idea
Video → analysis → metrics → summary
Single-camera iPhone video is analyzed to classify contact vs flight.
From that signal we derive biomechanical events and metrics that are easy to interpret.
Tech stack
Expo + React Native
Expo Router
TypeScript
expo-image-picker (video input)
Modular, spec-first analysis layer (separate from UI)
Project structure (important)
app/                     # Expo Router screens (UI only)
  (tabs)/index.tsx       # Main screen

src/
  analysis/
    jumpAnalysisContract.ts  # Canonical JumpAnalysis schema
    mockAnalysis.ts          # Mock analysis output
    analyzeVideo.ts          # Video analysis entry point (WIP)
Important rule:
Only UI code lives in app/.
All analysis logic and schemas live outside app/ to avoid routing issues.
Analysis contract
The UI consumes a single, stable object:
JumpAnalysis
It always exists and has a status:
pending
complete
error
This guarantees the app never crashes while analysis is running or missing.
Current status
UI fully wired to a safe analysis contract
Mock analysis working end-to-end
Video picking from Photos implemented
Real video analysis stubbed (next step)
How to run
From the project root:
npx expo start -c
Then:
Open Expo Go on your iPhone
Scan the QR code
Use Mock to test metrics or Pick video to prepare for real analysis
Roadmap (short)
Replace mock with basic frame-based contact detection
Add session logging (AsyncStorage)
Improve confidence scoring
Explore on-device vs server-side analysis
Expand summaries and training guidance
Philosophy
Spec-first
Stable contracts
No undefined state
Fast iteration over premature optimization
