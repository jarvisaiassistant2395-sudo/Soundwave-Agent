"""
Action: web_search
Performs web queries using DuckDuckGo HTML / instant search.
"""

import urllib.request
import urllib.parse
import json
import re
from typing import Dict, Any

TOOL = {
    "name": "web_search",
    "description": "Searches the web for up-to-date facts, news, prices, or answers.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "query": {
                "type": "STRING",
                "description": "Search query or question"
            }
        },
        "required": ["query"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    query = parameters.get("query", "").strip()
    if not query:
        return "Please provide a query to search."

    try:
        url = f"https://api.duckduckgo.com/?q={urllib.parse.quote(query)}&format=json&no_html=1&skip_disambig=1"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 SoundwaveAgent/2.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            abstract = data.get("AbstractText", "")
            if abstract:
                return f"Search result for '{query}':\n\n{abstract}"

            related = data.get("RelatedTopics", [])
            snippets = []
            for item in related[:3]:
                if isinstance(item, dict) and "Text" in item:
                    snippets.append(item["Text"])

            if snippets:
                return f"Top results for '{query}':\n\n" + "\n\n".join(snippets)

        return f"Searched for '{query}'. No direct instant answer found; check your browser."
    except Exception as e:
        return f"Web search could not connect: {e}"
