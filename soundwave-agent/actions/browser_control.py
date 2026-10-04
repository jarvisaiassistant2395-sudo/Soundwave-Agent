"""
Action: browser_control
Navigates URLs, opens tabs, and interacts with web browsers.
"""

import webbrowser
import subprocess
import sys
import urllib.parse
from typing import Dict, Any

TOOL = {
    "name": "browser_control",
    "description": "Controls the web browser: open a URL, open a new tab, or search Google.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": "open_url, new_tab, google_search",
                "enum": ["open_url", "new_tab", "google_search"]
            },
            "url": {
                "type": "STRING",
                "description": "Target website URL (e.g. 'https://github.com')"
            },
            "query": {
                "type": "STRING",
                "description": "Search query for google_search"
            }
        },
        "required": ["action"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    action = (parameters.get("action") or "open_url").lower()
    url = (parameters.get("url") or "").strip()
    query = (parameters.get("query") or "").strip()

    if action in ["google_search", "search"] or (query and not url):
        search_query = query or url
        search_url = f"https://www.google.com/search?q={urllib.parse.quote(search_query)}"
        try:
            webbrowser.open(search_url)
        except Exception:
            pass
        return f"Opened Google search for '{search_query}' in your default browser."

    if action == "new_tab":
        try:
            webbrowser.open_new_tab(url or "https://google.com")
        except Exception:
            pass
        return "Opened a new browser tab."

    if url:
        if not url.startswith("http://") and not url.startswith("https://"):
            url = f"https://{url}"
        try:
            webbrowser.open(url)
        except Exception:
            pass
        return f"Navigated browser to {url}."

    return "Please specify a URL or search query."
