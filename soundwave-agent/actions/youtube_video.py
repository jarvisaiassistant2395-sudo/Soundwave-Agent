"""
Action: youtube_video
Searches or opens YouTube videos in the browser.
"""

import urllib.parse
import webbrowser
from typing import Dict, Any

TOOL = {
    "name": "youtube_video",
    "description": "Searches or plays a video on YouTube in your browser.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "query": {
                "type": "STRING",
                "description": "Video topic, title, or search terms"
            }
        },
        "required": ["query"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    query = parameters.get("query", "").strip()
    if not query:
        return "Please specify a video topic or search query."

    url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(query)}"
    try:
        webbrowser.open(url)
        return f"Opened YouTube search for '{query}' in your browser."
    except Exception as e:
        return f"Failed to open YouTube: {e}"
