#!/usr/bin/env python3
"""Local public-page extraction service for Metis.

Uses Scrapling's fast static FetcherSession only. It intentionally does not use
StealthyFetcher, browser fingerprint evasion, challenge solvers, proxies, or
authenticated cookies. Protected/login pages are handed back to Metis so the
persistent in-app browser can be used instead.
"""
from __future__ import annotations

import base64
import ipaddress
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, quote_plus, urlparse

from scrapling.fetchers import FetcherSession

HOST = os.environ.get("METIS_SCRAPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("METIS_SCRAPER_PORT", "8890"))
MAX_URLS = 8
MAX_CHARS = 120_000
FETCH_TIMEOUT = float(os.environ.get("METIS_SCRAPER_FETCH_TIMEOUT", "15"))

_session_manager = FetcherSession(
    impersonate=None,
    stealthy_headers=False,
    follow_redirects="safe",
    retries=1,
    retry_delay=0,
    timeout=FETCH_TIMEOUT,
    headers={
        "User-Agent": "MetisPublicScraper/1.0 (+https://chat.samuelm.de)",
        "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
    },
)
_session = _session_manager.__enter__()
_session_lock = threading.Lock()


def _public_url(raw: str) -> str:
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Only public HTTP(S) URLs are allowed")
    if parsed.username or parsed.password:
        raise ValueError("Credentials in URLs are not allowed")
    hostname = parsed.hostname.strip("[]").lower()
    try:
        literal = ipaddress.ip_address(hostname)
        addresses = [literal]
    except ValueError:
        infos = socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
        addresses = list({ipaddress.ip_address(info[4][0]) for info in infos})
    if not addresses:
        raise ValueError("URL hostname could not be resolved")
    for address in addresses:
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise ValueError("Private or reserved network targets are not allowed")
    return raw


def _header(page: Any, name: str) -> str:
    headers = getattr(page, "headers", None)
    if not headers:
        return ""
    try:
        return str(headers.get(name, "") or headers.get(name.lower(), ""))
    except Exception:
        return ""


def _clean_text(page: Any, limit: int) -> str:
    text = str(page.get_all_text(separator="\n", strip=True, ignore_tags=("script", "style", "noscript", "svg")))
    lines: list[str] = []
    previous = None
    for raw in text.splitlines():
        line = " ".join(raw.split())
        if not line or line == previous:
            continue
        lines.append(line)
        previous = line
    return "\n".join(lines)[:limit]


def _looks_protected(status: int, title: str, text: str) -> bool:
    sample = f"{title}\n{text[:4000]}".lower()
    markers = (
        "just a moment",
        "verify you are human",
        "checking your browser",
        "access denied",
        "captcha",
        "sign in to continue",
        "log in to continue",
    )
    return status in {401, 403, 407, 429} or any(marker in sample for marker in markers)



def _decode_bing_url(href: str) -> str:
    try:
        parsed = urlparse(href)
        if parsed.hostname and parsed.hostname.endswith("bing.com"):
            encoded = parse_qs(parsed.query).get("u", [""])[0]
            if encoded.startswith("a1"):
                raw = encoded[2:]
                raw += "=" * (-len(raw) % 4)
                decoded = base64.urlsafe_b64decode(raw.encode("ascii")).decode("utf-8", "replace")
                if decoded.startswith(("http://", "https://")):
                    return decoded
    except Exception:
        pass
    return href


def search_web(query: str, num_results: int) -> dict[str, Any]:
    clean = " ".join(query.split()).strip()
    if not clean:
        raise ValueError("query is required")
    target = f"https://www.bing.com/search?q={quote_plus(clean)}"
    started = time.perf_counter()
    with _session_lock:
        page = _session.get(target)
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    if int(getattr(page, "status", 0) or 0) != 200:
        raise RuntimeError(f"search returned HTTP {getattr(page, 'status', 0)}")
    results = []
    for item in page.css("li.b_algo"):
        links = item.css("h2 a")
        if not links:
            continue
        link = links[0]
        title = " ".join(str(link.get_all_text(separator=" ", strip=True)).split())
        href = str(link.attrib.get("href", "")).strip()
        url = _decode_bing_url(href)
        if not title or not url.startswith(("http://", "https://")):
            continue
        paragraphs = item.css("p")
        content = ""
        if paragraphs:
            content = " ".join(str(paragraphs[0].get_all_text(separator=" ", strip=True)).split())
        results.append({"title": title, "url": url, "content": content, "engine": "bing"})
        if len(results) >= num_results:
            break
    return {
        "source": "local-scrapling-bing",
        "query": clean,
        "results": results,
        "elapsedMs": elapsed_ms,
    }

def fetch_one(url: str, max_chars: int) -> dict[str, Any]:
    safe_url = _public_url(url)
    started = time.perf_counter()
    with _session_lock:
        page = _session.get(safe_url)
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    status = int(getattr(page, "status", 0) or 0)
    final_url = str(getattr(page, "url", safe_url) or safe_url)
    title = str(page.css("title::text").get("") or "").strip()
    content_type = _header(page, "content-type")

    if "application/json" in content_type:
        try:
            body = json.dumps(page.json(), ensure_ascii=False, separators=(",", ":"))[:max_chars]
        except Exception:
            body = _clean_text(page, max_chars)
    else:
        body = _clean_text(page, max_chars)

    requires_browser = _looks_protected(status, title, body)
    return {
        "ok": 200 <= status < 400 and not requires_browser,
        "source": "local-scrapling-static",
        "url": safe_url,
        "finalUrl": final_url,
        "status": status,
        "title": title,
        "contentType": content_type,
        "content": body,
        "elapsedMs": elapsed_ms,
        "requiresBrowser": requires_browser,
        "routingHint": (
            "Use the persistent Metis browser for this page; it appears to require an interactive/login/challenge session."
            if requires_browser
            else "Static extraction succeeded; keep using web_fetch for public read-only pages."
        ),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "MetisScrapling/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[scraper] {self.address_string()} {fmt % args}", flush=True)

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True, "engine": "scrapling", "mode": "static-public-only"})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path not in {"/fetch", "/search"}:
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > 32_768:
                raise ValueError("invalid request size")
            body = json.loads(self.rfile.read(size).decode("utf-8"))
            if self.path == "/search":
                num_results = max(1, min(20, int(body.get("numResults") or 10)))
                self._json(200, search_web(str(body.get("query") or ""), num_results))
                return
            urls = body.get("urls") or ([body.get("url")] if body.get("url") else [])
            if not isinstance(urls, list) or not urls or len(urls) > MAX_URLS:
                raise ValueError(f"urls must contain 1-{MAX_URLS} entries")
            max_chars = max(1_000, min(MAX_CHARS, int(body.get("maxChars") or 40_000)))
            results = []
            for value in urls:
                try:
                    results.append(fetch_one(str(value), max_chars))
                except Exception as exc:
                    results.append({
                        "ok": False,
                        "source": "local-scrapling-static",
                        "url": str(value),
                        "error": str(exc)[:1000],
                        "requiresBrowser": False,
                    })
            self._json(200, {"ok": any(item.get("ok") for item in results), "source": "local-scrapling-static", "results": results})
        except Exception as exc:
            self._json(400, {"ok": False, "error": str(exc)[:1000]})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Metis Scrapling static scraper listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        _session_manager.__exit__(None, None, None)


if __name__ == "__main__":
    main()
