#!/usr/bin/env python3
"""Plan 260 S0.1: summarise one run folder (report.json + ps.csv) into summary.json
(the spikes branch's field names) and verdict.md."""
import csv, json, statistics, sys
from pathlib import Path

out = Path(sys.argv[1])
r = json.loads((out / "report.json").read_text())
phases = {p["phase"]: p for p in r["phases"]}
live_feed = next(e["liveFeed"] for e in r["evidence"] if "liveFeed" in e)
layer = live_feed["layer"]["layers"][0]
pipe = r.get("compositorStatus", {}).get("framePipeline", {})
ev = {k: v for e in r["evidence"] for k, v in e.items()}

rows = list(csv.DictReader(open(out / "ps.csv")))
def series(col, t0, t1):
    vals = []
    for row in rows:
        t = int(row["t"])
        if t0 <= t <= t1 and row[col] not in ("", None):
            vals.append(float(row[col]))
    return vals
def stats(v):
    if not v:
        return None
    s = sorted(v)
    pick = lambda q: s[min(len(s) - 1, int(round(q * (len(s) - 1))))]
    return {"n": len(v), "mean": round(statistics.mean(v), 2), "p50": pick(0.5), "p95": pick(0.95), "max": s[-1]}
# The live phase in ps time: from ~t=10 s to t=10+600 s (start-up excluded).
live_s = phases["live-overlay-on"]["seconds"]
ps_live_spike = stats(series("spike_pcpu", 12, 10 + int(live_s)))
ps_live_backend = stats(series("backend_pcpu", 12, 10 + int(live_s)))
rss = stats([v / 1024 for v in series("spike_rss_kb", 12, 10 + int(live_s))])
brss = stats([v / 1024 for v in series("backend_rss_kb", 12, 10 + int(live_s))])
load = stats(series("load1", 0, 10**9))

frames = live_feed["layer"]["frames"]
imports = live_feed["layer"]["imports"]
copies = 0 if (pipe.get("bgraBytesCopied") == 0 and pipe.get("gpuReadbacks") == 0) else None
still_off = phases["still-overlay-off"]["cpuPercentOfOneCore"]
still_on = phases["still-overlay-on"]["cpuPercentOfOneCore"]
live_on = phases["live-overlay-on"]["cpuPercentOfOneCore"]
live_off = phases.get("live-overlay-off", {}).get("cpuPercentOfOneCore")
summary = {
    "schema_version": 1,
    "spike": "spike-preview-backend",
    "os": "macos", "arch": "aarch64", "gpui_pre": "0.3.14", "build": "release",
    "native_view": True,
    "resolution": r["canvas"].split("@")[0], "fps": int(r["canvas"].split("@")[1]),
    "live_seconds": live_s,
    "presents": frames,
    "presents_per_second": frames / live_feed["seconds"],
    "present_interval_p95_ms": layer["commitIntervalMs"]["p95"],
    "display_interval_p95_ms": layer["presentedIntervalMs"]["p95"],
    "cpu_copies_per_frame": copies,
    "iosurface_imports": imports,
    "import_cache_hits": live_feed["layer"]["cacheHits"],
    "backend_gpu_readbacks": pipe.get("gpuReadbacks"),
    "backend_bgra_bytes_copied": pipe.get("bgraBytesCopied"),
    "ui_cpu_percent_live": live_on,
    "ui_cpu_percent_live_overlay_off": live_off,
    "ui_cpu_percent_still": still_off,
    "ui_cpu_percent_still_overlay_on": still_on,
    "overlay_cpu_percent_idle_delta": still_on - still_off,
    "gpu_ms_per_frame_p50": layer["gpuTimeMs"]["p50"],
    "gpu_ms_per_frame_p95": layer["gpuTimeMs"]["p95"],
    "lease_held_p50_ms": live_feed["leaseHeldMs"]["p50"],
    "dropped_frames": live_feed["dropped"] + live_feed["skipped"],
    "ui_redraws_live": phases["live-overlay-on"]["gpuiMainRenders"],
    "floating_cpu_percent": phases.get("floating-live", {}).get("cpuPercentOfOneCore"),
    "floating_presents_per_second": phases.get("floating-live", {}).get("layerPresentedPerSecond"),
    "floating_sharing_type": ev.get("floatingSharingTypeReadBack"),
    "floating_window_capture_refused": not (out / "gpui-s0-1-floating-window-capture.png").exists(),
    "first_frame_since_process_start_s": ev.get("firstFrameSinceProcessStartSeconds"),
    "resume_to_presenting_s": ev.get("resumeToPresentingSeconds"),
    "ps_ui_cpu_live": ps_live_spike, "ps_backend_cpu_live": ps_live_backend,
    "ui_rss_mb_live": rss, "backend_rss_mb_live": brss, "load1": load,
    "backend_stray_pids": r.get("backendStop", {}).get("strayPids"),
}
(out / "summary.json").write_text(json.dumps(summary, indent=2))

def line(name, value, bar, ok):
    return f"| {name} | {value} | {bar} | {'PASS' if ok else 'FAIL'} |"
lines = [
    f"# S0.1 verdict — {out.name}", "",
    "| Pass line | Measured | Bar | Verdict |", "| --- | --- | --- | --- |",
    line(f"4K60 live for {live_s:.0f} s", f"{frames} frames, {summary['presents_per_second']:.2f}/s, dropped+skipped {summary['dropped_frames']}", "10 min at 60/s", live_s >= 599 and summary["presents_per_second"] > 59.5),
    line("zero CPU copies", f"{imports} IOSurface imports, {summary['import_cache_hits']} cache hits; backend gpuReadbacks {pipe.get('gpuReadbacks')}, bgraBytesCopied {pipe.get('bgraBytesCopied')}", "0", copies == 0),
    line("present p95", f"{summary['present_interval_p95_ms']:.2f} ms commit (display {summary['display_interval_p95_ms']:.2f} ms)", "≤ 20 ms", summary["present_interval_p95_ms"] <= 20),
    line("still frame CPU", f"{still_off:.3f} %", "≤ 3 %", still_off <= 3),
    line("live CPU", f"{live_on:.2f} % (getrusage); ps mean {ps_live_spike['mean'] if ps_live_spike else '?'} %", "≤ 10 %", live_on <= 10),
    line("GPU per frame", f"p50 {summary['gpu_ms_per_frame_p50']:.2f} ms, p95 {summary['gpu_ms_per_frame_p95']:.2f} ms", "≤ 2 ms", summary["gpu_ms_per_frame_p95"] <= 2),
    line("floating window out of capture", f"sharingType {summary['floating_sharing_type']}; window capture refused {summary['floating_window_capture_refused']}", "none / absent", summary["floating_sharing_type"] == 0 and summary["floating_window_capture_refused"]),
    line("editor overlay idle cost", f"{still_on - still_off:+.3f} points ({still_off:.3f} → {still_on:.3f} %)", "≤ 1 %", still_on - still_off <= 1),
]
(out / "verdict.md").write_text("\n".join(lines) + "\n")
print("\n".join(lines))
print(json.dumps({k: summary[k] for k in ["ps_ui_cpu_live", "ps_backend_cpu_live", "ui_rss_mb_live", "backend_rss_mb_live", "load1", "floating_cpu_percent", "ui_cpu_percent_live_overlay_off", "first_frame_since_process_start_s", "resume_to_presenting_s", "backend_stray_pids"]}))
