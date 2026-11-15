#!/usr/bin/env python3
"""Screenshot UI panels by clicking their entry points through CDP.

Usage:
  python scripts/ui-audit/panels.py --theme light --out scripts/ui-audit/panels
  python scripts/ui-audit/panels.py --label memory --only 记忆库

Clicks are dispatched as real mouse events at the element centre, because a
synthetic element.click() does not always reach the list/button pointer
handlers used by this renderer.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from audit import CDP, find_target  # noqa: E402

PANELS = [
    ("memory", "记忆库"),
    ("extensions", "技能与 MCP"),
    ("settings", "设置"),
    ("tasks", "后台任务"),
    ("automations", "自动化"),
    ("subagents", "子 Agent"),
    ("worktrees", "工作树"),
    ("git", "Git 审查"),
]

# Panels that live behind the header "更多" menu.
MENU_ITEMS = {"后台任务", "自动化", "子 Agent", "工作树", "Git 审查"}


def click_text(cdp: CDP, text: str) -> bool:
    needle = json.dumps(text, ensure_ascii=False)
    box = cdp.evaluate(
        "(() => {"
        f" const needle = {needle};"
        " const nodes = [...document.querySelectorAll('button, a, [role=menuitem]')];"
        " const el = nodes.find((n) => ((n.textContent || '').trim().includes(needle)) || ((n.getAttribute('aria-label') || '').includes(needle)));"
        " if (!el) return null;"
        " const r = el.getBoundingClientRect();"
        " if (r.width === 0 || r.height === 0) return null;"
        " return { x: r.x + r.width / 2, y: r.y + r.height / 2 };"
        "})()"
    )
    if not box:
        return False
    for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
        cdp.send(
            "Input.dispatchMouseEvent",
            {"type": kind, "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1},
        )
    return True


def click_session_row(cdp: CDP, text: str) -> bool:
    needle = json.dumps(text, ensure_ascii=False)
    box = cdp.evaluate(
        "(() => {"
        f" const needle = {needle};"
        " const rows = [...document.querySelectorAll('.lm-session-row')];"
        " const row = rows.find((n) => (n.textContent || '').includes(needle));"
        " if (!row) return null;"
        " const r = row.getBoundingClientRect();"
        " return { x: r.x + r.width / 2, y: r.y + r.height / 2 };"
        "})()"
    )
    if not box:
        return False
    for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
        cdp.send(
            "Input.dispatchMouseEvent",
            {"type": kind, "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1},
        )
    for _ in range(20):
        if cdp.evaluate("!!document.querySelector('[data-ui=composer]')"):
            return True
        time.sleep(0.25)
    return False


def click_menu_item(cdp: CDP, text: str) -> bool:
    """Radix menu items respond to a plain click event; pointer synthesis is flaky here."""
    needle = json.dumps(text, ensure_ascii=False)
    return bool(
        cdp.evaluate(
            "(() => {"
            f" const needle = {needle};"
            " const items = [...document.querySelectorAll('[role=menuitem]')];"
            " const el = items.find((n) => (n.textContent || '').includes(needle));"
            " if (!el || el.getAttribute('data-disabled') !== null || el.getAttribute('aria-disabled') === 'true') return false;"
            " el.click();"
            " return true;"
            "})()"
        )
    )


def shoot(cdp: CDP, path: Path) -> None:
    shot = cdp.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
    path.write_bytes(base64.b64decode(shot["data"]))


def close_panel(cdp: CDP) -> None:
    cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))")
    cdp.evaluate(
        "(() => {"
        " const el = [...document.querySelectorAll('button')].find((n) => (n.getAttribute('aria-label') || '').includes('关闭'));"
        " if (el) el.click();"
        "})()"
    )
    time.sleep(0.6)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--theme", default="light", choices=["light", "dark"])
    parser.add_argument("--out", default="scripts/ui-audit/panels")
    parser.add_argument("--only", default=None)
    parser.add_argument("--open", default=None, help="open a session row containing this text first")
    parser.add_argument("--open-index", type=int, default=None, help="open the Nth session row first")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cdp = CDP(find_target())
    cdp.send("Page.enable")
    cdp.send("Runtime.enable")
    cdp.send("Page.reload", {"ignoreCache": True})
    time.sleep(4.0)
    cdp.evaluate(f"document.documentElement.setAttribute('data-theme', '{args.theme}')")
    time.sleep(0.4)
    if args.open_index is not None:
        box = cdp.evaluate(
            "(() => {"
            f" const row = [...document.querySelectorAll('.lm-session-row')][{args.open_index}];"
            " if (!row) return null;"
            " const r = row.getBoundingClientRect();"
            " return { x: r.x + r.width / 2, y: r.y + r.height / 2 };"
            "})()"
        )
        if box:
            for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
                cdp.send(
                    "Input.dispatchMouseEvent",
                    {"type": kind, "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1},
                )
            time.sleep(2.0)
        else:
            print(f"WARN no session row at index {args.open_index}")
    elif args.open and not click_session_row(cdp, args.open):
        print(f"WARN could not open session row {args.open!r}")

    targets = [p for p in PANELS if args.only is None or p[1] == args.only]
    for slug, label in targets:
        if label in MENU_ITEMS:
            if not click_text(cdp, "更多工作区工具"):
                print(f"SKIP {slug}: no 'more' button")
                continue
            time.sleep(0.8)
            clicked = click_menu_item(cdp, label)
            if not clicked:
                print(f"SKIP {slug}: menu item {label!r} not clickable (disabled or missing)")
                cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))")
                continue
        elif not click_text(cdp, label):
            print(f"SKIP {slug}: entry {label} not found")
            continue
        time.sleep(1.2)
        path = out_dir / f"{slug}-{args.theme}.png"
        shoot(cdp, path)
        print(f"shot {path}")
        close_panel(cdp)

    cdp.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
