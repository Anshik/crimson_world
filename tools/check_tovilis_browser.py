#!/usr/bin/env python3
"""Headless Playwright browser QA runner.

This is the default browser runner for local checks.  The older WebDriver
helper is intentionally not imported: visible Safari requires an explicit
``--allow-visible-safari`` opt-in in its own script.
"""
from pathlib import Path
import base64
import os
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = Path(os.environ.get('TOVILIS_QA_ROOT', str(Path(__file__).resolve().parents[1]))).resolve()
sys.path.insert(0, str(ROOT))
OUT = Path('/private/tmp/tovilis-markup')
OUT.mkdir(exist_ok=True)


def run():
    if '--allow-visible-safari' in sys.argv:
        raise SystemExit('Visible Safari is disabled here; use the legacy runner only with explicit review.')
    browser_name = 'chromium'
    if '--browser' in sys.argv:
        browser_name = sys.argv[sys.argv.index('--browser') + 1]
    if browser_name != 'chromium':
        raise SystemExit('Only Playwright-managed headless Chromium is supported on this macOS host; headless WebKit crashes before launch.')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1320, 'height': 920}, device_scale_factor=1)
        elements = {}
        counter = 0

        def js(script):
            # Existing scenarios are small WebDriver snippets with explicit
            # return statements. Wrapping them preserves that contract.
            return page.evaluate('(source) => (new Function(source))()', script)

        def async_js(script):
            return page.evaluate('''source => new Promise(resolve => {
                const finish = value => resolve(value);
                (new Function('finish', source))(finish);
            })''', script)

        def click(selector):
            page.locator(selector).first.click()

        def snapshot(name):
            page.evaluate('''async () => {
                await Promise.all(Array.from(document.images, image => image.decode().catch(() => {})));
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
            }''')
            page.screenshot(path=str(OUT / (name + '.png')), full_page=False)

        def request(method, path, payload=None):
            nonlocal counter
            if path.endswith('/window/rect') and method == 'POST':
                page.set_viewport_size({'width': payload['width'], 'height': payload['height']})
                return None
            if path.endswith('/url') and method == 'POST':
                page.goto(payload['url'], wait_until='load')
                return None
            if path.endswith('/refresh') and method == 'POST':
                page.reload(wait_until='load')
                return None
            if path.endswith('/screenshot') and method == 'GET':
                return base64.b64encode(page.screenshot()).decode()
            if path.endswith('/actions') and method == 'POST':
                for action in payload.get('actions', []):
                    for step in action.get('actions', []):
                        if step.get('type') == 'pointerMove':
                            page.mouse.move(step['x'], step['y'])
                        elif step.get('type') == 'pointerDown':
                            page.mouse.down()
                        elif step.get('type') == 'pointerUp':
                            page.mouse.up()
                return None
            if '/element' in path and method == 'POST':
                if path.endswith('/element'):
                    counter += 1
                    eid = f'pw-{counter}'
                    elements[eid] = payload['value']
                    return {'element-6066-11e4-a52e-4f735466cecf': eid}
                eid = path.split('/element/', 1)[1].split('/', 1)[0]
                locator = page.locator(elements[eid]).first
                if path.endswith('/click'):
                    locator.click(force=True)
                elif path.endswith('/clear'):
                    locator.fill('')
                elif path.endswith('/value'):
                    locator.fill(payload.get('text', ''))
                return None
            if path.endswith('/execute/sync') and method == 'POST':
                return js(payload['script'])
            if path.endswith('/execute/async') and method == 'POST':
                return async_js(payload['script'])
            if method == 'DELETE':
                return None
            raise RuntimeError(f'Unsupported browser adapter call: {method} {path}')

        try:
            from safari_game_checks import check_game, check_online_feedback
            if '--hero-sheet' in sys.argv or '--sale-ui' in sys.argv or '--hud-notice' in sys.argv or '--game' in sys.argv:
                check_game(request, '/pw', js, click, snapshot, ROOT)
            elif '--online-feedback' in sys.argv:
                check_online_feedback(request, '/pw', js, click, snapshot, ROOT)
            else:
                raise SystemExit('Choose --hero-sheet, --sale-ui, --game, or --online-feedback')
        finally:
            browser.close()


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    run()
