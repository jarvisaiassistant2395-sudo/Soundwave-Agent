"""
Action: weather_report
Live weather information for any city via wttr.in.
"""

import urllib.request
import urllib.parse
from typing import Dict, Any

TOOL = {
    "name": "weather_report",
    "description": "Gets live weather and temperature forecast for any city or location.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "city": {
                "type": "STRING",
                "description": "City or location name (e.g. Belgrade, London, New York)"
            }
        },
        "required": ["city"]
    }
}

def handler(parameters: Dict[str, Any], context: Any = None) -> str:
    city = parameters.get("city", "").strip()
    if not city:
        city = "London"

    try:
        url = f"https://wttr.in/{urllib.parse.quote(city)}?format=3"
        req = urllib.request.Request(url, headers={"User-Agent": "curl/7.68.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = resp.read().decode("utf-8").strip()
            return f"Weather forecast: {data}"
    except Exception as e:
        return f"Could not retrieve weather for {city}: {e}"
