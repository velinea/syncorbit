import express from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.post("/api/analyze", (req, res) => {
  const file = req.body.path;
  if (!file) return res.status(400).json({ error: "no file" });

  const py = spawn("python3", ["analyze.py", file]);
  let out = "", err = "";

  py.stdout.on("data", d => out += d.toString());
  py.stderr.on("data", d => err += d.toString());
  py.on("close", code => {
    if (code === 0) {
      try { res.json(JSON.parse(out)); }
      catch (e) { res.status(500).json({ error: "bad json", detail: e.toString() }); }
    } else {
      res.status(500).json({ error: "python failed", detail: err });
    }
  });
});

app.post("/api/compare", (req, res) => {
  const { base, ref } = req.body;
  if (!base || !ref) return res.status(400).json({ error: "missing paths" });

  const py = spawn("python3", ["analyze_pair.py", base, ref]);
  let out = "", err = "";
  py.stdout.on("data", d => out += d.toString());
  py.stderr.on("data", d => err += d.toString());
  py.on("close", code => {
    if (code === 0) {
      try { res.json(JSON.parse(out)); }
      catch (e) { res.status(500).json({ error: "bad json", detail: e.toString() }); }
    } else {
      res.status(500).json({ error: err || `python exit ${code}` });
    }
  });
});

app.post("/api/align", (req, res) => {
  const { reference, target } = req.body;
  if (!reference || !target) {
    return res.status(400).json({ error: "reference and target paths required" });
  }

  const py = spawn("python3", ["align.py", reference, target]);

  let out = "";
  let errBuf = "";

  py.stdout.on("data", d => (out += d.toString()));
  py.stderr.on("data", d => (errBuf += d.toString()));

  py.on("close", code => {
    if (code === 0) {
      try {
        const data = JSON.parse(out);
        res.json(data);
      } catch (e) {
        res.status(500).json({ error: "bad JSON from align.py", detail: String(e), raw: out });
      }
    } else {
      res.status(500).json({ error: "align.py failed", detail: errBuf || `exit ${code}` });
    }
  });
});



app.listen(5010, "0.0.0.0", () => console.log("SyncOrbit API running on :5010"));
