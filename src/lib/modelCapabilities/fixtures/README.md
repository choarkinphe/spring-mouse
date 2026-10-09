# Capability probe fixtures

These are synthetic, local-only test inputs; they contain no user data.

- `speech.wav`: mono 16 kHz PCM, generated with macOS `say -v Samantha`; spoken sentence: “The secret words are violet lantern seven.” Converted with ffmpeg. Expected response must contain violet, lantern, seven in order.
- `sequence.mp4`: 160×120 H.264, 5 fps, three one-second solid scenes generated with ffmpeg: red → blue → green. The probe checks temporal order, not a single still frame.

Images and PDFs are generated at runtime in `samples.js`. Image left/right colors are randomized; PDF codes are random and appear only in the document. Context probes use random hex filler and head/middle/tail sentinels. Test text never discloses media answers.

Do not substitute empty/invalid PDF files, header-only WAVs or silent recordings: accepting them cannot demonstrate understanding.
