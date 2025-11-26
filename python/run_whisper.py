import subprocess
import sys
import os
import json

if len(sys.argv) < 2:
    print(json.dumps({"error": "no_audio_file"}))
    sys.exit(1)

audio = sys.argv[1]

model = "/app/whisper/ggml-base.en.bin"

cmd = ["whisper-main", "-m", model, "-f", audio, "-osrt"]

p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
out, err = p.communicate()

if p.returncode != 0:
    print(json.dumps({"error": "whisper_failed", "detail": err.decode()}))
    sys.exit(1)

srt_out = audio + ".srt"
if not os.path.exists(srt_out):
    print(json.dumps({"error": "no_srt_generated"}))
    sys.exit(1)

print(json.dumps({"status": "ok", "output": srt_out}))
