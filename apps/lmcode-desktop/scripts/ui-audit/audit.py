#!/usr/bin/env python3
"""LMCODE Desktop UI audit over CDP.

Connects to a running Electron app started with --remote-debugging-port,
measures layout geometry / computed tokens, and writes screenshots.

Usage:
  python scripts/ui-audit/audit.py --label baseline
  python scripts/ui-audit/audit.py --label after --strict

Exit code is 0 only when every *strict* assertion passes. Metrics that are
missing because the app has not been refactored yet are reported as WARN in
non-strict runs, and as FAIL in --strict runs.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests
from websockets.sync.client import connect

CDP_HOST = os.environ.get("LMCODE_CDP", "http://127.0.0.1:9222")
OUT_ROOT = Path(__file__).resolve().parent

METRICS_JS = r"""
(() => {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
  };
  const pick = (sel) => rectOf(document.querySelector(sel));
  const byUi = (name) => rectOf(document.querySelector(`[data-ui="${name}"]`));
  const css = getComputedStyle(document.documentElement);
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const theme = document.documentElement.getAttribute('data-theme');
  const textPrimary = css.getPropertyValue('--lm-text-primary').trim();
  const accent = css.getPropertyValue('--lm-accent').trim();
  const overlayCount = document.querySelectorAll('[data-ui="panel"], [role="dialog"]').length;
  return {
    theme,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    doc: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    },
    body: { bg: bodyBg, textPrimary },
    tokens: {
      accent,
      bgBase: css.getPropertyValue('--lm-bg-base').trim(),
      bgSidebar: css.getPropertyValue('--lm-bg-sidebar').trim(),
      fontSans: css.getPropertyValue('--lm-font-sans').trim(),
      fontSerif: css.getPropertyValue('--lm-font-serif').trim(),
    },
    rects: {
      sidebar: pick('aside'),
      header: pick('header'),
      headerUi: byUi('header'),
      sidebarUi: byUi('sidebar'),
      transcript: byUi('transcript'),
      transcriptFallback: pick('main') || pick('[class*="max-w-3xl"]'),
      composer: byUi('composer'),
      chatColumn: byUi('chat-column'),
      welcome: byUi('welcome'),
      usage: byUi('usage'),
    },
    count: {
      sessionRows: document.querySelectorAll('.lm-session-row').length,
      messages: document.querySelectorAll('[data-ui="message"]').length,
      navItems: document.querySelectorAll('[data-ui="sidebar-nav"] button, [data-ui="sidebar-nav"] a').length,
    },
    fonts: {
      assistantBody: (() => {
        const el = document.querySelector('[data-ui="assistant-body"]');
        return el ? getComputedStyle(el).fontFamily : null;
      })(),
    },
    overlayCount,
  };
})()
"""


class CDP:
    def __init__(self, ws_url: str) -> None:
        self.ws = connect(ws_url, max_size=64 * 1024 * 1024)
        self.next_id = 1

    def send(self, method: str, params: dict[str, Any] | None = None) -> Any:
        msg_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            raw = self.ws.recv()
            data = json.loads(raw)
            if data.get("id") == msg_id:
                if "error" in data:
                    raise RuntimeError(f"{method} failed: {data['error']}")
                return data.get("result", {})

    def evaluate(self, expression: str) -> Any:
        result = self.send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
        )
        if result.get("exceptionDetails"):
            raise RuntimeError(f"JS error: {result['exceptionDetails']}")
        return result["result"].get("value")

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001 - best effort
            pass


def find_target() -> str:
    for _ in range(40):
        try:
            pages = requests.get(f"{CDP_HOST}/json/list", timeout=2).json()
        except Exception:  # noqa: BLE001 - app may still be starting
            pages = []
        for page in pages:
            if page.get("type") == "page" and "index.html" in (page.get("url") or ""):
                return page["webSocketDebuggerUrl"]
        time.sleep(0.5)
    raise SystemExit("no CDP page target found; is the app running with --remote-debugging-port=9222?")


def scroll_transcript(cdp: CDP, where: str) -> None:
    target = "0" if where == "top" else "p.scrollHeight"
    cdp.evaluate(
        "(() => {"
        " const el = document.querySelector('[data-ui=transcript]');"
        " if (!el) return;"
        " let p = el.parentElement;"
        " while (p && getComputedStyle(p).overflowY !== 'auto') p = p.parentElement;"
        f" if (p) p.scrollTop = {target};"
        "})()"
    )


def capture(cdp: CDP, width: int, height: int, theme: str, label: str, out_dir: Path) -> dict[str, Any]:
    cdp.send(
        "Emulation.setDeviceMetricsOverride",
        {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False},
    )
    cdp.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme}')")
    time.sleep(0.45)
    metrics = cdp.evaluate(METRICS_JS)
    shot = cdp.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{label}-{theme}-{width}x{height}.png"
    path.write_bytes(base64.b64decode(shot["data"]))
    metrics["screenshot"] = str(path)
    return metrics


def check(metrics: dict[str, Any], strict: bool) -> list[tuple[str, str, str]]:
    """Return (level, name, detail) rows; level in PASS/FAIL/WARN."""
    rows: list[tuple[str, str, str]] = []

    def need(level_missing: str, name: str, value: Any, predicate, expect: str) -> None:
        if value is None:
            rows.append((level_missing, name, "metric missing"))
            return
        ok = predicate(value)
        rows.append(("PASS" if ok else "FAIL", name, f"{value} ({expect})"))

    rects = metrics["rects"]
    doc = metrics["doc"]
    level = "FAIL" if strict else "WARN"

    need(level, "sidebar width in [240,360]", (rects.get("sidebarUi") or rects.get("sidebar") or {}).get("w"), lambda v: 240 <= v <= 360, "240–360px")
    header = (rects.get("headerUi") or rects.get("header")) or None
    need(level, "header height 44±2", header.get("h") if header else None, lambda v: 42 <= v <= 46, "44px")

    transcript = rects.get("transcript") or rects.get("transcriptFallback")
    welcome = rects.get("welcome")
    if rects.get("transcript"):
        need(level, "transcript column <= 760", transcript.get("w"), lambda v: v <= 761, "<=760px")
    elif welcome:
        rows.append(("PASS", "transcript column <= 760", "empty state: welcome screen, no transcript mounted"))
    else:
        need(level, "transcript column <= 760", transcript.get("w") if transcript else None, lambda v: v <= 761, "<=760px")

    composer = rects.get("composer")
    if composer:
        need(level, "composer <= 760", composer["w"], lambda v: v <= 761, "<=760px")
        anchor = rects.get("chatColumn") or rects.get("transcript") or composer
        centre = anchor["x"] + anchor["w"] / 2
        composer_centre = composer["x"] + composer["w"] / 2
        rows.append(("PASS" if abs(centre - composer_centre) <= 1.5 else "FAIL", "composer centred in column", f"{composer_centre:.1f} vs column centre {centre:.1f}"))
    else:
        rows.append((level, "composer <= 760", "metric missing"))

    rows.append(("PASS" if doc["scrollWidth"] <= doc["clientWidth"] + 1 else "FAIL", "no horizontal overflow", f"{doc['scrollWidth']}/{doc['clientWidth']}"))

    accent = metrics["tokens"]["accent"].lower()
    rows.append(("PASS" if accent in ("#d87754", "#d97757") else ("FAIL" if strict else "WARN"), "accent token", accent))

    # Overlap: sidebar vs transcript/composer must not intersect.
    side = rects.get("sidebarUi") or rects.get("sidebar")
    if side and transcript:
        overlap = side["x"] + side["w"] > transcript["x"] + 0.5
        rows.append(("PASS" if not overlap else "FAIL", "sidebar does not overlap column", f"sidebar right {side['x'] + side['w']:.1f} vs column left {transcript['x']:.1f}"))
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="run")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--out", default=None)
    parser.add_argument("--open", default=None, help="click the first session row containing this text")
    parser.add_argument("--scroll", default=None, choices=["top", "bottom"], help="scroll the transcript before capture")
    args = parser.parse_args()

    ws_url = find_target()
    cdp = CDP(ws_url)
    cdp.send("Page.enable")
    cdp.send("Runtime.enable")
    cdp.send("Page.reload", {"ignoreCache": True})
    time.sleep(4.0)
    if args.open:
        # A panel left open swallows the first click, so clear it first.
        cdp.evaluate(
            "(() => {"
            " document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));"
            " const close = [...document.querySelectorAll('button')].find((n) => (n.getAttribute('aria-label') || '').includes('关闭'));"
            " if (close) close.click();"
            "})()"
        )
        time.sleep(0.8)
        needle = json.dumps(args.open)
        for attempt in range(3):
            box = cdp.evaluate(
                "(() => {"
                " const rows = [...document.querySelectorAll('.lm-session-row')];"
                f" const row = rows.find((el) => (el.textContent || '').includes({needle}));"
                " if (!row) return null;"
                " const r = row.getBoundingClientRect();"
                " return { x: r.x + r.width / 2, y: r.y + r.height / 2 };"
                "})()"
            )
            if box:
                # A synthetic .click() does not drive the list's pointer handler.
                for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
                    cdp.send(
                        "Input.dispatchMouseEvent",
                        {"type": kind, "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1},
                    )
                for _ in range(20):
                    if cdp.evaluate("!!document.querySelector('[data-ui=composer]')"):
                        break
                    time.sleep(0.25)
            if cdp.evaluate("!!document.querySelector('[data-ui=composer]')"):
                break
            time.sleep(1.0)
        else:
            print(f"WARN could not open a session row containing {args.open!r}")
    out_dir = Path(args.out) if args.out else OUT_ROOT / args.label

    report: dict[str, Any] = {"label": args.label, "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "runs": []}
    failures = 0
    for width, height in ((1280, 800), (1600, 900)):
        for theme in ("light", "dark"):
            if args.scroll:
                scroll_transcript(cdp, args.scroll)
                time.sleep(0.3)
            metrics = capture(cdp, width, height, theme, args.label, out_dir)
            rows = check(metrics, args.strict)
            report["runs"].append({"size": f"{width}x{height}", "theme": theme, "metrics": metrics, "checks": rows})
            for level, name, detail in rows:
                if level in ("FAIL", "WARN"):
                    print(f"  {level:4} {name}: {detail}")
                if level == "FAIL":
                    failures += 1
    cdp.close()

    report_path = out_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"report: {report_path}")
    if failures:
        print(f"FAILED: {failures} assertion(s)")
        return 1
    print("all strict assertions passed" if args.strict else "no failures (warnings allowed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
